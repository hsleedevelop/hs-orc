/**
 * **기본 경로에서 두 슬롯이 실제로 도는지**를 고정한다 (D-009).
 * 배정에 reviewer 가 있는지만 보던 기존 테스트는 실행까지 도달하는지 못 봤고,
 * 그래서 157개가 통과하는 동안 reviewer 가 한 번도 안 도는 구멍이 남아 있었다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { assign } from '../assign.ts';
import { Budget } from '../budget.ts';
import type { SlotExecutor } from '../executor.ts';
import { parseVerdict, reviewPrompt, runDuo } from '../duo.ts';

const matrix = loadMatrix();
const catalog = loadEngines();
const row = (id: string) => matrix.assignments.find((a) => a.id === id)!;
const planR01 = assign(matrix, catalog, row('R01'));   // Luna $0.18 + Haiku $0.21
const planR10 = assign(matrix, catalog, row('R10'));   // Fable $7.63 + Astra $3.26

/** 슬롯별 호출을 기록하는 실행기 — "누가 돌았나"가 이 파일의 관심사다. */
const spy = (reply: (label: string) => { ok: boolean; text: string }) => {
  const calls: { label: string; prompt: string }[] = [];
  const exec: SlotExecutor = (slot, prompt) => {
    calls.push({ label: slot.label, prompt });
    return Promise.resolve({ ...reply(slot.label), rawStdout: '', rawStderr: '', durationMs: 1 });
  };
  return { calls, exec };
};

describe('두 슬롯 실행 (D-009)', () => {
  it('기본 경로가 primary 와 reviewer 를 **둘 다** 띄운다', async () => {
    const { calls, exec } = spy((l) => ({ ok: true, text: l === 'Luna' ? '산출물' : '누락 없음\nPASS' }));
    const duo = await runDuo(matrix, planR01, exec, '타입 고쳐줘', new Budget(20));

    assert.deepEqual(calls.map((c) => c.label), ['Luna', 'Haiku']);
    assert.equal(duo.verdict, 'pass');
    assert.ok(duo.review);
  });

  it('reviewer 는 작업을 다시 하지 않고 산출물을 받는다', async () => {
    const { calls, exec } = spy(() => ({ ok: true, text: 'PASS' }));
    await runDuo(matrix, planR01, exec, '타입 고쳐줘', new Budget(20));

    const review = calls[1]?.prompt ?? '';
    assert.match(review, /독립 검증자다/);
    assert.match(review, /이 작업을 다시 수행하지 말고/);
    assert.match(review, /운영 기준\(완료의 정의\): 빠르게 수정하고 기존 test만 실행/);
  });

  it('reviewer 판정이 R11 의 `독립 리뷰 결과` 증거가 된다', async () => {
    // R11 은 primary Astra · reviewer Fable 이다.
    const { exec } = spy((l) => ({ ok: true, text: l === 'Fable' ? 'FAIL' : '산출물' }));
    const duo = await runDuo(matrix, assign(matrix, catalog, row('R11')), exec, '배포 검토', new Budget(20));
    const [evidence] = duo.evidence;
    assert.equal(evidence?.kind, 'review');
    assert.equal(evidence?.kind === 'review' ? evidence.verdict : '', 'fail');
  });

  it('두 슬롯 비용이 모두 과금된다 — 표시만 두 슬롯이고 청구는 하나이면 안 된다', async () => {
    const { exec } = spy(() => ({ ok: true, text: 'PASS' }));
    const budget = new Budget(20);
    await runDuo(matrix, planR01, exec, 't', budget);
    assert.deepEqual(budget.charges.map((c) => c.label), ['Luna·medium', 'Haiku·low']);
    assert.equal(budget.spentUsd, 0.39);
  });
});

describe('reviewer 를 돌리지 않는 경우', () => {
  it('primary 가 실패하면 reviewer 를 띄우지 않는다 — 검증할 산출물이 없다', async () => {
    const { calls, exec } = spy(() => ({ ok: false, text: 'boom' }));
    const duo = await runDuo(matrix, planR01, exec, 't', new Budget(20));
    assert.deepEqual(calls.map((c) => c.label), ['Luna']);
    assert.equal(duo.review, null);
    assert.equal(duo.verdict, 'unknown');
  });

  it('primary 만으로 비용 상한을 넘기면 reviewer 를 시작하지 않는다', async () => {
    const { calls, exec } = spy(() => ({ ok: true, text: 'PASS' }));
    // Fable $7.63 하나로 이미 상한 $5 초과.
    const duo = await runDuo(matrix, planR10, exec, 't', new Budget(5));
    assert.deepEqual(calls.map((c) => c.label), ['Fable']);
    assert.equal(duo.review, null);
  });

  it('--no-reviewer 로 끄면 끈 것이지 통과가 아니다', async () => {
    const { calls, exec } = spy(() => ({ ok: true, text: 'PASS' }));
    const duo = await runDuo(matrix, planR01, exec, 't', new Budget(20), { skipReviewer: true });
    assert.deepEqual(calls.map((c) => c.label), ['Luna']);
    assert.equal(duo.verdict, 'unknown');
    assert.deepEqual(duo.evidence, []);
  });
});

describe('판정 읽기', () => {
  it('마지막 줄의 PASS/FAIL 만 본다', () => {
    assert.equal(parseVerdict('누락 없음\nPASS'), 'pass');
    assert.equal(parseVerdict('테스트가 없다\nFAIL'), 'fail');
  });

  it('본문에 PASS 가 있어도 마지막이 FAIL 이면 FAIL 이다', () => {
    assert.equal(parseVerdict('PASS 라고 적혀 있지만 근거가 없다\nFAIL'), 'fail');
  });

  it('판정을 못 읽으면 unknown 이다 — pass 로 봐주지 않는다', () => {
    assert.equal(parseVerdict('전반적으로 잘 되었습니다.'), 'unknown');
    assert.equal(parseVerdict(''), 'unknown');
  });

  it('프롬프트가 산문 판정을 거부한다고 말한다', () => {
    assert.match(reviewPrompt(planR01, 't', 'o'), /"성공했습니다" 같은 산문은 판정이 아니다/);
  });
});
