import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkLimits, loadLimits } from '../limits.ts';

describe('상한 파일 검사 (SPEC §9)', () => {
  it('수기 파일의 값은 통과한다', () => {
    assert.doesNotThrow(() => checkLimits(loadLimits()));
  });

  it('맥락 글자 상한이 2 미만이면 던진다 — 0·1·음수는 자르지 않거나 앞을 잘못 자른다', () => {
    for (const contextChars of [1, 0, -5, 2.5]) {
      assert.throws(() => checkLimits({ ...loadLimits(), contextChars }), /contextChars/);
    }
  });

  it('양수가 아닌 상한은 던진다 — 상한 없는 방식은 만들지 않는다', () => {
    assert.throws(() => checkLimits({ ...loadLimits(), maxIterations: 0 }), /maxIterations/);
    assert.throws(() => checkLimits({ ...loadLimits(), tokenBudget: Number.NaN }), /tokenBudget/);
  });
});
