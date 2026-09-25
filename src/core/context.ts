/**
 * 맥락 자르기 (SPEC §6.4.3).
 * rolling 요약은 두지 않는다 — 최근 N턴 자르기로 시작하고, 부족하다는 실측이 나오면 연다.
 * 엔진 원시 출력(`result` 본문)은 싣지 않는다. 요약이 그 자리를 대신한다.
 * 무엇을 잘랐는지 돌려준다 — rolling 요약을 열 근거는 이 기록이다 (D-053).
 */
import type { TranscriptRecord } from './transcript.ts';

export interface ContextLimits {
  readonly contextTurns: number;
  readonly contextChars: number;
}

function line(r: TranscriptRecord): string | null {
  switch (r.kind) {
    case 'user':
      return `사용자: ${r.text}`;
    case 'direct':
      return `orc: ${r.text}`;
    case 'summary':
      return r.text ? `orc(위임 결과 요약): ${r.text}${r.next ? ` · 다음 제안: ${r.next}` : ''}` : null;
    default:
      return null;
  }
}

/** 자르기로 버린 양. resume 으로 엔진이 이미 가진 턴(`after` 이전)은 버린 것이 아니다. */
export interface ContextCut {
  readonly turns: number;
  readonly chars: number;
}

export function buildContext(
  records: readonly TranscriptRecord[],
  limits: ContextLimits,
  range: { readonly before: number; readonly after?: number },
): { readonly text: string; readonly cut: ContextCut | null } {
  const after = range.after ?? 0;
  const picked = records.filter((r) => r.turn < range.before && r.turn > after && line(r) !== null);
  const all = [...new Set(picked.map((r) => r.turn))];
  const turns = new Set(all.slice(-limits.contextTurns));
  const joined = picked
    .filter((r) => turns.has(r.turn))
    .map(line)
    .join('\n');
  const kept = limits.contextChars - 1; // 앞의 '…' 한 자
  const over = joined.length > limits.contextChars;
  const text = over ? `…${joined.slice(-kept)}` : joined;
  const cut = { turns: all.length - turns.size, chars: over ? joined.length - kept : 0 };
  return { text, cut: cut.turns || cut.chars ? cut : null };
}
