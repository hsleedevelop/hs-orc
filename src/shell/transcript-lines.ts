/**
 * 기록 한 건에 붙는 알림 줄 — 맥락 컷(D-053)·엔진 압축(D-058). chat 과 GUI 렌더러가 같은 문구를 쓴다.
 * 렌더러 번들·type-check(DOM, node 타입 없음)에도 들어가므로 아무것도 import 하지 않는다 —
 * `ContextCut`·`EngineCompaction` 을 타입으로만 끌어와도 Node 에 기대는 모듈이 딸려 온다. 모양만 받는다.
 */
interface Cut { readonly turns: number; readonly chars: number }
interface Compaction { readonly trigger: string; readonly preTokens?: number; readonly postTokens?: number }

interface Ladder { readonly label: string; readonly from: string; readonly changes: readonly string[] }

/** 사다리 상향 카드 (D-068) — 무엇이 올라갔나. chat 과 GUI 가 같은 문구를 쓴다. */
export const ladderLines = (ladder: Ladder | undefined): string[] =>
  ladder ? [`사다리 ${ladder.label} — 결정 ${ladder.from} 의 같은 요청을 상향한다`, ...ladder.changes] : [];

/** 예외 재시도 카드 (D-081) — 같은 배정을 다시 세웠다는 것과 한 번뿐이라는 것. chat 과 GUI 가 같은 문구를 쓴다. */
export const retryLines = (retry: boolean | undefined): string[] =>
  retry ? ['재시도 — 승인한 같은 배정이 예외로 끝나 같은 계획으로 다시 세운 카드다 (한 번뿐 — 또 예외면 다시 세우지 않는다)'] : [];

export const cutLine = (cut: Cut | undefined): string[] => (cut ? [`맥락   앞 대화 ${cut.turns}턴·${cut.chars}자를 싣지 못했다`] : []);

export const compactLines = (compacted: readonly Compaction[] | undefined): string[] =>
  (compacted ?? []).map((c) => `압축   엔진이 앞 맥락을 요약으로 바꿨다 (${c.trigger}${c.preTokens !== undefined && c.postTokens !== undefined ? ` ${c.preTokens}→${c.postTokens} 토큰` : ''})`);

interface Status { readonly state: 'working' | 'blocked' | 'done' | 'interrupted' | 'idle' | 'ended'; readonly outcome?: string; readonly holder?: { readonly pid: number; readonly by: string } }

/** 세션 상태 한 마디 (D-085 · 종료 D-089). chat·`hs-orc session`·GUI 사이드바가 같은 말을 쓴다. */
export function statusLabel(status: Status | undefined): string {
  switch (status?.state) {
    case 'working': return '진행 중';
    case 'blocked': return '승인 대기';
    case 'done': return status.outcome ? `완료 · ${status.outcome}` : '완료';
    case 'interrupted': return '끊김';
    case 'idle': return 'idle';
    case 'ended': return '종료';
    case undefined: return '?';
  }
}

/** 세션 역할 한 마디 (D-090). chat·`hs-orc session`·GUI 가 같은 말을 쓴다. 모르는 값·없음은 워커다(옛 세션). */
export const roleLabel = (role: string | undefined): string => (role === 'orchestrator' ? '오케스트레이터' : '워커');

/**
 * 설정 줄 — 이름(D-085) · 승인 방식 · 지휘자(D-087) · 역할(D-090) · 비용(D-054). Core `SETTING_KINDS`(transcript.ts)와 **같은 목록**이다.
 * 이 파일은 렌더러 번들이라 import 하지 못해 따로 적는다 — 둘이 같은지는 `transcript-lines.test.ts` 가 본다.
 */
export const SETTING_KINDS: ReadonlySet<string> = new Set(['name', 'mode', 'orchestrator', 'role', 'spend']);

/**
 * 대화 흐름의 마지막 기록 — 설정 줄(`SETTING_KINDS`)은 건너뛴다. 화면이 "지금 살아 있는 카드·제안" 을 이것으로 가린다:
 * 승인 대기 중 이름을 붙이거나 지휘자·역할을 바꿨다고 카드 버튼이 사라지면 안 된다. Core `ConversationSession.lastEvent` 와 같은 규칙이다.
 */
export const lastEvent = <T extends { readonly kind: string }>(records: readonly T[]): T | undefined =>
  records.findLast((r) => !SETTING_KINDS.has(r.kind));
