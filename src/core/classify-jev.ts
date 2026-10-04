/**
 * Jev 분류 (D-065). **행 고르기만 맡긴다** — 모델·effort·reviewer 는 계속 매트릭스가 정한다.
 * criteria 는 매트릭스 행에서 만들고 `NONE` 을 반드시 넣는다 (D-022: 해당 없음은 사람에게).
 * 확신도가 기준 미만이면 행을 확정하지 않고 후보를 사람에게 보인다.
 * `GENERAL` 은 행이 아니라 판정 라벨이다 (D-082, Q26 G1b) — "맞는 행이 없는 실제 작업" 을 NONE(대화성)에서 떼어 낼 뿐 배정은 세우지 않는다.
 */
import type { Assignment, Matrix } from '../data/matrix.ts';
import { JevUnavailableError, type JevChoiceAnswer, type RowClassifier } from '../adapters/jev.ts';

export const NONE = 'NONE';
export const GENERAL = 'GENERAL';

export type JevUsage = Pick<JevChoiceAnswer, 'inputTokens' | 'outputTokens' | 'elapsedMs'>;

export interface JevCandidate {
  readonly id: string;
  readonly probability: number;
}

interface Base {
  readonly usage: JevUsage;
  readonly confidence: number;
  /** 확률 내림차순 상위 3개 (NONE 포함). 화면·로그가 그대로 쓴다. */
  readonly candidates: readonly JevCandidate[];
}

export type JevVerdict =
  | (Base & { readonly kind: 'row'; readonly assignment: Assignment; readonly probability: number })
  /** 확신 있게 "어느 행도 아니다". 사람(또는 대화 세션의 지휘자)에게 간다. */
  | (Base & { readonly kind: 'none'; readonly probability: number })
  /** 확신 있게 "행에 안 맞는 실제 작업" (D-082). 배정은 서지 않고 사람이 행을 고른다 — 미분류 로그에 남는다. */
  | (Base & { readonly kind: 'general'; readonly probability: number })
  /** 확신도가 기준 미만이다. 행을 고르지 않는다. */
  | (Base & { readonly kind: 'unsure' });

export function buildCriteria(matrix: Matrix): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const a of matrix.assignments) criteria[a.id] = `${a.task} — ${a.operatingCriterion}`;
  // 두 문구와 키 순서는 Q26 재평가 2단계의 B′ 그대로다 (D-082) — 옵션 이름만 R12 → GENERAL. 고치면 다시 잰다.
  criteria[GENERAL] = '범용 — 코드·파일을 읽어 설명·문서 초안 작성·다이어그램·조사·운영 상태 확인 — 읽은 근거를 경로:줄로 인용하고 추측과 구분한다';
  criteria[NONE] =
    '해당 없음: 대화 맥락만으로 답할 수 있다 — 잡담·개념 질문·앞선 결과에 대한 설명이나 후속이다. 이 대화에 이미 나온 결과·위임에 대한 질문·설명 요청은 해당 없음이다(세부가 맥락에 없어도). 그 밖에 파일·코드를 새로 읽어야 답할 수 있는 요청은 해당 없음이 아니다. 또는 어느 행인지 판단할 근거가 없다.';
  return criteria;
}

const INSTRUCTIONS = '이 요청을 맡길 업무 행 하나를 고른다. 작업 위임이 아니거나 어느 행에도 맞지 않으면 NONE 이다.';
const INSTRUCTIONS_WITH_CONTEXT = `${INSTRUCTIONS} \`message\` 가 분류 대상이고 \`recent_conversation\` 은 맥락일 뿐이다.`;

/** 요청 문장(+있으면 최근 대화 맥락)만 보낸다. 다른 것은 싣지 않는다. */
export async function classifyWithJev(
  matrix: Matrix,
  classifier: RowClassifier,
  task: string,
  options: { readonly confidenceMin: number; readonly context?: string },
): Promise<JevVerdict> {
  const context = options.context?.trim();
  const criteria = buildCriteria(matrix);
  const answer = await classifier({
    state: context ? { recent_conversation: context, message: task } : task,
    instructions: context ? INSTRUCTIONS_WITH_CONTEXT : INSTRUCTIONS,
    criteria,
  });

  // 우리가 준 옵션이 아닌 값이 오면 행을 추측하지 않는다 — 못 쓴 것으로 올려 옛 방식으로 돌린다.
  if (!(answer.choice in criteria)) throw new JevUnavailableError('bad-response', `모르는 옵션 ${answer.choice.slice(0, 20)}`);

  const candidates = Object.entries(answer.probabilities)
    .filter(([id]) => id in criteria)
    .map(([id, probability]) => ({ id, probability }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 3);
  const base = { usage: { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, elapsedMs: answer.elapsedMs }, confidence: answer.confidence, candidates };
  const probability = answer.probabilities[answer.choice] ?? 0;

  if (answer.confidence < options.confidenceMin) return { kind: 'unsure', ...base };
  if (answer.choice === NONE) return { kind: 'none', probability, ...base };
  if (answer.choice === GENERAL) return { kind: 'general', probability, ...base };
  const assignment = matrix.assignments.find((a) => a.id === answer.choice);
  if (!assignment) return { kind: 'unsure', ...base };
  return { kind: 'row', assignment, probability, ...base };
}

const pct = (p: number): string => p.toFixed(2);

/** `Jev R05 p=0.91 conf=0.83` — 결정 로그 trigger 와 plan.reason 이 쓰는 한 줄. */
export const jevReason = (id: string, probability: number, confidence: number): string =>
  `Jev ${id} p=${pct(probability)} conf=${pct(confidence)}`;

export const candidatesText = (candidates: readonly JevCandidate[]): string =>
  candidates.map((c) => `${c.id} ${pct(c.probability)}`).join(' · ');

/** 돌았다는 사실 — 토큰·시간은 보이고 **비용은 미산정**이다 (가격이 문서에 없다, D-034 와 같은 정직). */
export const usageText = (u: JevUsage): string =>
  `입력 ${u.inputTokens.toLocaleString('en-US')}·출력 ${u.outputTokens.toLocaleString('en-US')} 토큰 · ${(u.elapsedMs / 1000).toFixed(1)}s · 비용 미산정(가격 미공개)`;
