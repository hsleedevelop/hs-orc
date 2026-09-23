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
import type { Matrix } from '../data/matrix.ts';
import type { Engines } from '../data/engines.ts';
import { ClassifyError, assignmentById, classify } from './classify.ts';
import { evaluateGate, type GateCheck, type GateSignals } from './gatekeeper.ts';
import { assign, type AssignOptions, type AssignmentPlan } from './assign.ts';
import { classifyWithModel } from './classify-llm.ts';

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
  readonly outcome: 'matched' | 'none' | 'failed';
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
}

const TRY_LINE = '규칙 무매치 → Haiku·low 로 분류만 재시도 (+$0.001 내외 · --no-classify-llm 으로 끈다)';

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

  try {
    const guessed = await classifyWithModel(matrix, catalog, task, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    if (!guessed) return { result, fallback: { outcome: 'none', line: `${TRY_LINE} → 맞는 행 없음` } };
    return {
      result: route(matrix, catalog, task, { ...options, taskId: guessed.id, reasonLabel: 'Haiku·low 분류' }),
      fallback: { outcome: 'matched', line: `${TRY_LINE} → ${guessed.id}` },
    };
  } catch (error) {
    return {
      result,
      fallback: {
        outcome: 'failed',
        line: `${TRY_LINE} → 시도하지 못했다: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}
