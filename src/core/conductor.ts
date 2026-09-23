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

export function buildDirectPrompt(matrix: Matrix, context: string, message: string): string {
  const rows = matrix.assignments.map((a) => `${a.id}\t${a.task}`).join('\n');
  return [
    '너는 hs-orc 의 지휘자다. 사용자와 대화로 짧게 답한다.',
    '규칙:',
    '- 파일을 고치거나 명령을 실행하지 않는다.',
    '- 개발 작업을 대신 수행하거나 그 결과를 지어내지 않는다. 작업 요청이면 무엇을 하게 될지 한두 문장으로 말하고, 아래 업무 목록에서 맞는 행을 제안한다.',
    '- 마지막 줄은 반드시 `SUGGEST: <행 id>` 또는 `SUGGEST: NONE` 이다.',
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
 * **마지막 줄만** 읽는다 — reviewer 판정(`parseVerdict`)과 같은 규칙이다.
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
): Promise<DirectAnswer> {
  const run = await conduct(slot, buildDirectPrompt(matrix, context, message));
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
 * v2.1 세션은 상향을 **실행하지 않으므로** 언제나 사다리의 첫 단계를 제안한다 (SPEC §2.4 순서).
 */
export function nextSuggestion(outcome: 'ok' | 'unverified' | 'wrong', verdict: Verdict): string {
  if (outcome === 'ok' && verdict !== 'fail') return '';
  const stage = nextStage([]);
  return stage ? `사다리 다음 단계: ${STAGE_LABEL[stage]} — 그 뒤에 다시 위임한다` : '';
}
