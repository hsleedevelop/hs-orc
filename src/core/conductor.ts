/**
 * 지휘자 (SPEC §6.4.2·§6.4.4, D-031).
 *
 * **라우팅을 하지 않는다.** 배정은 결정론 코드(pipeline)가 한다 — G1 을 모델 판단에 넘기지 않는다.
 * 지휘자가 하는 일은 둘뿐이다: 하한선·미분류 메시지에 **직접 답**하고, 위임 결과를 **요약**한다.
 * 모델은 Haiku·low 고정이다 (Q11 — 분류 폴백과 같은 계층).
 */
import type { Engines } from '../data/engines.ts';
import type { Matrix } from '../data/matrix.ts';
import { resolveSlot, type ResolvedSlot } from './assign.ts';
import type { Delegated } from './delegate.ts';
import type { SettledOutcome } from './evidence.ts';
import type { Verdict } from './duo.ts';
import type { SlotExecutor, SlotRun } from './executor.ts';
import { STAGE_LABEL, nextStage } from './ladder.ts';

/**
 * role 을 `reviewer` 로 둔다 — `createExecutor` 가 **쓰기를 절대 주지 않는 자리**다.
 * 직접 답은 세션의 쓰기 스위치와 무관하게 읽기 전용이어야 하고(SPEC §6.4.2),
 * 그 강제를 호출자의 주의에 맡기지 않는다.
 */
export function conductorSlot(catalog: Engines): ResolvedSlot {
  return resolveSlot(
    catalog,
    { model: 'haiku', vendor: 'anthropic', efforts: ['low'], label: '지휘자·Haiku' },
    'low',
    'reviewer',
  );
}

/**
 * `unrouted` — Jev 가 답했는데 행을 확정하지 않은 턴(NONE·확신도 미만, D-065). 그 턴의 SUGGEST 는 세션이 어차피 버리므로
 * 행을 제안하라고 시키지 않고, 위임은 사람이 행을 골라야 한다고 안내하게 한다 (D-079). 마지막 줄 형식은 그대로 둔다.
 */
export function buildDirectPrompt(matrix: Matrix, context: string, message: string, options: { readonly unrouted?: boolean } = {}): string {
  const rows = matrix.assignments.map((a) => `${a.id}\t${a.task}`).join('\n');
  return [
    '너는 hs-orc 의 지휘자다. 사용자와 대화로 짧게 답한다.',
    '규칙:',
    '- 파일을 고치거나 명령을 실행하지 않는다.',
    options.unrouted
      ? '- 개발 작업을 대신 수행하거나 그 결과를 지어내지 않는다. 작업 요청이면 이 요청은 업무 행에 배정되지 않았다고 말하고, 위임하려면 사용자가 아래 업무 목록에서 행을 직접 골라야 한다고 안내한다 (GUI 의 "위임하기" · CLI 의 `/task Rxx`). 행을 대신 고르거나 추천하지 않는다.'
      : '- 개발 작업을 대신 수행하거나 그 결과를 지어내지 않는다. 작업 요청이면 무엇을 하게 될지 한두 문장으로 말하고, 아래 업무 목록에서 맞는 행을 제안한다.',
    '- 너는 이 답 하나만 쓴다. 분석·작업을 진행 중이라거나 곧 진행한다고 말하지 않는다 — 작업은 사람이 위임을 승인해야 시작된다.',
    options.unrouted ? '- 마지막 줄은 반드시 `SUGGEST: NONE` 이다.' : '- 마지막 줄은 반드시 `SUGGEST: <행 id>` 또는 `SUGGEST: NONE` 이다.',
    '',
    '[업무 목록]',
    rows,
    ...(context ? ['', '[최근 대화]', context] : []),
    '',
    '[이번 메시지]',
    message,
  ].join('\n');
}

const SUGGEST_LINE = /^SUGGEST:\s*(R\d{2}|NONE)\s*$/i;

/**
 * **마지막 줄만**, 그 줄 전체가 형식에 맞을 때만 읽는다 — reviewer 판정(`parseVerdict`, 끝 3줄의 단어)보다 엄격하다.
 * 본문 중간의 SUGGEST 는 제안이 아니다. 없는 행 id 는 버린다 — 행을 추측하지 않는다.
 */
export function parseSuggest(matrix: Matrix, text: string): { body: string; suggest: string | null } {
  const lines = text.trimEnd().split('\n');
  const match = SUGGEST_LINE.exec(lines.at(-1)?.trim() ?? '');
  if (!match) return { body: text.trim(), suggest: null };
  const id = (match[1] ?? 'NONE').toUpperCase();
  const known = matrix.assignments.some((a) => a.id === id);
  return { body: lines.slice(0, -1).join('\n').trim(), suggest: id !== 'NONE' && known ? id : null };
}

export interface DirectAnswer {
  readonly run: SlotRun;
  readonly body: string;
  readonly suggest: string | null;
}

export async function directAnswer(
  conduct: SlotExecutor,
  slot: ResolvedSlot,
  matrix: Matrix,
  context: string,
  message: string,
  options: { readonly unrouted?: boolean } = {},
): Promise<DirectAnswer> {
  const run = await conduct(slot, buildDirectPrompt(matrix, context, message, options));
  return { run, ...parseSuggest(matrix, run.text) };
}

export function buildSummaryPrompt(title: string, d: Pick<Delegated, 'text' | 'verdict' | 'outcome' | 'report'>): string {
  return [
    '아래 위임 결과를 사용자에게 3줄 이내로 요약하라.',
    '새 사실을 지어내지 않는다. reviewer 판정과 증거 상태를 그대로 전한다.',
    '',
    `[요청] ${title}`,
    `[reviewer 판정] ${d.verdict}`,
    `[증거] ${d.report.summary}`,
    `[outcome] ${d.outcome}`,
    '[primary 출력 앞부분]',
    d.text.slice(0, 3000),
  ].join('\n');
}

/**
 * 다음 제안은 **코드가 계산한다** (SPEC §6.4.4) — 상향 판단을 모델에 넘기지 않는다 (G1).
 * `offer` — 세션이 기록으로 계산한 다음 단계 (D-068). 없으면(undefined) 사다리의 첫 단계, null 이면 더 올릴 곳이 없다.
 */
export function nextSuggestion(outcome: SettledOutcome | 'cancelled', verdict: Verdict, offer?: { readonly label: string } | null): string {
  // 사용자가 멈춘 위임은 실패 신호가 아니다 — 상향을 권하지 않는다 (D-066).
  if (outcome === 'cancelled') return '';
  if (outcome === 'ok' && verdict !== 'fail') return '';
  if (offer === null) return '사다리를 더 올릴 곳이 없다 — 문제 정의를 다시 본다 (SPEC §2.4)';
  const first = nextStage([]);
  const label = offer?.label ?? (first ? STAGE_LABEL[first] : null);
  return label ? `사다리 다음 단계: ${label} — 다시 위임하면 그 단계를 올린 배정 카드가 선다 (승인은 카드에서)` : '';
}
