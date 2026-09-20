/**
 * `/pingpong` — 대화형 (SPEC §6.1, D-015).
 *
 * **자율 실행이 아니다.** 한 턴을 돌리고 결과와 다음 제안을 돌려준 뒤 멈춘다.
 * 다음 턴을 시작하는 것은 이 모듈이 아니라 사용자다 — 그래서 **턴 상한이 없다.**
 * 상한의 자리를 사용자 승인이 대신하고, 누적 비용만 공유 상한으로 남는다.
 */
import type { Matrix } from '../../data/matrix.ts';
import { Budget } from '../budget.ts';
import { Journal, type CycleRecord } from '../journal.ts';
import { estimateUsd, type SlotExecutor } from '../executor.ts';
import type { AssignmentPlan } from '../assign.ts';

export type Side = 'primary' | 'reviewer';

export interface TurnInput {
  readonly prompt: string;
  /** 어느 슬롯에 붙일지. 사용자가 턴마다 고른다 — 자동으로 교대하지 않는다 (D-015). */
  readonly side: Side;
  readonly evidence?: string;
  readonly verification?: string;
}

export interface TurnResult {
  readonly record: CycleRecord;
  readonly text: string;
  readonly budget: string;
  /** 다음 제안. 사용자가 받아들일지 말지 정한다. */
  readonly suggestion: string;
}

export class PingpongSession {
  readonly journal = new Journal();
  readonly budget: Budget;
  private readonly matrix: Matrix;
  private readonly plan: AssignmentPlan;
  private readonly execute: SlotExecutor;
  private turns = 0;

  constructor(matrix: Matrix, plan: AssignmentPlan, execute: SlotExecutor, budgetUsd: number) {
    this.matrix = matrix;
    this.plan = plan;
    this.execute = execute;
    this.budget = new Budget(budgetUsd);
  }

  get turnCount(): number {
    return this.turns;
  }

  async turn(input: TurnInput): Promise<TurnResult> {
    // 사전 점검이다 — 쓴 돈은 못 되돌린다.
    this.budget.assertCanContinue();

    const slot = this.plan.slots[input.side];
    const other: Side = input.side === 'primary' ? 'reviewer' : 'primary';
    this.turns += 1;

    const run = await this.execute(slot, input.prompt);
    const charge = this.budget.charge(`${slot.label}·${slot.effort}`, run.actualUsd, estimateUsd(this.matrix, slot));

    const record = this.journal.append({
      index: this.turns,
      unit: '턴',
      model: slot.label,
      effort: slot.effort,
      outcome: run.ok ? 'ok' : 'failed',
      evidence: input.evidence ?? '',
      change: run.text.slice(0, 200),
      // 사용자가 검증을 적지 않았으면 비워 둔다. 빈 값은 "검증 안 함"이지 "통과"가 아니다.
      verification: input.verification ?? '',
      charge,
    });

    const suggestion = this.budget.exceeded()
      ? `누적 비용 상한 도달(${this.budget.summary()}). 다음 턴을 시작하지 않는다 — 계속하려면 상한을 올려야 한다.`
      : `다음 턴 후보: ${this.plan.slots[other].label}·${this.plan.slots[other].effort} 로 ${
          input.side === 'primary' ? '독립 검증' : '반영'
        }. 방향 수정·배정 변경·중단 모두 가능하다.`;

    return { record, text: run.text, budget: this.budget.summary(), suggestion };
  }
}
