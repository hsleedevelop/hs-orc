import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { ClassifyError, classify } from '../classify.ts';
import { planPrimary } from '../route.ts';

const matrix = loadMatrix();
const catalog = loadEngines();

describe('분류기', () => {
  it('PLAN S1의 업무 3종을 서로 다른 행으로 보낸다', () => {
    const got = ['이 타입 에러 고쳐줘', '이 기능 새로 구현해줘', '이 아키텍처 설계 검토해줘'].map(
      (t) => classify(matrix, t).assignment.id,
    );
    assert.deepEqual(got, ['R01', 'R03', 'R10']);
  });

  it('아무 키워드도 안 맞으면 조용히 아무 행이나 고르지 않고 던진다', () => {
    assert.throws(() => classify(matrix, '오늘 점심 뭐 먹지'), ClassifyError);
  });
});

describe('primary 배정', () => {
  it('업무 3종이 서로 다른 엔진·모델·effort 로 간다 (S1 완료 판정)', () => {
    const plans = ['이 타입 에러 고쳐줘', '이 기능 새로 구현해줘', '이 아키텍처 설계 검토해줘'].map((t) =>
      planPrimary(matrix, catalog, t),
    );

    assert.deepEqual(
      plans.map((p) => [p.assignment.id, p.engine, p.modelId, p.effort]),
      [
        ['R01', 'codex', 'gpt-5.6-luna', 'medium'],
        ['R03', 'codex', 'gpt-5.6-sol', 'high'],
        ['R10', 'claude', 'claude-fable-5-1', 'high'],
      ],
    );
    assert.equal(new Set(plans.map((p) => p.modelId)).size, 3);
  });

  it('매트릭스가 범위를 주면 낮은 쪽을 기본으로 쓴다', () => {
    // R05 복잡한 버그 / 장애 RCA → Astra | xHigh/Max
    const plan = planPrimary(matrix, catalog, '', { taskId: 'R05' });
    assert.equal(plan.effort, 'xhigh');
    assert.equal(plan.modelId, 'gpt-6-astra');
  });

  it('--task 로 수동 지정하면 분류기를 건너뛴다', () => {
    const plan = planPrimary(matrix, catalog, '오늘 점심 뭐 먹지', { taskId: 'R11' });
    assert.equal(plan.assignment.id, 'R11');
    assert.equal(plan.reason, '수동 지정 R11');
  });
});
