/**
 * S1~S2 파이프라인: 작업 문자열 → 분류 → **primary 슬롯만** 배정 → 실행 요청.
 * reviewer·Gatekeeper·비용·증거 수집은 S3 이후다 (PLAN).
 * Core 는 UI 도 CLI 플래그도 모른다 — argv 는 어댑터 안에서만 존재한다.
 */
import type { Assignment, Effort, Matrix } from '../data/matrix.ts';
import type { EngineName, Engines } from '../data/engines.ts';
import { buildInvocation } from '../adapters/resolve.ts';
import type { RunRequest } from '../adapters/types.ts';
import { assignmentById, classify } from './classify.ts';

export interface Plan {
  readonly assignment: Assignment;
  readonly reason: string;
  readonly engine: EngineName;
  /** 그 엔진이 실제로 받는 모델 id. 플래그가 아니라 식별자라 관찰가능성을 위해 노출한다. */
  readonly modelId: string;
  readonly effort: Effort;
}

export interface RouteOptions {
  readonly taskId?: string;
  readonly engine?: EngineName;
  /** 매트릭스가 범위(`xHigh/Max`)를 주면 기본은 낮은 쪽이다. 상향은 S3의 사다리가 정한다. */
  readonly effort?: string;
}

export function planPrimary(matrix: Matrix, catalog: Engines, task: string, options: RouteOptions = {}): Plan {
  let assignment: Assignment;
  let reason: string;

  if (options.taskId) {
    assignment = assignmentById(matrix, options.taskId);
    reason = `수동 지정 ${assignment.id}`;
  } else {
    const classified = classify(matrix, task);
    assignment = classified.assignment;
    reason = `키워드 ${classified.matched.join(', ')} (점수 ${classified.score})`;
  }

  const effort = options.effort ?? assignment.primary.efforts[0];
  if (effort === undefined) throw new Error(`${assignment.id} 의 primary effort 가 비어 있다 — matrix.json 이 깨졌다.`);

  const invocation = buildInvocation(catalog, assignment.primary.model, effort, task, options.engine);
  return {
    assignment,
    reason,
    engine: invocation.engine,
    modelId: invocation.modelId,
    effort: invocation.effort,
  };
}

export function toRunRequest(plan: Plan, task: string, cwd: string, timeoutMs: number): RunRequest {
  return { model: plan.assignment.primary.model, effort: plan.effort, prompt: task, cwd, timeoutMs };
}
