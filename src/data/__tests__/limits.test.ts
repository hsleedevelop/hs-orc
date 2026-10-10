import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkLimits, loadLimits, verifyGroups } from '../limits.ts';

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

  it('Jev 값은 검사한다 — 확신도는 (0,1], 맥락은 2 이상의 정수 (D-065)', () => {
    for (const jevConfidenceMin of [0, -0.1, 1.5, Number.NaN]) {
      assert.throws(() => checkLimits({ ...loadLimits(), jevConfidenceMin }), /jevConfidenceMin/);
    }
    for (const jevContextChars of [1, 2.5]) assert.throws(() => checkLimits({ ...loadLimits(), jevContextChars }), /jevContextChars/);
    assert.throws(() => checkLimits({ ...loadLimits(), jevTimeoutMs: 0 }), /jevTimeoutMs/);
  });

  it('실행 스크립트는 비지 않은 이름 배열이다 — 셸 문자를 담은 이름은 거절한다 (D-091)', () => {
    assert.deepEqual(loadLimits().runScripts, ['dev', 'start']);
    for (const runScripts of [[], ['dev; rm -rf ~'], ['Dev'], 'dev']) {
      assert.throws(() => checkLimits({ ...loadLimits(), runScripts } as never), /runScripts/);
    }
  });

  it('검증 스크립트는 묶음 배열이다 — test 는 R01·R04·R06 에만, 셸 문자·빈 묶음은 거절한다 (D-096)', () => {
    const { verifyScripts } = loadLimits();
    assert.deepEqual(verifyGroups(verifyScripts, 'R03'), [['lint'], ['typecheck', 'type-check']]);
    assert.deepEqual(verifyGroups(verifyScripts, 'R01').at(-1), ['test']);
    for (const bad of [{ all: [[]], rows: {} }, { all: [['lint && rm -rf ~']], rows: {} }, { all: [['lint']], rows: { r1: [['test']] } }, { all: ['lint'], rows: {} }]) {
      assert.throws(() => checkLimits({ ...loadLimits(), verifyScripts: bad } as never), /verifyScripts/);
    }
  });
});
