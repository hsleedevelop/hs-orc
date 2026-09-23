/**
 * 분류기 LLM 폴백 (PLAN S3-6).
 * 규칙으로 부족할 때만 **저비용 모델로 분류만** 시킨다. **분류에 Fable을 쓰지 않는다.**
 * 기본은 Haiku·low — 비용 표(SPEC §2.3)에서 가장 싼 Anthropic 행이다.
 */
import type { Matrix, ModelKey } from '../data/matrix.ts';
import type { Engines } from '../data/engines.ts';
import { adapterFor } from '../adapters/engine.ts';
import { assignmentById } from './classify.ts';
import type { Assignment } from '../data/matrix.ts';

/** 분류 전용으로 허용된 모델. 이 목록 밖은 던진다 — 분류에 비싼 모델이 새어 들어가는 것을 막는다. */
export const CLASSIFIER_MODELS: readonly ModelKey[] = ['haiku', 'luna'];

export class ClassifierModelError extends Error {
  override name = 'ClassifierModelError';
}

export function buildClassifyPrompt(matrix: Matrix, task: string): string {
  const rows = matrix.assignments.map((a) => `${a.id}\t${a.task}`).join('\n');
  return [
    '아래 업무 목록 중 주어진 작업에 가장 맞는 행의 id 하나만 출력하라.',
    '설명·문장부호 없이 id만. 맞는 행이 없으면 NONE 만 출력하라.',
    '',
    rows,
    '',
    `작업: ${task}`,
  ].join('\n');
}

export async function classifyWithModel(
  matrix: Matrix,
  catalog: Engines,
  task: string,
  options: {
    model?: ModelKey;
    effort?: 'low' | 'medium';
    timeoutMs?: number;
    /**
     * 분류기를 띄울 폴더 (D-029). 기본은 `process.cwd()` 다.
     * 셸이 폴더를 바꿀 수 있으면(GUI) **그 폴더를 넘겨야 한다** — 분류만 옛 폴더에서 돌면
     * 화면이 말하는 폴더와 실제로 띄운 폴더가 갈린다.
     */
    cwd?: string;
  } = {},
): Promise<Assignment | null> {
  const model = options.model ?? 'haiku';
  if (!CLASSIFIER_MODELS.includes(model)) {
    throw new ClassifierModelError(`분류에는 저비용 모델만 쓴다: ${CLASSIFIER_MODELS.join(' | ')} (요청: ${model})`);
  }
  const effort = options.effort ?? 'low';

  const adapter = adapterFor(model, effort, catalog);
  const handle = adapter.start({
    model,
    effort,
    prompt: buildClassifyPrompt(matrix, task),
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs ?? 120_000,
    // 분류기도 지휘자 계층이다 — 사용자 전역 hook·설정·MCP·skills 를 싣지 않는다 (D-032 B1).
    isolate: true,
  });
  const result = await handle.result;
  if (result.outcome !== 'ok') return null;

  const answer = result.text.trim().toUpperCase();
  if (answer.startsWith('NONE')) return null;

  const id = /R\d{2}/.exec(answer)?.[0];
  if (!id) return null;
  try {
    return assignmentById(matrix, id);
  } catch {
    return null;
  }
}
