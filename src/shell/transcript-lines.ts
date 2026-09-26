/**
 * 기록 한 건에 붙는 알림 줄 — 맥락 컷(D-053)·엔진 압축(D-058). chat 과 GUI 렌더러가 같은 문구를 쓴다.
 * 렌더러 번들·type-check(DOM, node 타입 없음)에도 들어가므로 아무것도 import 하지 않는다 —
 * `ContextCut`·`EngineCompaction` 을 타입으로만 끌어와도 Node 에 기대는 모듈이 딸려 온다. 모양만 받는다.
 */
interface Cut { readonly turns: number; readonly chars: number }
interface Compaction { readonly trigger: string; readonly preTokens?: number; readonly postTokens?: number }

export const cutLine = (cut: Cut | undefined): string[] => (cut ? [`맥락   앞 대화 ${cut.turns}턴·${cut.chars}자를 싣지 못했다`] : []);

export const compactLines = (compacted: readonly Compaction[] | undefined): string[] =>
  (compacted ?? []).map((c) => `압축   엔진이 앞 맥락을 요약으로 바꿨다 (${c.trigger}${c.preTokens !== undefined && c.postTokens !== undefined ? ` ${c.preTokens}→${c.postTokens} 토큰` : ''})`);
