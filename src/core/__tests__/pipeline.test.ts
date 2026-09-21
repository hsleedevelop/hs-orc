import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines, type Engines } from '../../data/engines.ts';
import { ClassifyError, classify } from '../classify.ts';
import { AssignError, assign, crossVendorPair } from '../assign.ts';
import { GATE_CHECKS, evaluateGate } from '../gatekeeper.ts';
import { route, routeWithFallback } from '../pipeline.ts';

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

describe('배정 — 11행 테이블', () => {
  for (const assignment of matrix.assignments) {
    it(`${assignment.id} ${assignment.task} 는 교차 벤더 두 슬롯으로 배정된다`, () => {
      const plan = assign(matrix, catalog, assignment);
      const { primary, reviewer } = plan.slots;

      assert.equal(primary.model, assignment.primary.model);
      assert.equal(reviewer.model, assignment.reviewer.model);
      assert.equal(primary.effort, assignment.primary.efforts[0]);
      assert.notEqual(primary.engine, reviewer.engine, 'primary 와 reviewer 가 같은 엔진이면 독립 검증이 아니다');
      assert.ok(primary.modelId.length > 0 && reviewer.modelId.length > 0);
      assert.equal(
        plan.cost.totalUsd,
        Number((plan.cost.primaryUsd + plan.cost.reviewerUsd).toFixed(4)),
      );
      assert.equal(plan.cost.grade, 'independent');
    });
  }

  it('매트릭스를 단일 엔진 선택기로 축소하지 않는다 — 11행 전부 reviewer 슬롯이 살아 있다', () => {
    assert.equal(matrix.assignments.length, 11);
    const plans = matrix.assignments.map((a) => assign(matrix, catalog, a));
    assert.equal(plans.filter((p) => p.slots.reviewer.modelId).length, 11);
  });
});

describe('INV-1', () => {
  it('같은 벤더 쌍을 만들려는 시도는 실패한다', () => {
    const openaiPair = () =>
      crossVendorPair(
        matrix,
        { model: 'sol', label: 'Sol', effort: 'high', engine: 'codex', modelId: 'gpt-5.6-sol', role: 'primary' },
        { model: 'astra', label: 'Astra', effort: 'max', engine: 'codex', modelId: 'gpt-6-astra', role: 'reviewer' },
      );
    assert.throws(openaiPair, AssignError);
    assert.throws(openaiPair, /INV-1 위반/);
  });

  it('교차 벤더 쌍은 통과한다', () => {
    assert.ok(
      crossVendorPair(
        matrix,
        { model: 'sol', label: 'Sol', effort: 'high', engine: 'codex', modelId: 'gpt-5.6-sol', role: 'primary' },
        { model: 'opus', label: 'Opus', effort: 'high', engine: 'claude', modelId: 'claude-opus-5', role: 'reviewer' },
      ),
    );
  });
});

describe('Gatekeeper', () => {
  it('하한선 6개를 전부 알고 있다', () => {
    assert.equal(GATE_CHECKS.length, 6);
    assert.equal(evaluateGate({}).kind, 'delegate');
  });

  for (const check of GATE_CHECKS) {
    it(`${check} 하나만 걸려도 배정하지 않는다`, () => {
      const result = route(matrix, catalog, '이 아키텍처 설계 검토해줘', { gate: { [check]: true } });
      assert.equal(result.stage, 'direct');
      assert.deepEqual(result.stage === 'direct' ? result.tripped : [], [check]);
    });
  }

  it('하한선이 배정보다 먼저다 — 배정이 터질 카탈로그로도 direct 가 나온다', () => {
    // 모델이 비어 있는 카탈로그. Assigner 가 먼저 돌았다면 반드시 던진다.
    const broken = { ...catalog, models: {} } as unknown as Engines;
    const result = route(matrix, broken, '이 아키텍처 설계 검토해줘', { gate: { irreversibleChange: true } });
    assert.equal(result.stage, 'direct');
    // 같은 카탈로그로 하한선 없이 돌리면 실제로 터진다 — 위 통과가 우연이 아님을 보인다.
    assert.throws(() => route(matrix, broken, '이 아키텍처 설계 검토해줘'));
  });
});

describe('"해당 없음"', () => {
  it('기본 배정을 만들지 않고 사용자에게 올린다', () => {
    const result = route(matrix, catalog, '오늘 점심 뭐 먹지');
    assert.equal(result.stage, 'unclassified');
  });
});

describe('배정 근거 표기', () => {
  it('taskId 를 누가 정했는지 구분한다 — LLM 이 정한 것을 "수동 지정"이라 쓰지 않는다', () => {
    const manual = route(matrix, catalog, '', { taskId: 'R05' });
    const llm = route(matrix, catalog, '', { taskId: 'R05', reasonLabel: 'Haiku·low 분류' });
    assert.equal(manual.stage === 'assigned' ? manual.reason : '', '수동 지정 R05');
    assert.equal(llm.stage === 'assigned' ? llm.reason : '', 'Haiku·low 분류 R05');
  });
});

/**
 * 폴백은 **Core 에 있다** — CLI·TUI·GUI 가 같은 함수를 쓴다 (D-026).
 * S9 에서 CLI 에만 있어 같은 입력이 셸마다 다르게 동작했고, 그것을 여기서 막는다.
 */
describe('routeWithFallback (D-026)', () => {
  const originalPath = process.env['PATH'] ?? '';
  after(() => { process.env['PATH'] = originalPath; });

  it('규칙으로 붙으면 폴백을 아예 시작하지 않는다 — 공짜 경로가 유료가 되면 안 된다', async () => {
    const r = await routeWithFallback(matrix, catalog, '이 타입 에러 고쳐줘');
    assert.equal(r.result.stage, 'assigned');
    assert.equal(r.fallback, null);
  });

  it('classifyLlm: false 면 미분류여도 폴백이 없다', async () => {
    const r = await routeWithFallback(matrix, catalog, '오늘 점심 뭐 먹지', { classifyLlm: false });
    assert.equal(r.result.stage, 'unclassified');
    assert.equal(r.fallback, null);
  });

  it('폴백이 실패해도 던지지 않고 사유를 올린다 — 삼키지도, 죽지도 않는다', async () => {
    // PATH 를 비우면 분류용 바이너리 해석이 실패한다. 진짜 엔진을 띄우지 않으므로 돈이 안 든다.
    process.env['PATH'] = '';
    const r = await routeWithFallback(matrix, catalog, '오늘 점심 뭐 먹지');
    process.env['PATH'] = originalPath;
    assert.equal(r.result.stage, 'unclassified');
    assert.equal(r.fallback?.outcome, 'failed');
    assert.match(r.fallback?.line ?? '', /\+\$0\.001/, '유료 호출 시도는 비용 표기와 함께 알려야 한다.');
    assert.match(r.fallback?.line ?? '', /시도하지 못했다/);
  });
});
