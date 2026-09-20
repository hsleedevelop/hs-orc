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
