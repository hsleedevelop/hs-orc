/**
 * `/loop` — loop-engineering (SPEC §6.2, D-016 자체 구현).
 *
 * 구성요소를 **분리한다**: Goal / Planner / Executor / Evaluator / Critic / Recovery / Stop.
 * - Evaluator 에는 **reviewer 슬롯 모델**을 쓴다. 같은 모델이면 자기 채점이다 (D-003).
 * - 한 사이클에 작은 작업 하나. **검증 없이 다음 사이클로 넘어가지 않는다.**
 * - 최대 반복 수와 누적 비용 상한이 **둘 다** 있어야 돈다.
 */
import type { Matrix } from '../../data/matrix.ts';
import { Budget, BudgetExceeded, TokenBudgetExceeded } from '../budget.ts';
import { Journal } from '../journal.ts';
import { estimateUsd, type SlotExecutor, type SlotRun } from '../executor.ts';
import type { AssignmentPlan } from '../assign.ts';

export interface LoopContext {
  readonly iteration: number;
  readonly goal: string;
  readonly history: readonly string[];
  /** 직전 사이클이 검증에서 떨어졌을 때 그 사유 (D-036). Planner 가 다음 작업에 싣는다. */
  readonly feedback?: string;
}

export interface Verdict {
  readonly passed: boolean;
  /** 어떻게 판정했는가. 비면 검증하지 않은 것이다. */
  readonly verification: string;
  /** 통과하지 못한 이유. retry 면 다음 사이클의 `LoopContext.feedback` 이 된다 (D-036). */
  readonly reason?: string;
  /**
   * 판정에 쓴 reviewer 실행의 비용·토큰 (D-036). 주면 Executor 와 같은 우선순위로 과금하고 토큰을 센다.
   * 없으면 추정 금액만 적는다 — 토큰 상한이 reviewer 몫을 세지 못한다.
   */
  readonly cost?: Pick<SlotRun, 'actualUsd' | 'meteredUsd' | 'usage'>;
}

export interface LoopComponents {
  /** 다음으로 처리할 **가장 작은 유효 작업**. null 이면 더 할 일이 없다. */
  plan(ctx: LoopContext): Promise<string | null> | string | null;
  /** 성공 여부를 기계적으로 판정한다. reviewer 슬롯이 돈다. */
  evaluate(ctx: LoopContext, output: string): Promise<Verdict> | Verdict;
  /** 누락된 근거·리스크. 판정을 바꾸지 않고 기록만 한다. */
  critique?(ctx: LoopContext, output: string): Promise<string> | string;
  /** 실패 시: 재시도 / 중단 / 사람에게 올림. */
  recover?(ctx: LoopContext, verdict: Verdict): Promise<Recovery> | Recovery;
  /** 완료 조건. true 면 정상 종료. */
  stop?(ctx: LoopContext, verdict: Verdict): Promise<boolean> | boolean;
}

export type Recovery = 'retry' | 'abort' | 'escalate';

export type LoopStopReason =
  | 'goal-reached'
  | 'no-work-left'
  | 'max-iterations'
  | 'budget-exceeded'
  | 'aborted'
  | 'escalated';

export interface LoopResult {
  readonly stopReason: LoopStopReason;
  readonly iterations: number;
  readonly journal: Journal;
  readonly budget: Budget;
}

export interface LoopOptions {
  readonly goal: string;
  readonly maxIterations: number;
  readonly budgetUsd: number;
  /** 생략하면 토큰 상한을 걸지 않는다 (D-030). 구독제에서는 이쪽만 실제로 막는다. */
  readonly tokenBudget?: number;
  /** 주면 그대로 쓴다 — CLI 가 분류 폴백에 이미 과금한 같은 예산을 넘겨 합산한다 (D-034). */
  readonly budget?: Budget;
}

export async function runLoop(
  matrix: Matrix,
  plan: AssignmentPlan,
  execute: SlotExecutor,
  components: LoopComponents,
  options: LoopOptions,
): Promise<LoopResult> {
  if (!Number.isInteger(options.maxIterations) || options.maxIterations < 1) {
    throw new Error('최대 반복 수 없이는 루프를 돌리지 않는다 (SPEC §6.2).');
  }

  const journal = new Journal();
  const budget = options.budget ?? new Budget(options.budgetUsd, options.tokenBudget ?? 0);
  const history: string[] = [];
  let feedback: string | undefined;
  let iteration = 0;
  let stopReason: LoopStopReason = 'max-iterations';

  while (iteration < options.maxIterations) {
    const ctx: LoopContext = {
      iteration: iteration + 1,
      goal: options.goal,
      history: [...history],
      ...(feedback !== undefined ? { feedback } : {}),
    };

    try {
      budget.assertCanContinue();
    } catch (error) {
      if (error instanceof BudgetExceeded || error instanceof TokenBudgetExceeded) {
        stopReason = 'budget-exceeded';
        break;
      }
      throw error;
    }

    const task = await components.plan(ctx);
    if (task === null) {
      stopReason = 'no-work-left';
      break;
    }
    iteration += 1;

    // Executor — primary 슬롯
    const run = await execute(plan.slots.primary, task);
    const execCharge = budget.charge(
      `#${iteration} Executor ${plan.slots.primary.label}`,
      run.actualUsd,
      estimateUsd(matrix, plan.slots.primary),
      run.meteredUsd,
      plan.slots.primary.plan,
    );
    budget.countTokens(run.usage);

    // Evaluator — reviewer 슬롯. 같은 모델이면 자기 채점이 된다 (D-003).
    const verdict = await components.evaluate(ctx, run.text);
    budget.charge(
      `#${iteration} Evaluator ${plan.slots.reviewer.label}`,
      verdict.cost?.actualUsd,
      estimateUsd(matrix, plan.slots.reviewer),
      verdict.cost?.meteredUsd,
      plan.slots.reviewer.plan,
    );
    // cost 가 없으면 reviewer 토큰을 못 본 것이다 — 0 으로 치지 않고 미보고로 센다 (D-030).
    budget.countTokens(verdict.cost?.usage);

    const critique = components.critique ? await components.critique(ctx, run.text) : '';
    // 재시도 작업에는 직전 지적이 여러 줄로 붙는다 — 기록에는 첫 줄만 남긴다 (D-036 리뷰).
    const summary = task.split('\n', 1)[0] ?? task;
    history.push(`#${iteration} ${summary} → ${verdict.passed ? 'pass' : 'fail'}`);

    journal.append({
      index: iteration,
      unit: '반복',
      model: plan.slots.primary.label,
      effort: plan.slots.primary.effort,
      outcome: verdict.passed ? 'ok' : 'failed',
      evidence: critique ? `${summary} / critic: ${critique}` : summary,
      change: run.text.slice(0, 200),
      verification: verdict.verification,
      charge: execCharge,
    });

    if (!verdict.passed) {
      const recovery = components.recover ? await components.recover(ctx, verdict) : 'abort';
      if (recovery === 'abort') {
        stopReason = 'aborted';
        break;
      }
      if (recovery === 'escalate') {
        stopReason = 'escalated';
        break;
      }
      feedback = verdict.reason;
      continue; // retry — 다음 사이클에서 Planner 가 이 사유를 보고 다시 고른다.
    }

    if (components.stop ? await components.stop(ctx, verdict) : false) {
      stopReason = 'goal-reached';
      break;
    }
  }

  return { stopReason, iterations: iteration, journal, budget };
}
