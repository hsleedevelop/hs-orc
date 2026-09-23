/**
 * 맥락 자르기 (SPEC §6.4.3).
 * rolling 요약은 두지 않는다 — 최근 N턴 자르기로 시작하고, 부족하다는 실측이 나오면 연다.
 * 엔진 원시 출력(`result` 본문)은 싣지 않는다. 요약이 그 자리를 대신한다.
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

export function buildContext(
  records: readonly TranscriptRecord[],
  limits: ContextLimits,
  range: { readonly before: number; readonly after?: number },
): string {
  const after = range.after ?? 0;
  const picked = records.filter((r) => r.turn < range.before && r.turn > after && line(r) !== null);
  const turns = new Set([...new Set(picked.map((r) => r.turn))].slice(-limits.contextTurns));
  const text = picked
    .filter((r) => turns.has(r.turn))
    .map(line)
    .join('\n');
  return text.length <= limits.contextChars ? text : `…${text.slice(-(limits.contextChars - 1))}`;
}

/** 분류 폴백 hint (SPEC §6.4.2). 규칙 분류기에는 섞지 않는다 — G1. */
export function lastSummary(records: readonly TranscriptRecord[]): string | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i];
    if (r?.kind === 'summary' && r.text) return r.text.split('\n')[0] ?? null;
  }
  return null;
}
