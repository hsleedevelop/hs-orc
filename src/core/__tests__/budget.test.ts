import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Budget } from '../budget.ts';

/**
 * 비용 출처를 섞어 표시하지 않는다 (SPEC §2.5·§3.5, D-027).
 * `metered` 를 `actual` 이라 부르는 순간 "벤더가 청구한 금액"과 "내가 곱한 값"이 구분되지 않는다.
 */
describe('출처를 섞어 표시하지 않는다', () => {
  it('우선순위는 actual > metered > estimate 다', () => {
    const b = new Budget(100);
    assert.equal(b.charge('a', 1, 9, 5, 'api').source, 'actual');
    assert.equal(b.charge('b', undefined, 9, 5, 'api').source, 'metered');
    assert.equal(b.charge('c', undefined, 9, undefined, 'api').source, 'estimate');
  });

  it('섞이면 무엇이 섞였는지 누적 표시에 드러난다', () => {
    const b = new Budget(100);
    b.charge('a', 1, 9, undefined, 'api');
    b.charge('b', undefined, 9, 5, 'api');
    assert.deepEqual(b.sources, ['actual', 'metered']);
    assert.match(b.summary(), /실측\+토큰×선언단가/);
  });

  it('추정이 하나라도 있으면 그 사실을 숨기지 않는다', () => {
    const b = new Budget(100);
    b.charge('a', undefined, 9, undefined, 'api');
    assert.equal(b.hasEstimates, true);
    assert.match(b.summary(), /추정/);
  });
});
