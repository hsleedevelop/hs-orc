/**
 * 배정 → 결정 로그 레코드 (SPEC §8).
 *
 * **남기는 경우는 배정이 확정됐을 때뿐이다.** 하한선에 걸려 "직접"으로 간 기본 경로는
 * 남기지 않는다 — 대다수이고 분석 가치가 없다(라우터 §7).
 *
 * `downshifted`/`branch` 는 추측하지 않고 **AA 측정치로** 판정한다(SPEC §2.3).
 * 매트릭스 모델은 벤더가 갈려 계층 이름만으로는 비교할 수 없기 때문이다.
 */
import os from 'node:os';
import type { Matrix, ModelKey } from '../data/matrix.ts';
import type { AssignmentPlan } from './assign.ts';
import type { RouteResult } from './pipeline.ts';
import { newDecisionId, type Branch, type DecisionRecord, type Outcome } from './decision-log.ts';

/** 오케스트레이터를 모는 세션 모델. 다운시프트 폭의 기준점이다. */
export function sessionModel(env: NodeJS.ProcessEnv = process.env): ModelKey {
  return (env['HS_ORC_SESSION_MODEL'] as ModelKey | undefined) ?? 'fable';
}

const aaOf = (matrix: Matrix, model: ModelKey): number =>
  matrix.economics.find((e) => e.model === model)?.aa ?? 0;

export function branchOf(matrix: Matrix, primary: ModelKey, session: ModelKey): Branch {
  const delta = aaOf(matrix, primary) - aaOf(matrix, session);
  if (delta < 0) return 'down';
  if (delta > 0) return 'up_part';
  return 'keep';
}

/** 배정이 확정된 결정만 기록 대상이다. 그 외에는 `null` 이다. */
export function decisionFor(result: RouteResult): AssignmentPlan | null {
  return result.stage === 'assigned' ? result.plan : null;
}

export function firstLine(
  matrix: Matrix,
  plan: AssignmentPlan,
  task: string,
  reason: string,
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): DecisionRecord {
  const session = sessionModel(env);
  const primary = plan.slots.primary.model;
  const branch = branchOf(matrix, primary, session);
  return {
    ts: now.toISOString(),
    host: os.hostname(),
    task: task.slice(0, 40),
    id: newDecisionId(now),
    mechanism: 'subagent',
    branch,
    session_model: session,
    tier: `${primary}/${plan.slots.primary.effort}`,
    downshifted: branch === 'down',
    trigger: `매트릭스 ${plan.assignment.id} · ${reason}`,
    // primary + reviewer 두 슬롯이다 (D-009). 단일 엔진 선택기가 아님을 로그에도 남긴다.
    parallel_n: 2,
    status: 'decided',
    outcome: 'pending',
    note: `hs-orchestrator · reviewer ${plan.slots.reviewer.model}/${plan.slots.reviewer.effort} · 예상 $${plan.cost.totalUsd}(추정)`,
  };
}

/** 2차 — **같은 `id`** 로 append 한다. 갱신이 아니다. */
export function secondLine(
  first: DecisionRecord,
  outcome: Outcome,
  verified: string,
  now = new Date(),
): DecisionRecord {
  return {
    ...first,
    ts: now.toISOString(),
    status: 'ran',
    outcome,
    // 비어 있으면 "검증 안 함"이다 — outcome 을 unverified 로 떨어뜨린다.
    verified: verified.trim() || '(검증 기록 없음)',
  };
}
