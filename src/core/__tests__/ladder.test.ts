import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMatrix } from '../../data/matrix.ts';
import { ESCALATION_ORDER, LadderError, climb, jumpTo, nextStage, requestStage } from '../ladder.ts';

const matrix = loadMatrix();

describe('상향 순서', () => {
  it('근거 보강 → effort → 모델 → reviewer 순이다', () => {
    assert.deepEqual([...ESCALATION_ORDER], ['evidence', 'effort', 'model', 'reviewer']);
    assert.equal(nextStage([]), 'evidence');
  });

  it('순서대로 밟으면 네 단계를 모두 지난다', () => {
    let done: readonly ('evidence' | 'effort' | 'model' | 'reviewer')[] = [];
    for (const stage of ESCALATION_ORDER) done = requestStage(done, stage);
    assert.equal(nextStage(done), null);
  });

  it('근거 보강을 건너뛰고 모델부터 올리려는 요청은 던진다', () => {
    assert.throws(() => requestStage([], 'model'), LadderError);
    assert.throws(() => requestStage([], 'model'), /상향 순서를 건너뛸 수 없다/);
  });

  it('effort 를 건너뛰고 reviewer 를 붙이려는 요청도 던진다', () => {
    assert.throws(() => requestStage(['evidence'], 'reviewer'), LadderError);
  });
});

describe('사다리 레벨', () => {
  it('L1 → L2 → L3 → L5 로 한 칸씩만 올라간다', () => {
    assert.equal(climb(matrix, 'L1').level, 'L2');
    assert.equal(climb(matrix, 'L3').level, 'L5');
  });

  it('L1 에서 L5 직행 경로는 없다', () => {
    assert.throws(() => jumpTo(matrix, 'L1', 'L5'), /직행 경로는 없다/);
  });

  it('최상단에서 더 올리려 하면 던진다', () => {
    assert.throws(() => climb(matrix, 'L5'), LadderError);
  });

  it('L5 만 독립 검증을 요구한다', () => {
    assert.equal(climb(matrix, 'L3').independentReview, true);
    assert.equal(climb(matrix, 'L1').independentReview, false);
  });
});
