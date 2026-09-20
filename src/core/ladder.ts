/**
 * 상향 사다리 (SPEC §2.4).
 *
 * 상향 순서: **① 코드·로그·재현 조건 보강 → ② effort 상향 → ③ 모델 상향 → ④ reviewer 추가.**
 * 이 순서를 건너뛰고 L5로 점프하는 경로를 만들지 않는다.
 */
import type { LadderStep, Matrix } from '../data/matrix.ts';

export const ESCALATION_ORDER = ['evidence', 'effort', 'model', 'reviewer'] as const;
export type EscalationStage = (typeof ESCALATION_ORDER)[number];

export const STAGE_LABEL: Readonly<Record<EscalationStage, string>> = {
  evidence: '코드·로그·재현 조건 보강',
  effort: 'effort 상향',
  model: '모델 상향',
  reviewer: 'reviewer 추가',
};

export class LadderError extends Error {
  override name = 'LadderError';
}

/** 이미 마친 단계들. 다음에 허용되는 단계는 정확히 하나다. */
export function nextStage(done: readonly EscalationStage[]): EscalationStage | null {
  return ESCALATION_ORDER.find((stage) => !done.includes(stage)) ?? null;
}

/** 순서를 건너뛰면 던진다 — "일단 Fable로 올려보자"가 이 함수를 통과하면 안 된다. */
export function requestStage(done: readonly EscalationStage[], requested: EscalationStage): EscalationStage[] {
  const expected = nextStage(done);
  if (expected === null) throw new LadderError('더 올릴 단계가 없다. 여기서도 안 되면 문제 정의를 다시 본다.');
  if (requested !== expected) {
    throw new LadderError(
      `상향 순서를 건너뛸 수 없다. 다음은 "${STAGE_LABEL[expected]}"(${expected})인데 "${requested}"를 요청했다.`,
    );
  }
  return [...done, requested];
}

export function ladderLevels(matrix: Matrix): readonly string[] {
  return matrix.ladder.map((s) => s.level);
}

/** 사다리 레벨 이동. 인접한 다음 칸으로만 간다 — L1→L5 직행 경로는 없다. */
export function climb(matrix: Matrix, from: string): LadderStep {
  const levels = matrix.ladder;
  const index = levels.findIndex((s) => s.level === from);
  if (index === -1) throw new LadderError(`그런 사다리 레벨이 없다: ${from} (${ladderLevels(matrix).join(' → ')})`);
  const next = levels[index + 1];
  if (!next) throw new LadderError(`${from} 이 최상단이다. 더 올라갈 칸이 없다.`);
  return next;
}

export function jumpTo(matrix: Matrix, from: string, to: string): LadderStep {
  const next = climb(matrix, from);
  if (next.level !== to) {
    throw new LadderError(`${from} → ${to} 직행 경로는 없다. 다음 칸은 ${next.level} 이다 (한 칸씩 올라간다).`);
  }
  return next;
}
