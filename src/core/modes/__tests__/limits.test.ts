/**
 * **정상 완료보다 상한 경로를 먼저 검증한다** (PLAN S4 완료 판정).
 * 무한 루프는 비용이 직접 나간다 — 상한 없는 방식은 머지하지 않는다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMatrix } from '../../../data/matrix.ts';
import { loadEngines } from '../../../data/engines.ts';
import { loadLimits } from '../../../data/limits.ts';
import { assign, type AssignmentPlan } from '../../assign.ts';
import { BudgetExceeded, TokenBudgetExceeded } from '../../budget.ts';
import type { SlotExecutor } from '../../executor.ts';
import { PingpongSession } from '../pingpong.ts';
import { runLoop } from '../loop.ts';
import { GraphError, runGraph, topoSort, type GraphNode } from '../graph.ts';

const matrix = loadMatrix();
const catalog = loadEngines();
const limits = loadLimits();

const row = (id: string) => matrix.assignments.find((a) => a.id === id) as (typeof matrix.assignments)[number];
/** R10 = Fable($7.63) + Astra($3.26). 두 사이클이면 $20 상한에 닿는다 (D-017). */
const planR10 = assign(matrix, catalog, row('R10'));

/**
 * 금액 상한은 **청구되는 요금제에서만** 의미가 있다 (D-030).
 * 기본 카탈로그는 세 엔진 전부 구독제라, 금액으로 막히는지 보려면 api 로 바꿔야 한다.
 */
const asApi = (p: AssignmentPlan): AssignmentPlan => ({
  ...p,
  slots: { ...p.slots, primary: { ...p.slots.primary, plan: 'api' }, reviewer: { ...p.slots.reviewer, plan: 'api' } },
});
/** R01 = Luna($0.18) + Haiku($0.21). 싸서 반복 상한이 먼저 걸린다. */
const planR01 = assign(matrix, catalog, row('R01'));

let calls = 0;
const fakeExec: SlotExecutor = (_slot, prompt) => {
  calls += 1;
  return Promise.resolve({ ok: true, text: `ran:${prompt}`, rawStdout: '', rawStderr: '', durationMs: 1 });
};
/** 호출마다 1,000 토큰을 보고한다 — 구독제에서 실제로 닳는 자원이 이것이다 (D-030). */
const countingExec: SlotExecutor = (_slot, prompt) => {
  calls += 1;
  return Promise.resolve({
    ok: true, text: `ran:${prompt}`, rawStdout: '', rawStderr: '', durationMs: 1,
    usage: { inputTokens: 900, outputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0 },
  });
};
const failingExec: SlotExecutor = () =>
  Promise.resolve({ ok: false, text: 'boom', rawStdout: '', rawStderr: 'boom', durationMs: 1 });

describe('기본 상한값', () => {
  it('limits.json 의 기본 누적 비용 상한은 $20 이다 (D-017)', () => {
    assert.equal(limits.budgetUsd, 20);
    assert.ok(limits.maxIterations >= 1 && limits.maxNodes >= 1);
  });

  it('최고 조합 2사이클이면 상한에 닿는다 — 이 값이 $20 을 고른 이유다', () => {
    assert.equal(planR10.cost.totalUsd, 10.89);
    assert.ok(planR10.cost.totalUsd * 2 >= limits.budgetUsd);
  });
});

describe('/pingpong — 비용 상한 (턴 상한은 없다, D-015)', () => {
  it('상한에 닿으면 다음 턴을 시작하지 않는다', async () => {
    const session = new PingpongSession(matrix, asApi(planR10), fakeExec, limits.budgetUsd);
    await session.turn({ prompt: 'a', side: 'primary' }); // $7.63
    await session.turn({ prompt: 'b', side: 'reviewer' }); // +$3.26 = $10.89
    await session.turn({ prompt: 'c', side: 'primary' }); // +$7.63 = $18.52
    await session.turn({ prompt: 'd', side: 'reviewer' }); // +$3.26 = $21.78 > $20

    assert.equal(session.budget.exceeded(), true);
    await assert.rejects(() => session.turn({ prompt: 'e', side: 'primary' }), BudgetExceeded);
    assert.equal(session.turnCount, 4, '상한 초과 턴은 시작조차 하지 않아야 한다');
  });

  it('구독제에서는 토큰 상한이 턴을 멈춘다 — 금액 상한은 걸리지 않는다', async () => {
    // 기본 카탈로그(전부 구독제) 그대로. 금액은 넉넉하고 토큰만 빡빡하다.
    const session = new PingpongSession(matrix, planR10, countingExec, 1000, 2500);
    await session.turn({ prompt: 'a', side: 'primary' });   // 1,000
    await session.turn({ prompt: 'b', side: 'reviewer' });  // 2,000
    await session.turn({ prompt: 'c', side: 'primary' });   // 3,000 > 2,500

    assert.equal(session.budget.exceeded(), false, '구독제 금액은 아무것도 막지 않는다');
    assert.equal(session.budget.tokensExceeded(), true);
    await assert.rejects(() => session.turn({ prompt: 'd', side: 'reviewer' }), TokenBudgetExceeded);
    assert.equal(session.turnCount, 3, '상한 초과 턴은 시작조차 하지 않아야 한다');
  });

  it('턴 수 자체에는 상한이 없다 — 사용자 승인이 그 자리를 대신한다', async () => {
    const session = new PingpongSession(matrix, planR01, fakeExec, limits.budgetUsd);
    for (let i = 0; i < 20; i += 1) await session.turn({ prompt: `t${i}`, side: 'primary' });
    assert.equal(session.turnCount, 20);
    assert.equal(session.budget.exceeded(), false);
  });

  it('자동으로 슬롯을 교대하지 않는다 — 제안만 하고 멈춘다', async () => {
    const session = new PingpongSession(matrix, asApi(planR10), fakeExec, limits.budgetUsd);
    const turn = await session.turn({ prompt: 'a', side: 'primary' });
    assert.match(turn.suggestion, /Astra/);
    assert.equal(session.turnCount, 1);
  });
});

describe('/loop — 반복 상한과 비용 상한', () => {
  const components = {
    plan: () => 'work',
    evaluate: () => ({ passed: true, verification: 'exit code 0' }),
    stop: () => false, // 절대 끝나지 않는 루프
  };

  it('최대 반복 수에서 정상 중단된다', async () => {
    const result = await runLoop(matrix, planR01, fakeExec, components, {
      goal: 'g', maxIterations: 3, budgetUsd: limits.budgetUsd,
    });
    assert.equal(result.stopReason, 'max-iterations');
    assert.equal(result.iterations, 3);
    assert.equal(result.journal.records.length, 3);
  });

  it('반복 상한 전에 비용 상한이 걸리면 그쪽에서 멈춘다', async () => {
    const result = await runLoop(matrix, asApi(planR10), fakeExec, components, {
      goal: 'g', maxIterations: 100, budgetUsd: limits.budgetUsd,
    });
    assert.equal(result.stopReason, 'budget-exceeded');
    assert.ok(result.iterations < 100);
    assert.ok(result.budget.spentUsd >= limits.budgetUsd);
  });

  it('구독제에서는 토큰 상한이 반복을 멈춘다 — 예외로 죽지 않고 정상 중단이다', async () => {
    const result = await runLoop(matrix, planR10, countingExec, components, {
      goal: 'g', maxIterations: 100, budgetUsd: 1000, tokenBudget: 2500,
    });
    assert.equal(result.stopReason, 'budget-exceeded');
    assert.ok(result.iterations < 100, '반복 상한이 아니라 토큰 상한에서 멈춰야 한다');
    assert.equal(result.budget.exceeded(), false, '구독제 금액은 아무것도 막지 않는다');
    assert.equal(result.budget.tokensExceeded(), true);
  });

  it('최대 반복 수가 없으면 아예 돌지 않는다', async () => {
    await assert.rejects(
      () => runLoop(matrix, planR01, fakeExec, components, { goal: 'g', maxIterations: 0, budgetUsd: 20 }),
      /최대 반복 수 없이는/,
    );
  });

  it('Evaluator 에는 reviewer 슬롯이 과금된다 (자기 채점 방지, D-003)', async () => {
    const result = await runLoop(matrix, planR10, fakeExec, components, {
      goal: 'g', maxIterations: 1, budgetUsd: 100,
    });
    const labels = result.budget.charges.map((c) => c.label);
    assert.ok(labels.some((l) => l.includes('Executor') && l.includes('Fable')));
    assert.ok(labels.some((l) => l.includes('Evaluator') && l.includes('Astra')));
  });

  it('검증에 실패하면 기본은 중단이다 — 검증 없이 다음 사이클로 넘어가지 않는다', async () => {
    const result = await runLoop(
      matrix, planR01, failingExec,
      { plan: () => 'work', evaluate: () => ({ passed: false, verification: 'exit code 1' }) },
      { goal: 'g', maxIterations: 5, budgetUsd: 20 },
    );
    assert.equal(result.stopReason, 'aborted');
    assert.equal(result.iterations, 1);
  });
});

describe('/graph — 순환·노드 상한·비용 상한', () => {
  const node = (id: string, deps: string[], writes: string[], onFailure: GraphNode['onFailure'] = 'skip-dependents'): GraphNode => ({
    id, prompt: id, plan: planR01, dependsOn: deps, writes, onFailure,
  });

  it('순환이면 한 노드도 실행하지 않는다', async () => {
    const cyclic = [node('a', ['c'], ['x']), node('b', ['a'], ['y']), node('c', ['b'], ['z'])];
    assert.throws(() => topoSort(cyclic), GraphError);
    const before = calls;
    await assert.rejects(() => runGraph(matrix, cyclic, fakeExec, { maxNodes: 10, budgetUsd: 20 }), /순환을 검출했다/);
    assert.equal(calls, before, '순환 검출 후 실행된 노드가 있다');
  });

  it('최대 노드 수를 넘으면 실행 전에 던진다', async () => {
    const many = Array.from({ length: 5 }, (_, i) => node(`n${i}`, [], [`f${i}`]));
    await assert.rejects(() => runGraph(matrix, many, fakeExec, { maxNodes: 4, budgetUsd: 20 }), /최대 노드 수 초과/);
  });

  it('비용 상한에 닿으면 남은 노드를 시작하지 않는다', async () => {
    const expensive = Array.from({ length: 6 }, (_, i) => ({ ...node(`n${i}`, [], [`f${i}`]), plan: planR10 }));
    const result = await runGraph(matrix, expensive, fakeExec, { maxNodes: 10, budgetUsd: 20 });
    assert.equal(result.stopReason, 'budget-exceeded');
    assert.ok(result.journal.records.length < 6);
  });

  it('병렬 묶음도 사전 추정으로 잘린다 — 상한을 넘겨 동시에 띄우지 않는다', async () => {
    // 쓰기 대상이 전부 달라 6개가 한 묶음이 된다. 자르지 않으면 Fable 6개 = $45.78 가 동시에 뜬다.
    const expensive = Array.from({ length: 6 }, (_, i) => ({ ...node(`n${i}`, [], [`f${i}`]), plan: planR10 }));
    const result = await runGraph(matrix, expensive, fakeExec, { maxNodes: 10, budgetUsd: 20 });
    assert.equal(result.batches.length, 1);
    assert.ok(result.batches[0]!.length <= 3, `묶음이 잘리지 않았다: ${result.batches[0]?.length}개`);
    assert.ok(result.budget.spentUsd < 45, `상한을 크게 넘겼다: $${result.budget.spentUsd}`);
  });
});

describe('/graph — 병렬 판정과 실패 전파', () => {
  const node = (id: string, deps: string[], writes: string[], onFailure: GraphNode['onFailure'] = 'skip-dependents'): GraphNode => ({
    id, prompt: id, plan: planR01, dependsOn: deps, writes, onFailure,
  });

  it('쓰기 대상이 안 겹치면 한 묶음으로 병렬이다', async () => {
    const r = await runGraph(matrix, [node('a', [], ['x']), node('b', [], ['y'])], fakeExec, { maxNodes: 9, budgetUsd: 20 });
    assert.deepEqual(r.batches, [['a', 'b']]);
  });

  it('쓰기 대상이 겹치면 순차로 떨어진다', async () => {
    const r = await runGraph(matrix, [node('a', [], ['x']), node('b', [], ['x'])], fakeExec, { maxNodes: 9, budgetUsd: 20 });
    assert.deepEqual(r.batches, [['a'], ['b']]);
  });

  it('쓰기 대상을 선언하지 않은 노드는 "모른다"로 보고 순차로 떨어진다', async () => {
    const r = await runGraph(matrix, [node('a', [], []), node('b', [], ['y'])], fakeExec, { maxNodes: 9, budgetUsd: 20 });
    assert.deepEqual(r.batches, [['a'], ['b']]);
  });

  it('skip-dependents 는 후속만 건너뛴다', async () => {
    const nodes = [node('a', [], ['x']), node('b', ['a'], ['y']), node('c', [], ['z'])];
    const r = await runGraph(matrix, nodes, failingExec, { maxNodes: 9, budgetUsd: 20 });
    assert.deepEqual(r.skipped, ['b']);
    assert.equal(r.stopReason, 'completed');
  });

  it('fail-fast 는 뒤따르는 노드를 전부 중단시킨다', async () => {
    const nodes = [node('a', [], ['x'], 'fail-fast'), node('b', ['a'], ['y'])];
    const r = await runGraph(matrix, nodes, failingExec, { maxNodes: 9, budgetUsd: 20 });
    assert.equal(r.stopReason, 'failed-fast');
    assert.equal(r.journal.records.length, 1);
  });

  it('continue 는 실패해도 후속을 막지 않는다', async () => {
    const nodes = [node('a', [], ['x'], 'continue'), node('b', ['a'], ['y'])];
    const r = await runGraph(matrix, nodes, failingExec, { maxNodes: 9, budgetUsd: 20 });
    assert.deepEqual(r.skipped, []);
    assert.equal(r.journal.records.length, 2);
  });
});
