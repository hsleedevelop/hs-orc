import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines, type Engines } from '../../data/engines.ts';
import { ClassifyError, classify } from '../classify.ts';
import { AssignError, assign, crossVendorPair } from '../assign.ts';
import { GATE_CHECKS, evaluateGate } from '../gatekeeper.ts';
import { route, routeWithFallback } from '../pipeline.ts';
import { Budget } from '../budget.ts';
import { parseGraphSpec, type GraphSpec } from '../modes/graph.ts';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
        { model: 'sol', label: 'Sol', effort: 'high', engine: 'codex', modelId: 'gpt-5.6-sol', role: 'primary', plan: 'subscription' },
        { model: 'astra', label: 'Astra', effort: 'max', engine: 'codex', modelId: 'gpt-6-astra', role: 'reviewer', plan: 'subscription' },
      );
    assert.throws(openaiPair, AssignError);
    assert.throws(openaiPair, /INV-1 위반/);
  });

  it('교차 벤더 쌍은 통과한다', () => {
    assert.ok(
      crossVendorPair(
        matrix,
        { model: 'sol', label: 'Sol', effort: 'high', engine: 'codex', modelId: 'gpt-5.6-sol', role: 'primary', plan: 'subscription' },
        { model: 'opus', label: 'Opus', effort: 'high', engine: 'claude', modelId: 'claude-opus-5', role: 'reviewer', plan: 'subscription' },
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
    // 실행조차 못 했으니 비용을 지어내지 않는다 (D-034) — 추정 문구("+$0.001 내외")를 되살리지 않는다.
    assert.match(r.fallback?.line ?? '', /비용 보고 없음/, '돈 정보가 없다는 사실 자체를 감추면 안 된다.');
    assert.match(r.fallback?.line ?? '', /시도하지 못했다/);
  });
});

/**
 * D-034: 분류 폴백은 **받은 예산에 과금**하고 **실제 금액**을 찍는다.
 * 예산이 이미 상한이면 폴백을 시작조차 하지 않는다 — 유료 호출을 조용히 더 태우지 않는다.
 */
describe('routeWithFallback — 예산 과금 (D-034)', () => {
  const originalPath = process.env['PATH'] ?? '';
  after(() => { process.env['PATH'] = originalPath; });

  /** claude 스트림-json 한 줄로 실측 비용·토큰을 함께 돌려주는 가짜 바이너리. */
  const fakeClaudeBinary = (dir: string, id: string, marker?: string): void => {
    const bin = path.join(dir, 'claude');
    const markerLine = marker ? [`touch "${marker}"`] : [];
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        ...markerLine,
        `printf '{"type":"result","is_error":false,"result":"%s","total_cost_usd":0.015,"usage":{"input_tokens":900,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}\\n' "${id}"`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(bin, 0o755);
  };

  it('분류 폴백이 돌면 실측 비용을 받은 예산에 정확히 한 번 과금하고 토큰을 센다', async () => {
    const here = mkdtempSync(path.join(os.tmpdir(), 'hs-classify-charge-'));
    fakeClaudeBinary(here, 'R02');
    process.env['PATH'] = `${here}${path.delimiter}${originalPath}`;
    try {
      const budget = new Budget(20);
      const r = await routeWithFallback(matrix, catalog, '오늘 점심 뭐 먹지', { budget });
      assert.equal(budget.charges.length, 1);
      const charge = budget.charges[0];
      assert.match(charge?.label ?? '', /^분류·Haiku·low$/);
      assert.equal(charge?.source, 'actual');
      assert.equal(charge?.usd, 0.015);
      assert.equal(budget.spentTokens, 1000);
      assert.match(r.fallback?.line ?? '', /\$/);
      assert.match(r.fallback?.line ?? '', /actual/);
      assert.doesNotMatch(r.fallback?.line ?? '', /내외/);
    } finally {
      process.env['PATH'] = originalPath;
    }
  });

  it('예산이 이미 상한이면 폴백을 시작하지 않는다 — 가짜 바이너리도 뜨지 않는다', async () => {
    const here = mkdtempSync(path.join(os.tmpdir(), 'hs-classify-skip-'));
    const marker = path.join(here, 'spawned');
    fakeClaudeBinary(here, 'R02', marker);
    process.env['PATH'] = `${here}${path.delimiter}${originalPath}`;
    try {
      const budget = new Budget(0); // 상한 $0 — 이미 닿아 있다.
      const r = await routeWithFallback(matrix, catalog, '오늘 점심 뭐 먹지', { budget });
      assert.equal(r.fallback?.outcome, 'skipped');
      assert.equal(budget.charges.length, 0);
      assert.equal(existsSync(marker), false, '이미 상한인데 가짜 바이너리가 떴다 — 폴백이 시작됐다는 뜻이다.');
    } finally {
      process.env['PATH'] = originalPath;
    }
  });
});

/**
 * 커밋된 그래프 예제가 **실제로 파싱되는지** 본다.
 * 형식이 usage 줄에만 있고 예제가 없으면, 문서가 틀려도 아무도 모른다(PLAN S9 후속).
 */
describe('examples/graph-nodes.json', () => {
  const spec = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'examples', 'graph-nodes.json'), 'utf8'),
  ) as GraphSpec;

  it('예제가 그대로 파싱되고 노드마다 독립 배정된다', () => {
    const nodes = parseGraphSpec(matrix, catalog, spec);
    assert.equal(nodes.length, 3);
    assert.deepEqual(nodes.map((n) => n.id), ['survey', 'types', 'docs']);
    // R02 와 R01 은 다른 모델로 간다 — 한 그래프에서 모델이 섞인다는 것이 §6.3 의 요점이다.
    assert.notEqual(nodes[0]?.plan.slots.primary.model, nodes[1]?.plan.slots.primary.model);
  });

  it('선언을 생략한 자리는 문서가 말한 기본값으로 채워진다', () => {
    const nodes = parseGraphSpec(matrix, catalog, spec);
    assert.deepEqual(nodes[0]?.dependsOn, []);
    assert.equal(nodes[1]?.onFailure, 'skip-dependents');
  });

  it('없는 업무 행을 가리키면 던진다 — 조용히 아무 행이나 고르지 않는다', () => {
    assert.throws(
      () => parseGraphSpec(matrix, catalog, { nodes: [{ id: 'x', prompt: 'p', task: 'R99' }] }),
      /그런 업무 행이 없다/,
    );
  });

  it('id 가 겹치면 던진다 — 의존성 그래프가 말이 안 된다', () => {
    assert.throws(
      () => parseGraphSpec(matrix, catalog, { nodes: [{ id: 'a', prompt: 'p', task: 'R01' }, { id: 'a', prompt: 'q', task: 'R02' }] }),
      /노드 id 가 겹친다/,
    );
  });
});
