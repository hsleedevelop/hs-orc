/**
 * 지휘자 (SPEC §6.4.2·§6.4.4, D-031·D-087).
 *
 * **라우팅을 하지 않는다.** 배정은 결정론 코드(pipeline)가 한다 — G1 을 모델 판단에 넘기지 않는다.
 * 지휘자가 하는 일은 셋이다: 하한선·미분류 메시지에 **직접 답**하고, 위임 결과를 **요약**하고,
 * 사람이 부르면 요청을 **위임 단계로 나눈 계획**을 낸다 (D-087). 단계마다 배정은 여전히 매트릭스가 하고 시작은 사람이 승인한다.
 * 모델·effort 는 세션마다 사람이 고른다 (D-087) — 기본은 `limits.json` 의 벤더 기본 모델이다.
 */
import type { EngineName, Engines } from '../data/engines.ts';
import { ORCHESTRATOR_ENGINES, isOrchestratorEngine, loadLimits, type OrchestratorChoice, type OrchestratorEngine } from '../data/limits.ts';
import type { Effort, Matrix, ModelKey } from '../data/matrix.ts';
import { AssignError, resolveSlot, type ResolvedSlot } from './assign.ts';
import type { Delegated } from './delegate.ts';
import type { SettledOutcome } from './evidence.ts';
import type { ReviewRun, Verdict } from './duo.ts';
import type { SlotExecutor, SlotRun } from './executor.ts';
import { STAGE_LABEL, nextStage } from './ladder.ts';
import { GraphError, parseGraphSpec, topoSort, type GraphNode, type GraphSpec } from './modes/graph.ts';

/** codex 지휘자를 막은 이유 (D-087, 리뷰 #114-1) — 셸이 선택을 거절할 때 같은 문구를 쓴다. */
export const CODEX_BLOCKED = 'codex 는 지휘자로 쓰지 않는다 — 내장 도구(apply_patch·request_user_input 등)와 전역 AGENTS.md 를 끄는 인자가 없어 D-080(지휘자 도구 0개)을 지킬 수 없다 (D-087).';

/** D-087 이전 세션의 지휘자 — 기록에 지휘자 선택이 없는 세션은 이것으로 연다. 조용히 비싼 모델로 바뀌지 않게 한다. */
export const LEGACY_ORCHESTRATOR: OrchestratorChoice = { model: 'haiku', effort: 'low' };

/** 엔진을 주면 그 벤더의 기본, 안 주면 `limits.json` 의 시작 엔진의 기본이다. */
export function defaultOrchestrator(engine?: OrchestratorEngine): OrchestratorChoice {
  const { orchestrator } = loadLimits();
  return orchestrator.defaults[engine ?? orchestrator.engine];
}

const modelLabel = (model: ModelKey): string => `${model.charAt(0).toUpperCase()}${model.slice(1)}`;

/**
 * role 을 `reviewer` 로 둔다 — `createExecutor` 가 **쓰기를 절대 주지 않는 자리**다.
 * 직접 답·계획은 세션의 쓰기 스위치와 무관하게 읽기 전용이어야 하고(SPEC §6.4.2),
 * 그 강제를 호출자의 주의에 맡기지 않는다. 1M 창은 그 모델에 실측 선언이 있을 때만 연다 (D-087).
 */
export function conductorSlot(catalog: Engines, choice: OrchestratorChoice): ResolvedSlot {
  const spec = catalog.models[choice.model];
  if (!spec) throw new AssignError(`모르는 지휘자 모델이다: ${String(choice.model)}`);
  if (!isOrchestratorEngine(spec.defaultEngine)) {
    throw new AssignError(`${choice.model} 는 ${spec.defaultEngine} 모델이다 — 지휘자는 ${ORCHESTRATOR_ENGINES.join('·')} 에서만 띄운다. ${CODEX_BLOCKED}`);
  }
  const slot = resolveSlot(catalog, { model: choice.model, vendor: spec.defaultEngine === 'claude' ? 'anthropic' : 'openai', efforts: [choice.effort], label: `지휘자·${modelLabel(choice.model)}` }, choice.effort, 'reviewer');
  return spec.availability[spec.defaultEngine]?.longContext === true ? { ...slot, longContext: true } : slot;
}

export interface OrchestratorOption {
  readonly engine: OrchestratorEngine;
  readonly models: readonly { readonly model: ModelKey; readonly label: string; readonly efforts: readonly Effort[]; readonly longContext: boolean }[];
  readonly defaults: OrchestratorChoice;
}

/** 화면의 선택지 — 엔진마다 그 엔진이 기본 엔진인 모델들. 카탈로그를 그대로 읽는다. */
export function orchestratorOptions(catalog: Engines): OrchestratorOption[] {
  return ORCHESTRATOR_ENGINES.map((engine) => ({
    engine,
    defaults: defaultOrchestrator(engine),
    models: (Object.entries(catalog.models) as [ModelKey, Engines['models'][ModelKey]][])
      .filter(([, m]) => m.defaultEngine === (engine as EngineName) && m.availability[engine] !== null)
      .map(([model, m]) => ({
        model,
        label: modelLabel(model),
        efforts: m.availability[engine]?.efforts ?? [],
        longContext: m.availability[engine]?.longContext === true,
      })),
  }));
}

export interface DirectOptions {
  readonly unrouted?: boolean;
  /**
   * 새 프로젝트 생성 요청으로 감지됐는데 스캐폴딩 카드를 세우지 못한 턴 (D-088) — 카드가 서는 길·못 선 이유·허용 목록 명령.
   * 주면 "행을 골라 위임하라" 대신 이것으로 안내하고 행을 제안하지 않는다.
   */
  readonly scaffold?: string;
  /**
   * 앱(dev 서버) 실행 요청으로 감지됐는데 실행 카드를 세우지 못한 턴 (D-091) — 카드가 서는 길·못 선 이유·사람이 칠 명령.
   * 주면 "행을 골라 위임하라" 대신 이것으로 안내하고 행을 제안하지 않는다 — 위임 엔진은 포트를 열지 못한다(Q29).
   */
  readonly run?: string;
}

/**
 * `unrouted` — Jev 가 답했는데 행을 확정하지 않은 턴(NONE·GENERAL·확신도 미만, D-065·D-082). 그 턴의 SUGGEST 는 세션이 어차피 버리므로
 * 행을 제안하라고 시키지 않고, 위임은 사람이 행을 골라야 한다고 안내하게 한다 (D-079). 마지막 줄 형식은 그대로 둔다.
 */
export function buildDirectPrompt(matrix: Matrix, context: string, message: string, options: DirectOptions = {}): string {
  const rows = matrix.assignments.map((a) => `${a.id}\t${a.task}`).join('\n');
  const unrouted = options.unrouted === true || options.scaffold !== undefined || options.run !== undefined;
  return [
    '너는 hs-orc 의 지휘자다. 사용자와 대화로 짧게 답한다.',
    '규칙:',
    '- 파일을 고치거나 명령을 실행하지 않는다.',
    options.run !== undefined
      ? '- 개발 작업을 대신 수행하거나 그 결과를 지어내지 않는다. 이 메시지는 앱(dev 서버) 실행 요청이다 — 업무 행을 고르라고 안내하지 않는다. 위임 엔진의 샌드박스는 포트를 열지 못하고 서버는 끝나지 않아 위임으로 돌지 않는다. 아래 [실행] 대로 다음 행동을 안내하고, 명령은 [실행] 에 적힌 것만 쓴다.'
      : options.scaffold !== undefined
      ? '- 개발 작업을 대신 수행하거나 그 결과를 지어내지 않는다. 이 메시지가 새 프로젝트를 만드는(스캐폴딩) 요청이면 업무 행을 고르라고 안내하지 않는다 — 위임 엔진의 샌드박스는 네트워크를 막아 스캐폴더가 돌지 않는다. 아래 [스캐폴딩] 대로 다음 행동을 안내한다. 새 프로젝트 요청이 아니면 이 요청은 업무 행에 배정되지 않았다고 말하고 위임하려면 사용자가 행을 직접 골라야 한다고 안내한다 (GUI 의 "위임하기" · CLI 의 `/task Rxx`).'
      : unrouted
      ? '- 개발 작업을 대신 수행하거나 그 결과를 지어내지 않는다. 작업 요청이면 이 요청은 업무 행에 배정되지 않았다고 말하고, 위임하려면 사용자가 아래 업무 목록에서 행을 직접 골라야 한다고 안내한다 (GUI 의 "위임하기" · CLI 의 `/task Rxx`). 행을 대신 고르거나 추천하지 않는다.'
      : '- 개발 작업을 대신 수행하거나 그 결과를 지어내지 않는다. 작업 요청이면 무엇을 하게 될지 한두 문장으로 말하고, 아래 업무 목록에서 맞는 행을 제안한다.',
    '- 너는 이 답 하나만 쓴다. 분석·작업을 진행 중이라거나 곧 진행한다고 말하지 않는다 — 작업은 사람이 위임을 승인해야 시작된다.',
    unrouted ? '- 마지막 줄은 반드시 `SUGGEST: NONE` 이다.' : '- 마지막 줄은 반드시 `SUGGEST: <행 id>` 또는 `SUGGEST: NONE` 이다.',
    '',
    '[업무 목록]',
    rows,
    ...(options.scaffold !== undefined ? ['', '[스캐폴딩]', options.scaffold] : []),
    ...(options.run !== undefined ? ['', '[실행]', options.run] : []),
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
  options: DirectOptions = {},
): Promise<DirectAnswer> {
  const run = await conduct(slot, buildDirectPrompt(matrix, context, message, options));
  return { run, ...parseSuggest(matrix, run.text) };
}

/** 요약에 싣는 reviewer 글의 상한 (D-093). reviewer 는 사유를 먼저 쓰고 판정을 마지막 줄에 둔다 — 앞부분이 사유다. */
export const SUMMARY_REVIEW_CHARS = 1500;

/**
 * 요약에 실을 reviewer 글. reviewer 가 둘이면(D-072) PASS 하지 않은 쪽만 싣고 상한을 그들끼리 나눈다 —
 * 이어 붙인 글의 앞부분만 자르면 첫 PASS 글이 길 때 둘째의 FAIL 사유가 빠진다 (D-093 리뷰).
 */
function summaryReview(review: string | undefined, reviews: readonly ReviewRun[] | undefined): string {
  if (!reviews || reviews.length <= 1) return review?.trim() ? review.slice(0, SUMMARY_REVIEW_CHARS) : '';
  const failing = reviews.filter((r) => r.verdict !== 'pass');
  const picked = failing.length > 0 ? failing : reviews;
  const each = Math.floor(SUMMARY_REVIEW_CHARS / picked.length);
  return picked.map((r) => `[reviewer ${r.reviewer} → ${r.verdict.toUpperCase()}]\n${r.run.text.slice(0, each)}`).join('\n\n');
}

/**
 * 위임 결과 요약 프롬프트. PASS 가 아니면 reviewer 글을 잘라 싣는다 (D-093) — 싣지 않으면 요약이
 * "FAIL 사유가 나와 있지 않다" 고 말한다. PASS 는 싣지 않는다(요약에 바뀌는 것이 없고 비용만 는다).
 */
export function buildSummaryPrompt(
  title: string,
  d: Pick<Delegated, 'text' | 'verdict' | 'outcome' | 'report' | 'review' | 'reviews'>,
): string {
  const review = d.verdict === 'pass' ? '' : summaryReview(d.review, d.reviews);
  return [
    '아래 위임 결과를 사용자에게 3줄 이내로 요약하라.',
    '새 사실을 지어내지 않는다. reviewer 판정과 증거 상태를 그대로 전한다.',
    ...(review ? ['reviewer 가 PASS 하지 않았으면 아래 reviewer 검증 글에서 그 핵심 사유를 한두 개 전한다.'] : []),
    '',
    `[요청] ${title}`,
    `[reviewer 판정] ${d.verdict}`,
    `[증거] ${d.report.summary}`,
    `[outcome] ${d.outcome}`,
    ...(review ? ['[reviewer 검증 글 앞부분]', review] : []),
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

/**
 * 단계 계획 프롬프트 (D-087). 지휘자는 **행과 순서만** 정한다 — 모델·effort 는 행이 정하므로 묻지 않는다(G1).
 * 형식은 `examples/graph-nodes.json` 의 `nodes` 와 같은 모양이라 `parseGraphSpec` 이 그대로 검사한다.
 */
export function buildStepsPrompt(matrix: Matrix, context: string, request: string, maxSteps: number): string {
  const rows = matrix.assignments.map((a) => `${a.id}\t${a.task}`).join('\n');
  return [
    '너는 hs-orc 의 지휘자다. 사용자의 요청을 순서 있는 위임 단계로 나눈 계획을 낸다.',
    '규칙:',
    '- 계획만 낸다. 파일을 고치거나 명령을 실행하지 않는다 — 실행은 사람이 계획을 승인한 뒤 단계마다 hs-orc 가 띄운다.',
    `- 단계는 1~${maxSteps}개다. 한 단계는 아래 업무 목록의 행 하나에 맞는 작은 작업이다. 나눌 필요가 없으면 1단계로 낸다.`,
    '- 각 단계의 prompt 는 그 단계를 맡은 엔진이 그것만 읽고 수행할 수 있게 쓴다. 앞 단계의 결과는 hs-orc 가 붙인다.',
    '- dependsOn 에는 그 단계가 결과를 써야 하는 앞 단계 id 만 넣는다. 순환을 만들지 않는다.',
    '- 답은 JSON 객체 하나뿐이다. 설명·코드 펜스 없이 다음 모양으로 낸다:',
    '{"steps":[{"id":"s1","task":"R03","prompt":"…","dependsOn":[]},{"id":"s2","task":"R01","prompt":"…","dependsOn":["s1"]}]}',
    '',
    '[업무 목록]',
    rows,
    ...(context ? ['', '[최근 대화]', context] : []),
    '',
    '[요청]',
    request,
  ].join('\n');
}

export class StepsError extends Error {
  override name = 'StepsError';
}

/**
 * 지휘자 답 → 배정이 끝난 단계들. 첫 `{` 부터 마지막 `}` 까지를 JSON 으로 읽는다(펜스를 둘렀어도 읽힌다).
 * 행·의존·순환·상한 검사는 `/graph` 와 같은 코드다 — 지휘자가 낸 계획이라고 덜 검사하지 않는다. 못 읽으면 던진다.
 */
export function parseSteps(matrix: Matrix, catalog: Engines, text: string, maxSteps: number): GraphNode[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new StepsError('계획 JSON 이 없다.');
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new StepsError(`계획 JSON 을 읽지 못했다: ${error instanceof Error ? error.message : String(error)}`);
  }
  const steps = (raw as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new StepsError('계획에 steps 배열이 없다.');
  if (steps.length > maxSteps) throw new StepsError(`단계가 상한을 넘는다: ${steps.length} > ${maxSteps}`);
  // 모델이 낸 JSON 이라 모양을 믿지 않는다 — dependsOn 이 문자열이면 위상 정렬이 글자 단위로 돈다.
  for (const step of steps as unknown[]) {
    const s = step as Record<string, unknown> | null;
    const deps = s?.['dependsOn'];
    if (typeof s?.['id'] !== 'string' || typeof s['task'] !== 'string' || typeof s['prompt'] !== 'string' || (deps !== undefined && !(Array.isArray(deps) && deps.every((d) => typeof d === 'string')))) {
      throw new StepsError(`단계 모양이 틀렸다 (id·task·prompt 는 문자열, dependsOn 은 문자열 배열): ${JSON.stringify(step).slice(0, 200)}`);
    }
  }
  try {
    const nodes = parseGraphSpec(matrix, catalog, { nodes: steps as GraphSpec['nodes'] });
    topoSort(nodes);
    // 단계는 실패해도 뒤를 막는 것이 기본이다 — 지휘자가 전파 방식을 정하지 않는다.
    return nodes.map((n) => ({ ...n, onFailure: 'skip-dependents' as const }));
  } catch (error) {
    if (error instanceof GraphError) throw new StepsError(error.message);
    throw error;
  }
}

/** 단계 하나가 엔진에 보내는 프롬프트 — 전체 요청과 의존한 앞 단계의 결과를 싣는다. */
export function buildStepPrompt(request: string, step: { readonly id: string; readonly prompt: string }, before: readonly { readonly id: string; readonly text: string }[], context: string): string {
  return [
    ...(context ? ['[최근 대화]', context, ''] : []),
    '[전체 요청]',
    request,
    ...before.flatMap((b) => ['', `[앞 단계 ${b.id} 결과]`, b.text.slice(0, 3000)]),
    '',
    `[이번 단계 ${step.id}]`,
    step.prompt,
  ].join('\n');
}

export function buildStepsSummaryPrompt(request: string, results: readonly { readonly id: string; readonly outcome: string; readonly verdict: string; readonly evidence: string; readonly text: string }[], skipped: readonly string[]): string {
  return [
    '아래 단계별 위임 결과를 사용자에게 5줄 이내로 요약하라.',
    '새 사실을 지어내지 않는다. 단계마다 reviewer 판정과 증거 상태를 그대로 전한다.',
    '',
    `[요청] ${request}`,
    ...results.flatMap((r) => ['', `[단계 ${r.id}] outcome ${r.outcome} · reviewer ${r.verdict} · 증거 ${r.evidence}`, r.text.slice(0, 1200)]),
    ...(skipped.length > 0 ? ['', `[건너뛴 단계] ${skipped.join(', ')}`] : []),
  ].join('\n');
}
