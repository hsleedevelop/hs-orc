/**
 * `hs-orc chat` — 줄 입력 대화 세션 (D-056). 판단은 전부 `ConversationSession`(Core)에 있고
 * 여기는 기록을 터미널 줄로 그리고 입력을 세션 호출로 옮긴다.
 */
import type { ContextCut } from '../core/context.ts';
import type { TranscriptRecord } from '../core/transcript.ts';

const cutLine = (cut: ContextCut | undefined): string[] => (cut ? [`맥락   앞 대화 ${cut.turns}턴·${cut.chars}자를 싣지 못했다`] : []);

export function renderRecord(r: TranscriptRecord): string[] {
  switch (r.kind) {
    case 'user':
      return [`나     ${r.text}`];
    case 'direct':
      return [
        ...r.notes.map((n) => `분류   ${n}`),
        r.text,
        `비용   ${r.cost}`,
        ...(r.suggest ? [`제안   ${r.suggest} — /task ${r.suggest} 로 위임한다`] : []),
        ...cutLine(r.cut),
      ];
    case 'plan':
      return [
        ...r.notes.map((n) => `분류   ${n}`),
        `업무   ${r.taskId} ${r.title}  (${r.reason})`,
        `배정   primary  ${r.primary}`,
        `       reviewer ${r.reviewer}`,
        `비용   $${r.estimateUsd} (추정)`,
      ];
    case 'approval':
      return [r.approved ? `승인   ${r.write ? '쓰기 켬 — primary 가 파일을 고칠 수 있다' : '읽기 전용'}` : '거절'];
    case 'result':
      return [
        `결과   ${r.outcome} · reviewer ${r.verdict.toUpperCase()} · 결정 ${r.decisionId}`,
        `증거   ${r.evidence}`,
        r.text,
        ...(r.review ? [`검증   ${r.review.slice(0, 600)}`] : []),
        ...cutLine(r.cut),
      ];
    case 'summary':
      return [...(r.text ? [r.text] : []), `다음   ${r.next}`];
    case 'error':
      return [`오류   ${r.text}`];
    case 'spend':
      // Budget 을 되살리는 재료다 (D-054) — 화면에 찍지 않는다.
      return [];
  }
}
