/**
 * 맥락 자르기 (SPEC §6.4.3).
 * rolling 요약은 두지 않는다 — 최근 N턴 자르기로 시작하고, 부족하다는 실측이 나오면 연다.
 * 엔진 원시 출력(`result` 본문)은 싣지 않는다. 요약이 그 자리를 대신한다. 취소된 위임만 한 줄로 싣는다(D-066).
 * 무엇을 잘랐는지 돌려준다 — rolling 요약을 열 근거는 이 기록이다 (D-053).
 */
import type { TranscriptRecord } from './transcript.ts';

export interface ContextLimits {
  readonly contextTurns: number;
  readonly contextChars: number;
}

/** 읽기 답(D-083)을 맥락에 싣는 글자 수 — 위임 요약에 primary 출력을 싣는 양(3,000자)의 절반이다. */
const READ_CHARS = 1500;

/** 취소된 위임 한 줄 (D-066). 행은 같은 턴의 배정에서, 단계는 결과 evidence("취소됨 — primary|reviewer 실행 중")에서 읽는다 — 없으면 뺀다. */
function cancelledLine(r: Extract<TranscriptRecord, { kind: 'result' }>, records: readonly TranscriptRecord[]): string {
  const plan = records.find((p) => p.turn === r.turn && p.kind === 'plan');
  const row = plan?.kind === 'plan' ? plan.taskId : null;
  const stage = /^취소됨 — (primary|reviewer)/.exec(r.evidence)?.[1] ?? null;
  const where = [row && `행 ${row}`, stage && `${stage} 실행 중`].filter(Boolean).join(' · ');
  return `orc(위임 취소): 사용자가 앞 위임을 취소했다${where ? `(${where})` : ''} — 결과·요약은 없다`;
}

function line(r: TranscriptRecord, records: readonly TranscriptRecord[]): string | null {
  switch (r.kind) {
    case 'user':
      return `사용자: ${r.text}`;
    case 'direct':
      // 읽기 답(D-083)은 엔진 출력이라 길다 — 통째로 실으면 글자 상한이 그 앞의 질문을 밀어낸다. 앞부분만 싣는다.
      return r.read ? `orc(코드를 읽고 답함): ${r.text.length > READ_CHARS ? `${r.text.slice(0, READ_CHARS)}…` : r.text}` : `orc: ${r.text}`;
    case 'summary':
      return r.text ? `orc(위임 결과 요약): ${r.text}${r.next ? ` · 다음 제안: ${r.next}` : ''}` : null;
    case 'result':
      return r.outcome === 'cancelled' ? cancelledLine(r, records) : null;
    case 'scaffold-run':
      // 다음 위임이 폴더가 어떻게 생겼는지 알게 한다 (D-088) — 출력 본문은 싣지 않는다.
      return `orc(${r.step === 'scaffold' ? '스캐폴딩' : 'git init'} 실행): ${r.commands.map((c) => c.join(' ')).join(' && ')} → ${r.outcome}${r.exitCode !== null ? ` (exit ${r.exitCode})` : ''}${r.created ? ` · 폴더: ${r.created.join(', ')}` : ''}`;
    case 'run-launch':
      // 다음 턴이 앱을 띄웠는지 알게 한다 (D-091) — 창을 열었을 뿐 서버가 떴는지는 hs-orc 가 모른다.
      return `orc(앱 실행): ${r.argv.join(' ')} → ${r.outcome === 'opened' ? `${r.terminal ?? '터미널'} 창에서 열었다 (서버 상태는 그 창에 있다)` : `${r.outcome}${r.detail ? ` — ${r.detail}` : ''}`}`;
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
  const picked = records.filter((r) => r.turn < range.before && r.turn > after && line(r, records) !== null);
  const all = [...new Set(picked.map((r) => r.turn))];
  const turns = new Set(all.slice(-limits.contextTurns));
  const joined = picked
    .filter((r) => turns.has(r.turn))
    .map((r) => line(r, records))
    .join('\n');
  const kept = limits.contextChars - 1; // 앞의 '…' 한 자
  const over = joined.length > limits.contextChars;
  const text = over ? `…${joined.slice(-kept)}` : joined;
  const cut = { turns: all.length - turns.size, chars: over ? joined.length - kept : 0 };
  return { text, cut: cut.turns || cut.chars ? cut : null };
}
