import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { CLASSIFIER_MODELS, ClassifierModelError, buildClassifyPrompt, classifyWithModel } from '../classify-llm.ts';

const matrix = loadMatrix();

describe('분류 폴백', () => {
  it('분류에는 저비용 모델만 허용한다 — Fable 요청은 던진다', async () => {
    assert.deepEqual([...CLASSIFIER_MODELS], ['haiku', 'luna']);
    await assert.rejects(
      () => classifyWithModel(matrix, loadEngines(), '아무거나', { model: 'fable' }),
      ClassifierModelError,
    );
  });

  it('프롬프트는 11행 id 와 제목만 주고 id 하나를 요구한다', () => {
    const prompt = buildClassifyPrompt(matrix, '타입 에러');
    assert.match(prompt, /R01\t짧은 구현 \/ 타입 수정/);
    assert.match(prompt, /R11\t/);
    assert.match(prompt, /id만/);
    assert.match(prompt, /NONE/);
  });
});
