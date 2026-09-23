/**
 * 라우팅 파이프라인 (SPEC §4).
 *
 *   1. Classifier → 11행 중 1행 | "해당 없음"(사용자에게 올림, 임의 배정 금지)
 *   2. Gatekeeper → §1 하한선. 걸리면 **배정 없이 종료**한다
 *   3. Assigner   → 두 슬롯 + INV-1 + supports() + 비용
 *
 * **이 함수가 순서의 유일한 소유자다.** 2번이 1번과 3번 사이에 있는 것이 이 단계의 요점이고,
 * 3번(배정)에 도달하기 전에 어떤 엔진도 띄우지 않는다.
 */
import type { Matrix, ModelKey } from '../data/matrix.ts';
import type { Engines } from '../data/engines.ts';
import { ClassifyError, assignmentById, classify } from './classify.ts';
import { evaluateGate, type GateCheck, type GateSignals } from './gatekeeper.ts';
import { assign, type AssignOptions, type AssignmentPlan } from './assign.ts';
import { classifyWithModel } from './classify-llm.ts';
import type { Budget } from './budget.ts';

export type RouteResult =
  /** 11행 중 어디에도 안 붙는다. 기본 배정을 만들지 않고 사용자에게 올린다 (PLAN S3-5). */
  | { readonly stage: 'unclassified'; readonly message: string }
  /** 하한선에 걸렸다. 엔진을 띄우지 않는다. */
  | { readonly stage: 'direct'; readonly tripped: readonly GateCheck[]; readonly reasons: readonly string[] }
  | { readonly stage: 'assigned'; readonly reason: string; readonly plan: AssignmentPlan };

export interface PipelineOptions extends AssignOptions {
  readonly taskId?: string;
  readonly gate?: GateSignals;
  /** taskId 를 누가 정했는지. 비면 "수동 지정" 이다 — LLM 폴백이 정한 것을 수동이라 쓰면 근거가 거짓이 된다. */
  readonly reasonLabel?: string;
}

export function route(matrix: Matrix, catalog: Engines, task: string, options: PipelineOptions = {}): RouteResult {
  // 1. Classifier
  let reason: string;
  let assignment;
  try {
    if (options.taskId) {
      assignment = assignmentById(matrix, options.taskId);
      reason = `${options.reasonLabel ?? '수동 지정'} ${assignment.id}`;
    } else {
      const classified = classify(matrix, task);
      assignment = classified.assignment;
      reason = `키워드 ${classified.matched.join(', ')} (점수 ${classified.score})`;
    }
  } catch (error) {
    if (error instanceof ClassifyError) return { stage: 'unclassified', message: error.message };
    throw error;
  }

  // 2. Gatekeeper — 배정보다 먼저다.
  const verdict = evaluateGate(options.gate ?? {});
  if (verdict.kind === 'direct') {
    return { stage: 'direct', tripped: verdict.tripped, reasons: verdict.reasons };
  }

  // 3. Assigner
  return { stage: 'assigned', reason, plan: assign(matrix, catalog, assignment, options) };
}

/** 폴백이 돌았다는 사실. **셸이 반드시 사용자에게 보여준다** — 말없이 도는 유료 호출은 없다 (D-026). */
export interface FallbackNote {
  /** skipped = 예산이 이미 상한이라 시작조차 하지 않았다 (D-034). */
  readonly outcome: 'matched' | 'none' | 'failed' | 'skipped';
  /** 화면에 그대로 찍을 한 줄. 셸마다 다시 쓰지 않는다. */
  readonly line: string;
}

export interface RoutedWithFallback {
  readonly result: RouteResult;
  /** `null` 이면 폴백이 돌지 않았다 — 규칙으로 붙었거나 꺼져 있다. */
  readonly fallback: FallbackNote | null;
}

export interface FallbackOptions extends PipelineOptions {
  /** 기본 **켜짐** (D-026). 규칙 표가 평범한 작업 문장을 놓치기 때문이다(PLAN S9-2). */
  readonly classifyLlm?: boolean;
  /**
   * 분류기를 띄울 폴더 (D-029). 기본은 `process.cwd()` — CLI·TUI 는 그대로 두면 된다.
   * 폴더를 바꿀 수 있는 셸(GUI)만 넘긴다. Core 가 UI 를 아는 것이 아니라,
   * **숨어 있던 전역 의존을 인자로 드러낸 것**이다.
   */
  readonly cwd?: string;
  /**
   * 이 실행의 누적 예산 (D-034). 주면 — 폴백 비용을 여기에 과금하고, 이미 상한이면
   * 폴백을 **시작하지 않는다**. 안 주면(TUI·GUI 의 옛 호출부 등) 과금 없이 예전처럼 돈다.
   */
  readonly budget?: Budget;
}

/** 매트릭스 행의 슬롯 라벨에서 이 모델의 표시 라벨을 찾는다. 못 찾으면 모델 키를 그대로 쓴다. */
function modelLabel(matrix: Matrix, model: ModelKey): string {
  for (const a of matrix.assignments) {
    if (a.primary.model === model) return a.primary.label;
    if (a.reviewer.model === model) return a.reviewer.label;
  }
  return model.charAt(0).toUpperCase() + model.slice(1);
}

/** 이번 호출의 실제 비용과 출처. 없으면 지어내지 않고 "없다"고 말한다 (D-034). */
function costText(actualUsd: number | undefined, meteredUsd: number | undefined): string {
  if (actualUsd !== undefined) return `$${actualUsd.toFixed(4)} actual`;
  if (meteredUsd !== undefined) return `$${meteredUsd.toFixed(4)} metered`;
  return '비용 보고 없음';
}

const tryLine = (label: string, effort: 'low' | 'medium', cost: string): string =>
  `규칙 무매치 → ${label}·${effort} 로 분류만 재시도 (${cost} · --no-classify-llm 으로 끈다)`;

/**
 * `route` + LLM 분류 폴백 (D-026). **세 셸이 전부 이 함수를 쓴다** —
 * 폴백이 CLI 에만 있으면 같은 입력이 셸마다 다르게 동작한다(S9 에서 실제로 그랬다).
 *
 * 폴백 실패는 삼키지 않고 `outcome: 'failed'` 로 올린 뒤 미분류 결과를 그대로 돌려준다.
 */
export async function routeWithFallback(
  matrix: Matrix,
  catalog: Engines,
  task: string,
  options: FallbackOptions = {},
): Promise<RoutedWithFallback> {
  const result = route(matrix, catalog, task, options);
  if (result.stage !== 'unclassified' || options.classifyLlm === false) return { result, fallback: null };

  const { budget } = options;
  if (budget?.limitReached()) {
    return {
      result,
      fallback: { outcome: 'skipped', line: `규칙 무매치 → 누적 상한에 닿아 분류 폴백을 시작하지 않는다 (${budget.summary()})` },
    };
  }

  try {
    const outcome = await classifyWithModel(matrix, catalog, task, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });

    const label = modelLabel(matrix, outcome.model);
    if (budget) {
      // 실패했어도 쓴 것은 쓴 것이다 — 과금은 ok 여부와 무관하다 (D-034).
      const estimate = matrix.economics.find((e) => e.model === outcome.model)?.taskCostUsd ?? 0;
      const plan = catalog.engines[catalog.models[outcome.model].defaultEngine].plan;
      budget.charge(`분류·${label}·${outcome.effort}`, outcome.actualUsd, estimate, outcome.meteredUsd, plan);
      budget.countTokens(outcome.usage);
    }
    const line = tryLine(label, outcome.effort, costText(outcome.actualUsd, outcome.meteredUsd));

    if (!outcome.ok || outcome.assignment === null) {
      return { result, fallback: { outcome: 'none', line: `${line} → 맞는 행 없음` } };
    }
    return {
      result: route(matrix, catalog, task, {
        ...options,
        taskId: outcome.assignment.id,
        reasonLabel: `${label}·${outcome.effort} 분류`,
      }),
      fallback: { outcome: 'matched', line: `${line} → ${outcome.assignment.id}` },
    };
  } catch (error) {
    // 던진 지점(ClassifierModelError·어댑터 오류)은 **실행 전**이다 — 쓴 돈이 없으니 과금하지 않는다.
    const label = modelLabel(matrix, 'haiku');
    return {
      result,
      fallback: {
        outcome: 'failed',
        line: `${tryLine(label, 'low', '비용 보고 없음')} → 시도하지 못했다: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}
