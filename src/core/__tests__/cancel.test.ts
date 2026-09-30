/**
 * 도는 위임의 취소 (D-066). 실행기는 전부 **느린 가짜**다 — 신호가 서면 취소된 실행을 돌려주고, 아니면 풀어 줄 때까지 안 끝난다.
 * 진짜 프로세스 그룹 종료는 `executor.test.ts` 가 가짜 바이너리로 본다.
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
import type { SlotExecutor, SlotRun, SlotRunOptions } from '../executor.ts';
import { ConversationSession } from '../session.ts';
import { readDecisions } from '../decision-log.ts';

const isolate = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-cancel-'));
  process.env['HS_ORC_DECISION_LOG'] = path.join(dir, 'log.jsonl');
  process.env['HS_ORC_RUN_STORE'] = path.join(dir, 'runs');
};

const matrix = loadMatrix();
const catalog = loadEngines();
const done = (text: string, extra: Partial<SlotRun> = {}): SlotRun => ({ ok: true, text, rawStdout: '', rawStderr: '', durationMs: 1, ...extra });
const killed = (extra: Partial<SlotRun> = {}): SlotRun => ({ ok: false, cancelled: true, text: '', rawStdout: '', rawStderr: '', durationMs: 1, ...extra });
const tick = () => new Promise<void>((r) => setImmediate(r));
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i += 1) await tick();
  assert.ok(cond(), '조건이 오지 않았다');
};

/**
 * 슬롯 역할별로 "멈춰 서는" 가짜. `hang` 에 든 역할은 신호가 서면 `killed(...)` 로 끝나고, 아니면 `release()` 까지 안 끝난다.
 * 나머지 역할은 곧바로 끝난다 (reviewer 는 PASS). 어느 역할이 어떤 options 로 시작됐는지 남긴다.
 */
const slowExec = (hang: readonly ('primary' | 'reviewer')[], partial: Partial<SlotRun> = {}, sessionId?: string) => {
  const calls: { role: string; options: SlotRunOptions | undefined }[] = [];
  let release: () => void = () => undefined;
  const exec: SlotExecutor = (slot, prompt, options) => {
    calls.push({ role: slot.role, options });
    if (!hang.includes(slot.role)) {
      return Promise.resolve(slot.role === 'reviewer' ? done('PASS') : done(`ran:${prompt}`, { ...(sessionId ? { sessionId } : {}), actualUsd: 0.2 }));
    }
    return new Promise<SlotRun>((resolve) => {
      options?.signal?.addEventListener('abort', () => resolve(killed(partial)), { once: true });
      release = () => resolve(done('늦게 끝남'));
    });
  };
  return { exec, calls, release: () => release() };
};

const make = (execute: SlotExecutor, conduct: SlotExecutor = () => Promise.resolve(done('요약 한 줄')), dir = mkdtempSync(path.join(os.tmpdir(), 'hs-cancel-s-'))) => {
  const budget = new Budget(20, 2_000_000);
  const session = new ConversationSession({ approvalMode: 'manual',
    matrix, catalog, kind: 'project', dir, id: '0929-1200-ccc',
    budget, journal: new Journal(), conduct, executorFor: () => execute,
  });
  return { session, budget, dir };
};

const kinds = (session: ConversationSession) => session.records().filter((r) => r.kind !== 'mode').map((r) => r.kind);
const lastDecision = () => readDecisions().at(-1);

describe('위임 취소 — primary 실행 중 (D-066)', () => {
  it('엔진에 취소 신호를 보내고 reviewer 를 띄우지 않는다 — 세션은 입력 대기로 남는다', async () => {
    isolate();
    const x = slowExec(['primary']);
    const { session } = make(x.exec);
    await session.send('이 타입 에러 고쳐줘');
    const running = session.approve();
    assert.equal(session.state, 'working');
    assert.equal(session.cancellable, true);

    assert.equal(session.cancel(), true);
    assert.equal(session.cancellable, false, '신호를 보낸 위임은 다시 취소 대상이 아니다');
    assert.equal(session.cancel(), false);
    const out = await running;

    assert.deepEqual(x.calls.map((c) => c.role), ['primary'], 'primary 중 취소면 reviewer 를 띄우지 않는다');
    assert.equal(x.calls[0]?.options?.signal?.aborted, true);
    assert.deepEqual(out.map((r) => r.kind), ['approval', 'result']);
    const result = out[1];
    assert.ok(result?.kind === 'result');
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.verdict, 'unknown');
    assert.match(result.evidence, /primary 실행 중/);
    assert.equal(session.state, 'waiting_input');
    assert.equal(session.cancellable, false);
    assert.equal(session.interrupted, false, '취소는 끊김이 아니다');
    assert.ok(!kinds(session).includes('summary'), '취소한 위임은 요약에 돈을 쓰지 않는다');
  });

  it('측정값이 없는 취소는 추정치를 물리지 않는다 — 못 본 토큰만 미보고로 센다', async () => {
    isolate();
    const { session, budget } = make(slowExec(['primary']).exec);
    await session.send('이 타입 에러 고쳐줘');
    const running = session.approve();
    session.cancel();
    await running;
    assert.equal(budget.charges.length, 0);
    assert.equal(budget.unreportedCycles, 1);
    const spend = session.records().at(-1);
    assert.ok(spend?.kind === 'spend' && spend.charges.length === 0 && spend.unreported === 1);
  });

  it('죽기 전에 받은 측정값은 센다 — actual 이 있으면 그만큼만', async () => {
    isolate();
    const { session, budget } = make(slowExec(['primary'], { actualUsd: 0.05, usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 0 } }).exec);
    await session.send('이 타입 에러 고쳐줘');
    const running = session.approve();
    session.cancel();
    await running;
    assert.deepEqual(budget.charges.map((c) => [c.usd, c.source]), [[0.05, 'actual']]);
    assert.equal(budget.spentTokens, 15);
    const spend = session.records().at(-1);
    assert.ok(spend?.kind === 'spend' && spend.charges[0]?.usd === 0.05 && spend.tokens === 15);
  });

  it('결정 로그는 같은 id 의 2차 줄이 status cancelled · outcome unverified 다', async () => {
    isolate();
    const { session } = make(slowExec(['primary']).exec);
    await session.send('이 타입 에러 고쳐줘');
    const running = session.approve();
    session.cancel();
    const out = await running;
    const result = out.find((r) => r.kind === 'result');
    assert.ok(result?.kind === 'result');
    const rows = readDecisions().filter((d) => d.id === result.decisionId);
    assert.deepEqual(rows.map((d) => [d.status, d.outcome]), [['decided', 'pending'], ['cancelled', 'unverified']]);
    assert.equal(rows[1]?.verified, '-');
    assert.match(rows[1]?.note ?? '', /취소\(primary 실행 중\)/);
  });

  it('쓰기를 켰으면 파일이 일부 바뀌었을 수 있다고 알린다', async () => {
    isolate();
    const { session } = make(slowExec(['primary']).exec);
    await session.send('이 타입 에러 고쳐줘');
    const running = session.approve({ write: true });
    session.cancel();
    const result = (await running)[1];
    assert.ok(result?.kind === 'result' && /파일이 일부 바뀌었을 수 있다/.test(result.evidence));
  });
});

describe('위임 취소 — reviewer 실행 중 (D-066)', () => {
  it('primary 는 끝났고 과금됐다 — reviewer 몫은 받은 만큼만, 판정은 지어내지 않는다', async () => {
    isolate();
    const x = slowExec(['reviewer'], { actualUsd: 0.03 });
    const { session, budget } = make(x.exec);
    await session.send('이 타입 에러 고쳐줘');
    const running = session.approve();
    await until(() => x.calls.some((c) => c.role === 'reviewer'));
    assert.equal(session.cancellable, true);
    session.cancel();
    const out = await running;

    const result = out.find((r) => r.kind === 'result');
    assert.ok(result?.kind === 'result');
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.verdict, 'unknown');
    assert.match(result.evidence, /reviewer 실행 중/);
    assert.equal(result.text.startsWith('ran:'), true, '끝난 primary 출력은 남긴다');
    assert.deepEqual(budget.charges.map((c) => c.usd), [0.2, 0.03]);
    assert.equal(lastDecision()?.status, 'cancelled');
    assert.match(lastDecision()?.note ?? '', /취소\(reviewer 실행 중\)/);
    assert.equal(session.state, 'waiting_input');
  });

  it('primary 가 끝나는 틈에 신호가 오면 reviewer 를 시작하지 않는다', async () => {
    isolate();
    const x = slowExec(['primary']);
    const { session } = make(x.exec);
    await session.send('이 타입 에러 고쳐줘');
    const running = session.approve();
    session.cancel();
    x.release(); // 신호가 선 뒤에 primary 가 정상 종료로 돌아온다 (엔진이 막 끝난 경합)
    const out = await running;
    // release 와 abort 중 먼저 resolve 된 쪽이 이긴다 — 어느 쪽이든 reviewer 는 안 돌고 결과는 cancelled 다.
    assert.deepEqual(x.calls.map((c) => c.role), ['primary']);
    const result = out.find((r) => r.kind === 'result');
    assert.ok(result?.kind === 'result' && result.outcome === 'cancelled');
  });
});

describe('위임 취소 — 그 뒤 (D-066)', () => {
  it('다시 열어도 끊김이 아니고 입력 대기다 — 취소 결과와 spend 가 파일에서 살아난다', async () => {
    isolate();
    const x = slowExec(['primary'], { actualUsd: 0.05 });
    const { session, dir } = make(x.exec);
    await session.send('이 타입 에러 고쳐줘');
    const running = session.approve();
    session.cancel();
    await running;

    const { session: reopened } = make(x.exec, undefined, dir);
    assert.equal(reopened.state, 'waiting_input');
    assert.equal(reopened.interrupted, false);
    assert.deepEqual(kinds(reopened), ['user', 'plan', 'approval', 'result', 'spend']);
    const budget = new Budget(20, 2_000_000);
    const spend = reopened.records().at(-1);
    assert.ok(spend?.kind === 'spend');
    budget.absorb(spend);
    assert.equal(budget.spentUsd, 0.05);
  });

  it('취소된 엔진 세션은 다음 위임이 잇지 않는다 — 새로 띄우고 앞 대화를 싣는다', async () => {
    isolate();
    // 1차 위임은 정상 종료(엔진 세션 eng-1 을 남긴다), 2차는 그것을 이어 붙였다가 취소, 3차는 잇지 않아야 한다.
    const calls: { role: string; resume: string | undefined; prompt: string }[] = [];
    let primaries = 0;
    const exec: SlotExecutor = (slot, prompt, options) => {
      calls.push({ role: slot.role, resume: options?.resume, prompt });
      if (slot.role === 'reviewer') return Promise.resolve(done('PASS'));
      primaries += 1;
      if (primaries !== 2) return Promise.resolve(done('ran', { sessionId: `eng-${primaries}` }));
      return new Promise<SlotRun>((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve(killed({ sessionId: 'eng-1' })), { once: true });
      });
    };
    const { session } = make(exec);
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();

    await session.send('이 타입 에러 또 고쳐줘');
    const second = session.approve();
    session.cancel();
    const out = await second;
    assert.ok(!out.some((r) => r.kind === 'error'), '취소를 실패한 이어 붙임으로 알리지 않는다');
    const cancelled = out.find((r) => r.kind === 'result');
    assert.ok(cancelled?.kind === 'result' && cancelled.outcome === 'cancelled' && cancelled.engineSession === undefined);

    await session.send('이 타입 에러 다시 고쳐줘');
    await session.approve();
    const primaryCalls = calls.filter((c) => c.role === 'primary');
    assert.deepEqual(primaryCalls.map((c) => c.resume), [undefined, 'eng-1', undefined]);
    assert.match(primaryCalls[2]?.prompt ?? '', /\[최근 대화\]/, '잇지 않으면 orc 의 최근 대화가 원문으로 실린다 (D-059)');
    assert.match(primaryCalls[2]?.prompt ?? '', /orc\(위임 취소\): 사용자가 앞 위임을 취소했다\(행 \w+ · primary 실행 중\)/, '취소한 사실이 맥락에 실린다');
    assert.equal(session.state, 'waiting_input');
    assert.equal(session.records().findLast((r) => r.kind === 'result')?.kind, 'result');
    const last = session.records().findLast((r) => r.kind === 'result');
    assert.ok(last?.kind === 'result' && last.outcome !== 'cancelled' && last.engineSession?.id === 'eng-3');
  });

  it('취소한 위임은 다음 제안(사다리 상향)을 만들지 않는다 — 실패 신호가 아니다', async () => {
    isolate();
    const { session } = make(slowExec(['primary']).exec);
    await session.send('이 타입 에러 고쳐줘');
    const running = session.approve();
    session.cancel();
    await running;
    assert.ok(!session.records().some((r) => r.kind === 'summary'));
  });
});

describe('취소할 위임이 없을 때 (D-066)', () => {
  it('입력 대기·승인 대기에서는 false 다', async () => {
    isolate();
    const { session } = make(slowExec([]).exec);
    assert.equal(session.cancel(), false);
    await session.send('이 타입 에러 고쳐줘');
    assert.equal(session.state, 'blocked');
    assert.equal(session.cancel(), false);
  });

  it('지휘자 직접 답이 도는 중은 취소 대상이 아니다 — 위임만 취소한다', async () => {
    isolate();
    let open: () => void = () => undefined;
    let asked = false;
    const conduct: SlotExecutor = () => new Promise<SlotRun>((resolve) => { asked = true; open = () => resolve(done('답\nSUGGEST: NONE')); });
    const { session } = make(slowExec([]).exec, conduct);
    const sending = session.send('넌 누구니');
    await until(() => asked);
    assert.equal(session.state, 'working');
    assert.equal(session.cancellable, false);
    assert.equal(session.cancel(), false);
    open();
    await sending;
    assert.equal(session.state, 'waiting_input');
  });

  it('위임 결과 요약이 도는 중은 취소 대상이 아니다 — 결과는 이미 기록됐다', async () => {
    isolate();
    let open: () => void = () => undefined;
    const conduct: SlotExecutor = () => new Promise<SlotRun>((resolve) => { open = () => resolve(done('요약')); });
    const { session } = make(slowExec([]).exec, conduct);
    await session.send('이 타입 에러 고쳐줘');
    const running = session.approve();
    await until(() => session.records().some((r) => r.kind === 'result'));
    assert.equal(session.cancellable, false);
    assert.equal(session.cancel(), false);
    open();
    await running;
    assert.ok(session.records().some((r) => r.kind === 'summary'));
  });
});
