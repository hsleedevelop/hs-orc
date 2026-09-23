/**
 * 대화 세션 (SPEC §6.4). 실행기는 전부 가짜다 — 이 파일이 돈을 쓰면 아무도 안 돌린다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { Budget } from '../budget.ts';
import { Journal } from '../journal.ts';
import type { SlotExecutor, SlotRun } from '../executor.ts';
import { ConversationSession, SessionStateError } from '../session.ts';

const matrix = loadMatrix();
const catalog = loadEngines();
const reply = (text: string, ok = true): SlotRun => ({ ok, text, rawStdout: '', rawStderr: '', durationMs: 1 });

/** 지휘자 가짜: 요약 요청이면 요약을, 아니면 직접 답을 준다. */
const conductSpy = (direct = '저는 hs-orc 입니다.\nSUGGEST: NONE', ok = true) => {
  const prompts: string[] = [];
  const exec: SlotExecutor = (_slot, prompt) => {
    prompts.push(prompt);
    return Promise.resolve(reply(prompt.startsWith('아래 위임 결과') ? '요약 한 줄' : direct, ok));
  };
  return { exec, prompts };
};

/** 위임 가짜: reviewer(Haiku) 는 PASS, primary 는 받은 프롬프트를 되돌린다. */
const delegateSpy = () => {
  const calls: { label: string; prompt: string }[] = [];
  const exec: SlotExecutor = (slot, prompt) => {
    calls.push({ label: slot.label, prompt });
    return Promise.resolve(reply(slot.label === 'Haiku' ? 'PASS' : `ran:${prompt}`));
  };
  return { exec, calls };
};

const make = (conduct: SlotExecutor, dir = mkdtempSync(path.join(os.tmpdir(), 'hs-session-')), execute = delegateSpy().exec) => {
  const budget = new Budget(20, 2_000_000);
  const session = new ConversationSession({
    matrix, catalog, kind: 'project', dir, id: '0923-1200-aaa',
    budget, journal: new Journal(), conduct, executorFor: () => execute, classifyLlm: false,
  });
  return { session, budget, dir };
};

describe('대화 세션 — 메시지 1건 (SPEC §6.4.2)', () => {
  it('분류되는 메시지는 배정을 남기고 승인 대기로 멈춘다 — 지휘자를 부르지 않는다', async () => {
    const c = conductSpy();
    const { session } = make(c.exec);
    const out = await session.send('이 타입 에러 고쳐줘');
    assert.deepEqual(out.map((r) => r.kind), ['user', 'plan']);
    const plan = out[1];
    assert.ok(plan?.kind === 'plan' && /^R\d{2}$/.test(plan.taskId));
    assert.equal(session.state, 'blocked');
    assert.equal(c.prompts.length, 0);
  });

  it('분류되지 않는 메시지는 지휘자가 직접 답하고 비용을 남긴다 — 승인 없이', async () => {
    const c = conductSpy();
    const { session, budget } = make(c.exec);
    const out = await session.send('넌 누구니');
    assert.deepEqual(out.map((r) => r.kind), ['user', 'direct']);
    const direct = out[1];
    assert.ok(direct?.kind === 'direct');
    assert.equal(direct.text, '저는 hs-orc 입니다.');
    assert.equal(direct.suggest, null);
    assert.equal(session.state, 'waiting_input');
    assert.equal(budget.charges[0]?.label, '지휘자·Haiku·low');
  });

  it('제안된 행을 고르면 같은 메시지로 배정을 받는다 — 새 메시지를 만들지 않는다', async () => {
    const c = conductSpy('타입 수정 요청으로 보인다.\nSUGGEST: R01');
    const { session } = make(c.exec);
    const first = await session.send('넌 누구니');
    assert.ok(first[1]?.kind === 'direct' && first[1].suggest === 'R01');
    const out = await session.planAs('R01');
    assert.deepEqual(out.map((r) => r.kind), ['plan']);
    assert.ok(out[0]?.kind === 'plan' && out[0].taskId === 'R01');
    assert.equal(session.records().filter((r) => r.kind === 'user').length, 1);
    assert.equal(session.state, 'blocked');
  });

  it('직접 답이 실패하면 사유를 남기고 입력 대기로 돌아간다 — 조용히 삼키지 않는다', async () => {
    const { session } = make(conductSpy('', false).exec);
    const out = await session.send('넌 누구니');
    assert.deepEqual(out.map((r) => r.kind), ['user', 'error']);
    assert.equal(session.state, 'waiting_input');
  });

  it('승인 대기 중에는 새 메시지를 받지 않는다', async () => {
    const { session } = make(conductSpy().exec);
    await session.send('이 타입 에러 고쳐줘');
    await assert.rejects(session.send('또'), SessionStateError);
  });

  it('다음 직접 답에 앞 턴 대화를 싣는다 (G7)', async () => {
    const c = conductSpy();
    const { session } = make(c.exec);
    await session.send('넌 누구니');
    await session.send('뭘 할 수 있어');
    assert.match(c.prompts[1] ?? '', /\[최근 대화\]\n사용자: 넌 누구니\norc: 저는 hs-orc 입니다\./);
    assert.doesNotMatch(c.prompts[1] ?? '', /\[최근 대화\][^[]*뭘 할 수 있어/);
  });

  it('다시 열면 턴을 이어 가고, 남은 배정은 되살리지 않는다', async () => {
    const c = conductSpy();
    const { dir } = make(c.exec);
    const first = make(c.exec, dir).session;
    await first.send('이 타입 에러 고쳐줘');
    const reopened = make(c.exec, dir).session;
    assert.equal(reopened.state, 'waiting_input');
    await reopened.send('넌 누구니');
    assert.equal(reopened.records().at(-1)?.turn, 2);
  });
});
