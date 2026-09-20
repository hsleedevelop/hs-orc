import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EFFORTS, crossesVendors, loadMatrix } from '../matrix.ts';

describe('matrix.json', () => {
  it('업무별 배정 11행을 담는다', () => {
    assert.equal(loadMatrix().assignments.length, 11);
  });

  it('모든 행이 primary와 reviewer를 교차 벤더로 갖는다 (INV-1)', () => {
    const violations = loadMatrix().assignments.filter((a) => !crossesVendors(a));
    assert.deepEqual(violations.map((a) => a.id), []);
  });

  it('모든 effort가 정규 어휘 안에 있다', () => {
    const vocab = new Set<string>(EFFORTS);
    const outside = loadMatrix()
      .assignments.flatMap((a) => [...a.primary.efforts, ...a.reviewer.efforts])
      .filter((e) => !vocab.has(e));
    assert.deepEqual(outside, []);
  });

  it('상향 사다리 4단을 담고 L5에서만 독립 검증을 요구한다', () => {
    const ladder = loadMatrix().ladder;
    assert.deepEqual(ladder.map((s) => s.level), ['L1', 'L2', 'L3', 'L5']);
    assert.deepEqual(ladder.filter((s) => s.independentReview).map((s) => s.level), ['L5']);
  });

  it('8모델의 비용·지연 측정치를 담는다', () => {
    const economics = loadMatrix().economics;
    assert.equal(economics.length, 8);
    assert.ok(economics.every((e) => e.taskCostUsd > 0 && e.firstChunkSec > 0));
  });
});
