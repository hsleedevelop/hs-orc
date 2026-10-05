/**
 * 대화 세션 (SPEC §6.4). 실행기는 전부 가짜다 — 이 파일이 돈을 쓰면 아무도 안 돌린다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { Budget } from '../budget.ts';
import { Journal } from '../journal.ts';
import type { EngineReport, SlotExecutor, SlotRun } from '../executor.ts';
import { ConversationSession, SessionStateError } from '../session.ts';
import { readDecisions } from '../decision-log.ts';
import { JevUnavailableError, type JevChoiceAnswer, type JevChoiceRequest, type RowClassifier } from '../../adapters/jev.ts';
import { appendRecord, replaySpend, transcriptPath, type TranscriptRecord } from '../transcript.ts';
import { readUnclassified, unclassifiedLogPath } from '../unclassified.ts';

const isolate = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-session-log-'));
  process.env['HS_ORC_DECISION_LOG'] = path.join(dir, 'log.jsonl');
  process.env['HS_ORC_RUN_STORE'] = path.join(dir, 'runs');
  return path.join(dir, 'log.jsonl');
};

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

/**
 * primary 는 세션 id 를 돌려주고, 두 번째 primary 실행의 성패를 고를 수 있다.
 * reviewer 판정은 `slot.role` 로 가른다 — R10 의 reviewer(Astra)는 label 이 Haiku 가 아니라서
 * label 로 가르면 reviewer 를 primary 로 잘못 센다.
 */
const resumeSpy = (secondOk = true) => {
  const calls: { label: string; role: string; prompt: string; resume: string | undefined; baseline?: EngineReport | undefined }[] = [];
  let primaries = 0;
  const exec: SlotExecutor = (slot, prompt, options) => {
    calls.push({ label: slot.label, role: slot.role, prompt, resume: options?.resume, baseline: options?.baseline });
    if (slot.role === 'reviewer') return Promise.resolve(reply('PASS'));
    primaries += 1;
    const ok = primaries === 1 || secondOk;
    return Promise.resolve({ ...reply(ok ? 'ran' : '', ok), sessionId: `eng-${primaries}`, reported: { costUsd: primaries / 10 } });
  };
  return { exec, calls };
};

const make = (conduct: SlotExecutor, dir = mkdtempSync(path.join(os.tmpdir(), 'hs-session-')), execute = delegateSpy().exec) => {
  const budget = new Budget(20, 2_000_000);
  const session = new ConversationSession({ approvalMode: 'manual',
    matrix, catalog, kind: 'project', dir, id: '0923-1200-aaa',
    budget, journal: new Journal(), conduct, executorFor: () => execute,
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

  it('직접 답이 실패하면 사유를 남기고 입력 대기로 돌아간다 — 조용히 삼키지 않는다', async () => {
    const { session } = make(conductSpy('', false).exec);
    const out = await session.send('넌 누구니');
    assert.deepEqual(out.map((r) => r.kind), ['user', 'error']);
    assert.equal(session.state, 'waiting_input');
  });

  it('다음 직접 답에 앞 턴 대화를 싣는다 (G7)', async () => {
    const c = conductSpy();
    const { session } = make(c.exec);
    await session.send('넌 누구니');
    await session.send('뭘 할 수 있어');
    assert.match(c.prompts[1] ?? '', /\[최근 대화\]\n사용자: 넌 누구니\norc: 저는 hs-orc 입니다\./);
    assert.doesNotMatch(c.prompts[1] ?? '', /\[최근 대화\][^[]*뭘 할 수 있어/);
  });

  it('맥락을 자르면 버린 양을 직접 답 기록에 남긴다 — 안 잘랐으면 남기지 않는다 (D-053)', async () => {
    const c = conductSpy();
    const session = new ConversationSession({ approvalMode: 'manual',
      matrix, catalog, kind: 'project', dir: mkdtempSync(path.join(os.tmpdir(), 'hs-session-')), id: '0923-1200-aaa',
      budget: new Budget(20, 2_000_000), journal: new Journal(), conduct: c.exec, executorFor: () => delegateSpy().exec,
      context: { contextTurns: 1, contextChars: 6000 },
    });
    const first = (await session.send('넌 누구니')).find((r) => r.kind === 'direct');
    await session.send('뭘 할 수 있어');
    const third = (await session.send('고마워')).find((r) => r.kind === 'direct');
    assert.equal(first?.kind === 'direct' ? first.cut : 'x', undefined);
    assert.deepEqual(third?.kind === 'direct' ? third.cut : null, { turns: 1, chars: 0 });
  });

  it('직접 답 실행의 캐시 쓰기 TTL 내역을 direct 기록에 남긴다 — 없으면 필드도 없다 (D-062)', async () => {
    const cacheWrite = { ephemeral1hTokens: 31000, ephemeral5mTokens: 0 };
    const withTtl: SlotExecutor = () => Promise.resolve({ ...reply('답\nSUGGEST: NONE'), cacheWrite });
    const direct = (await make(withTtl).session.send('넌 누구니')).find((r) => r.kind === 'direct');
    assert.deepEqual(direct?.kind === 'direct' ? direct.cacheWrite : null, cacheWrite);
    const plain = (await make(conductSpy().exec).session.send('넌 누구니')).find((r) => r.kind === 'direct');
    assert.ok(plain?.kind === 'direct' && !('cacheWrite' in plain));
  });

  it('유료 호출 뒤에 쌓인 과금·토큰을 spend 한 줄로 남긴다 (D-054)', async () => {
    const exec: SlotExecutor = () =>
      Promise.resolve({ ...reply('답\nSUGGEST: NONE'), actualUsd: 0.02, usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 0 } });
    const { session } = make(exec);
    const out = await session.send('넌 누구니');
    const last = session.records().at(-1);
    assert.equal(out.at(-1)?.kind, 'direct', '돌려준 줄은 그대로다');
    assert.equal(last?.kind, 'spend');
    assert.deepEqual(last?.kind === 'spend' ? [last.charges.map((c) => c.usd), last.tokens, last.unreported] : null, [[0.02], 15, 0]);
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

  it('사용자 메시지 기록이 실패하면 working 에 갇히지 않고 턴도 되돌린다', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-session-'));
    const c = conductSpy();
    const { session } = make(c.exec, dir);
    // 기록 폴더(홈의 `<키>/sessions`, D-071) 자리에 평범한 파일을 둔다 — appendRecord 의 mkdirSync 가
    // 던진다. 어느 사용자 권한에서도 재현된다(chmod 불필요).
    const blocker = path.dirname(session.file);
    mkdirSync(path.dirname(blocker), { recursive: true });
    writeFileSync(blocker, 'not a directory');
    await assert.rejects(session.send('넌 누구니'));
    assert.equal(session.state, 'waiting_input');

    rmSync(blocker);
    const out = await session.send('넌 누구니');
    const user = out[0];
    assert.ok(user?.kind === 'user' && user.turn === 1);
  });
});

describe('대화 세션 — 승인·결과 처리 (SPEC §6.4.4)', () => {
  it('승인하면 두 슬롯을 돌리고 결과·요약을 남긴 뒤 입력 대기로 돌아간다', async () => {
    const log = isolate();
    const d = delegateSpy();
    const { session } = make(conductSpy().exec, undefined, d.exec);
    await session.send('이 타입 에러 고쳐줘');
    const out = await session.approve();
    assert.deepEqual(out.map((r) => r.kind), ['approval', 'result', 'summary']);
    assert.equal(session.state, 'waiting_input');
    assert.equal(d.calls.length, 2);
    const result = out[1];
    assert.ok(result?.kind === 'result');
    assert.equal(readDecisions(log).filter((r) => r.id === result.decisionId).length, 2);
    assert.match(readDecisions(log)[0]?.note ?? '', /session 0923-1200-aaa · 승인 user$/);
  });

  it('증거가 없으면 요약 옆에 사다리 첫 단계를 제안한다', async () => {
    isolate();
    const { session } = make(conductSpy().exec);
    await session.send('이 타입 에러 고쳐줘');
    const summary = (await session.approve()).at(-1);
    assert.ok(summary?.kind === 'summary');
    assert.equal(summary.text, '요약 한 줄');
    assert.match(summary.next, /코드·로그·재현 조건 보강/);
  });

  it('검증 명령이 통과하면 다음 제안이 없다', async () => {
    isolate();
    const { session } = make(conductSpy().exec);
    await session.send('이 타입 에러 고쳐줘');
    const summary = (await session.approve({ verify: ['exit 0'] })).at(-1);
    assert.ok(summary?.kind === 'summary' && summary.next === '');
  });

  it('위임 프롬프트에 앞 대화를 싣고, 결정 로그에는 사용자 문장만 남긴다', async () => {
    const log = isolate();
    const d = delegateSpy();
    const { session } = make(conductSpy().exec, undefined, d.exec);
    await session.send('넌 누구니');
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    assert.match(d.calls[0]?.prompt ?? '', /^\[최근 대화\]\n사용자: 넌 누구니/);
    assert.match(d.calls[0]?.prompt ?? '', /\[이번 요청\]\n이 타입 에러 고쳐줘$/);
    assert.equal(readDecisions(log)[0]?.task, '이 타입 에러 고쳐줘');
  });

  it('다음 직접 답은 앞 위임의 요약을 맥락으로 받는다 (G7)', async () => {
    isolate();
    const c = conductSpy();
    const { session } = make(c.exec);
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    await session.send('넌 누구니');
    assert.match(c.prompts.at(-1) ?? '', /orc\(위임 결과 요약\): 요약 한 줄/);
  });

  it('거절하면 실행하지 않고 입력 대기로 돌아간다', async () => {
    const d = delegateSpy();
    const { session } = make(conductSpy().exec, undefined, d.exec);
    await session.send('이 타입 에러 고쳐줘');
    const out = session.reject();
    assert.ok(out[0]?.kind === 'approval' && out[0].approved === false);
    assert.equal(session.state, 'waiting_input');
    assert.equal(d.calls.length, 0);
  });

  it('거절하면 결정 로그에 decided·declined 두 줄을 같은 id 로 남긴다 (SPEC §8)', async () => {
    const log = isolate();
    const { session } = make(conductSpy().exec);
    await session.send('이 타입 에러 고쳐줘');
    session.reject();
    const rows = readDecisions(log);
    assert.deepEqual(rows.map((r) => r.status), ['decided', 'declined']);
    assert.equal(rows[0]?.id, rows[1]?.id);
    assert.equal(rows[1]?.outcome, 'unverified');
    assert.match(rows[0]?.note ?? '', /session 0923-1200-aaa/);
  });

  it('누적 상한이면 승인해도 위임을 시작하지 않고 blocked 로 남긴다 (D-030)', async () => {
    const log = isolate();
    const d = delegateSpy();
    const { session, budget } = make(conductSpy().exec, undefined, d.exec);
    await session.send('이 타입 에러 고쳐줘');
    budget.countTokens({ inputTokens: 2_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 });
    const out = await session.approve();
    assert.deepEqual(out.map((r) => r.kind), ['approval', 'error']);
    assert.ok(out[1]?.kind === 'error' && /누적 상한/.test(out[1].text));
    assert.equal(d.calls.length, 0);
    assert.equal(session.state, 'waiting_input');
    assert.deepEqual(readDecisions(log).map((r) => r.status), ['decided', 'blocked']);
  });

  it('위임이 던지면 에러를 남기고 1차 결정 줄을 pending 으로 버려두지 않는다', async () => {
    const log = isolate();
    const boom: SlotExecutor = () => Promise.reject(new Error('엔진 폭발'));
    const { session } = make(conductSpy().exec, undefined, boom);
    await session.send('이 타입 에러 고쳐줘');
    const out = await session.approve();
    const error = out.at(-2);
    assert.ok(error?.kind === 'error' && /위임이 끝나지 못했다: 엔진 폭발/.test(error.text));
    const rows = readDecisions(log);
    assert.deepEqual(rows.map((r) => [r.status, r.outcome]), [['decided', 'pending'], ['ran', 'wrong']]);
    assert.equal(rows[0]?.id, rows[1]?.id);
  });

  it('위임 중 끊긴 기록을 다시 열면 결과가 기록되지 않았다고 알린다', async () => {
    isolate();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-session-'));
    const hang: SlotExecutor = () => new Promise(() => {});
    const { session } = make(conductSpy().exec, dir, hang);
    await session.send('이 타입 에러 고쳐줘');
    void session.approve();
    assert.equal(session.interrupted, false, '돌고 있는 위임은 끊긴 것이 아니다');
    const reopened = make(conductSpy().exec, dir).session;
    assert.equal(reopened.interrupted, true);
    await reopened.send('넌 누구니');
    assert.equal(reopened.interrupted, false);
  });

  it('지휘자에게 물으면 배정을 거절로 남기고 같은 메시지에 직접 답한다 — 새 턴을 만들지 않는다 (D-038)', async () => {
    const c = conductSpy();
    const d = delegateSpy();
    const { session } = make(c.exec, undefined, d.exec);
    const sent = await session.send('방금 리팩터링한 부분 설명해');
    assert.equal(sent[1]?.kind, 'plan');
    const out = await session.askConductor();
    assert.deepEqual(out.map((r) => r.kind), ['approval', 'direct']);
    assert.ok(out[0]?.kind === 'approval' && out[0].approved === false);
    assert.deepEqual(out.map((r) => r.turn), [1, 1]);
    assert.match(c.prompts.at(-1) ?? '', /\[이번 메시지\]\n방금 리팩터링한 부분 설명해$/);
    assert.equal(d.calls.length, 0);
    assert.equal(session.state, 'waiting_input');
  });

  it('승인 대기가 아니면 지휘자에게 묻지 않는다 (D-038)', async () => {
    const c = conductSpy();
    const { session } = make(c.exec);
    await assert.rejects(session.askConductor(), SessionStateError);
    assert.equal(c.prompts.length, 0);
  });

  it('스크래치 세션은 쓰기 승인을 거절하고 승인 대기에 남는다', async () => {
    const budget = new Budget(20, 2_000_000);
    const session = new ConversationSession({ approvalMode: 'manual',
      matrix, catalog, kind: 'scratch', dir: mkdtempSync(path.join(os.tmpdir(), 'hs-scratch-')), id: '0923-1200-bbb',
      budget, journal: new Journal(), conduct: conductSpy().exec, executorFor: () => delegateSpy().exec,
    });
    await session.send('이 타입 에러 고쳐줘');
    await assert.rejects(session.approve({ write: true }), SessionStateError);
    assert.equal(session.state, 'blocked');
  });
});

describe('대화 세션 — 위임이 던지면 같은 계획으로 카드를 다시 세운다 (D-081)', () => {
  /** primary 를 `fails` 번 던지고 그 뒤로는 돈다. reviewer 는 PASS. */
  const flaky = (fails: number) => {
    const calls: { role: string; prompt: string }[] = [];
    let left = fails;
    const exec: SlotExecutor = (slot, prompt) => {
      calls.push({ role: slot.role, prompt });
      if (slot.role === 'reviewer') return Promise.resolve(reply('PASS'));
      if (left > 0) {
        left -= 1;
        return Promise.reject(new Error('spawn 실패'));
      }
      return Promise.resolve(reply('ran'));
    };
    return { exec, calls, primaries: () => calls.filter((c) => c.role === 'primary').length };
  };
  const plans = (s: ConversationSession) => s.records().filter((r) => r.kind === 'plan');

  it('오류를 남기고 같은 배정 카드를 blocked 로 세운다 — 시작하지 않고, 앞 기록은 고치지 않는다', async () => {
    isolate();
    const f = flaky(1);
    const { session } = make(conductSpy().exec, undefined, f.exec);
    await session.send('이 타입 에러 고쳐줘');
    const before = session.records();
    const out = await session.approve();
    assert.deepEqual(out.map((r) => r.kind), ['approval', 'error', 'plan']);
    assert.equal(session.state, 'blocked');
    assert.equal(f.primaries(), 1, '다시 돌리지 않는다 — 카드만 선다');
    assert.deepEqual(session.records().slice(0, before.length), before, 'append-only');
    const [first, again] = plans(session);
    assert.ok(first?.kind === 'plan' && again?.kind === 'plan');
    assert.equal(again.retry, true);
    assert.deepEqual({ ...again, at: first.at, retry: undefined }, { ...first, retry: undefined }, '행·슬롯·reason·비용이 같다');
  });

  it('다시 승인하면 같은 계획으로 실제로 돌고 결과·요약이 붙는다 — 결정은 새 id 다', async () => {
    const log = isolate();
    const f = flaky(1);
    const { session } = make(conductSpy().exec, undefined, f.exec);
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    const out = await session.approve();
    assert.deepEqual(out.map((r) => r.kind), ['approval', 'result', 'summary']);
    assert.equal(session.state, 'waiting_input');
    assert.equal(f.primaries(), 2);
    const rows = readDecisions(log);
    assert.deepEqual(rows.map((r) => r.status), ['decided', 'ran', 'decided', 'ran']);
    assert.notEqual(rows[0]?.id, rows[2]?.id);
    assert.equal(rows[2]?.task, '이 타입 에러 고쳐줘');
  });

  it('쓰기로 승인한 위임이면 다시 세운 카드도 쓰기가 켜진 채다', async () => {
    isolate();
    const { session } = make(conductSpy().exec, undefined, flaky(1).exec);
    await session.send('이 타입 에러 고쳐줘');
    await session.approve({ write: true });
    const again = plans(session).at(-1);
    assert.ok(again?.kind === 'plan' && again.write === true && again.retry === true);
  });

  it('다시 세운 카드도 던지면 카드를 또 세우지 않는다 — 같은 실패를 같은 방식으로 2회 연속 재시도하지 않는다', async () => {
    isolate();
    const f = flaky(2);
    const { session } = make(conductSpy().exec, undefined, f.exec);
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    const out = await session.approve();
    assert.deepEqual(out.map((r) => r.kind), ['approval', 'error', 'error']);
    assert.match(out[2]?.kind === 'error' ? out[2].text : '', /카드를 또 세우지 않는다/);
    assert.equal(session.state, 'waiting_input');
    assert.equal(plans(session).length, 2);
  });

  it('auto 방식에서도 다시 세운 카드는 자동 승인하지 않고 A3 로 묻는다', async () => {
    isolate();
    const f = flaky(1);
    const session = new ConversationSession({
      approvalMode: 'auto', matrix, catalog, kind: 'project', dir: mkdtempSync(path.join(os.tmpdir(), 'hs-session-')), id: '1004-1200-rty',
      budget: new Budget(20, 2_000_000), journal: new Journal(), conduct: conductSpy().exec, executorFor: () => f.exec,
    });
    const out = await session.send('이 타입 에러 고쳐줘'); // 규칙 R01 — auto 는 묻지 않고 시작한다
    assert.deepEqual(out.map((r) => r.kind), ['user', 'plan', 'approval', 'error', 'plan']);
    assert.equal(session.state, 'blocked');
    assert.equal(f.primaries(), 1);
    const again = out.at(-1);
    assert.ok(again?.kind === 'plan' && again.retry === true);
    assert.deepEqual(again.asked?.map((a) => a.code), ['A3']);
  });

  it('위임이 돌려준 뒤의 결과(fail 등)는 카드를 다시 세우지 않는다 — 사다리 영역이다 (D-068)', async () => {
    isolate();
    const failing: SlotExecutor = (slot) => Promise.resolve(reply(slot.role === 'reviewer' ? 'FAIL' : 'ran'));
    const { session } = make(conductSpy().exec, undefined, failing);
    await session.send('이 타입 에러 고쳐줘');
    const out = await session.approve();
    assert.ok(out.some((r) => r.kind === 'result' && r.verdict === 'fail'));
    assert.equal(plans(session).length, 1);
    assert.equal(session.state, 'waiting_input');
  });

  it('취소한 뒤에 던진 예외는 카드를 다시 세우지 않는다 (D-066)', async () => {
    isolate();
    const hang: SlotExecutor = (_slot, _prompt, options) =>
      new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('중단')), { once: true }));
    const { session } = make(conductSpy().exec, undefined, hang);
    await session.send('이 타입 에러 고쳐줘');
    const running = session.approve();
    for (let i = 0; i < 200 && !session.cancellable; i += 1) await new Promise<void>((r) => setImmediate(r));
    assert.equal(session.cancel(), true);
    const out = await running;
    assert.deepEqual(out.map((r) => r.kind), ['approval', 'error']);
    assert.equal(session.state, 'waiting_input');
    assert.equal(plans(session).length, 1);
  });
});

describe('대화 세션 — resume (SPEC §6.4.3)', () => {
  it('직전 위임과 같은 슬롯이면 엔진 세션을 잇고, 그 실행 이후 대화만 싣는다', async () => {
    isolate();
    const r = resumeSpy();
    const { session } = make(conductSpy().exec, undefined, r.exec);
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    const primaries = r.calls.filter((c) => c.label !== 'Haiku');
    assert.deepEqual(primaries.map((c) => c.resume), [undefined, 'eng-1']);
    assert.equal(primaries[1]?.prompt, '이 타입 에러 고쳐줘');
  });

  it('primary 실행 중 엔진이 압축했으면 결과 기록에 남긴다 (D-058)', async () => {
    isolate();
    const compaction = { trigger: 'auto', preTokens: 180000, postTokens: 12000 };
    const exec: SlotExecutor = (slot) =>
      Promise.resolve(slot.role === 'reviewer' ? reply('PASS') : { ...reply('ran'), sessionId: 'eng-1', compactions: [compaction] });
    const { session } = make(conductSpy().exec, undefined, exec);
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    const result = session.records().findLast((x) => x.kind === 'result');
    assert.deepEqual(result?.kind === 'result' ? result.compacted : null, [compaction]);
  });

  it('직전 실행 중 엔진이 압축했으면 잇지 않고 맥락을 실어 새로 띄운다 (D-059)', async () => {
    isolate();
    const calls: { role: string; prompt: string; resume: string | undefined }[] = [];
    let primaries = 0;
    const exec: SlotExecutor = (slot, prompt, options) => {
      calls.push({ role: slot.role, prompt, resume: options?.resume });
      if (slot.role === 'reviewer') return Promise.resolve(reply('PASS'));
      primaries += 1;
      return Promise.resolve({ ...reply('ran'), sessionId: `eng-${primaries}`, ...(primaries === 1 ? { compactions: [{ trigger: 'auto' }] } : {}) });
    };
    const { session } = make(conductSpy().exec, undefined, exec);
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    const primaryCalls = calls.filter((c) => c.role === 'primary');
    assert.deepEqual(primaryCalls.map((c) => c.resume), [undefined, undefined]);
    assert.match(primaryCalls[1]?.prompt ?? '', /\[최근 대화\]/, '잇지 않으면 orc 의 최근 대화를 싣는다');
  });

  it('reviewer 의 압축은 기록하지 않는다 — 잇는 것은 primary 뿐이다 (D-058)', async () => {
    isolate();
    const exec: SlotExecutor = (slot) =>
      Promise.resolve(slot.role === 'reviewer' ? { ...reply('PASS'), compactions: [{ trigger: 'auto' }] } : { ...reply('ran'), sessionId: 'eng-1' });
    const { session } = make(conductSpy().exec, undefined, exec);
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    const result = session.records().findLast((x) => x.kind === 'result');
    assert.ok(result?.kind === 'result');
    assert.equal(result.compacted, undefined);
  });

  it('압축 뒤 새로 띄운 실행이 성공하면 다음 위임은 그 세션을 잇는다 (D-059)', async () => {
    isolate();
    const calls: { role: string; resume: string | undefined }[] = [];
    let primaries = 0;
    const exec: SlotExecutor = (slot, _prompt, options) => {
      calls.push({ role: slot.role, resume: options?.resume });
      if (slot.role === 'reviewer') return Promise.resolve(reply('PASS'));
      primaries += 1;
      return Promise.resolve({ ...reply('ran'), sessionId: `eng-${primaries}`, ...(primaries === 1 ? { compactions: [{ trigger: 'auto' }] } : {}) });
    };
    const { session } = make(conductSpy().exec, undefined, exec);
    for (let i = 0; i < 3; i += 1) {
      await session.send('이 타입 에러 고쳐줘');
      await session.approve();
    }
    assert.deepEqual(calls.filter((c) => c.role === 'primary').map((c) => c.resume), [undefined, undefined, 'eng-2']);
  });

  it('이을 때 직전 실행의 원본 보고를 기준으로 넘긴다 — 누적 보고를 다시 세지 않게 (D-057)', async () => {
    isolate();
    const r = resumeSpy();
    const { session } = make(conductSpy().exec, undefined, r.exec);
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    const primaries = r.calls.filter((c) => c.role === 'primary');
    assert.deepEqual(primaries.map((c) => c.baseline), [undefined, { costUsd: 0.1 }]);
    const last = session.records().findLast((x) => x.kind === 'result');
    assert.deepEqual(last?.kind === 'result' ? last.engineSession?.reported : null, { costUsd: 0.2 }, '다음 기준은 기록에 남는다');
  });

  it('reviewer 는 한 번도 잇지 않는다', async () => {
    isolate();
    const r = resumeSpy();
    const { session } = make(conductSpy().exec, undefined, r.exec);
    for (let i = 0; i < 2; i += 1) {
      await session.send('이 타입 에러 고쳐줘');
      await session.approve();
    }
    assert.ok(r.calls.filter((c) => c.label === 'Haiku').every((c) => c.resume === undefined));
  });

  it('이어 붙인 실행이 실패하면 사유를 남기고 새 세션으로 조용히 다시 돌리지 않는다', async () => {
    isolate();
    const r = resumeSpy(false);
    const { session } = make(conductSpy().exec, undefined, r.exec);
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    await session.send('이 타입 에러 고쳐줘');
    const out = await session.approve();
    assert.ok(out.some((rec) => rec.kind === 'error' && /조용히 바꾸지 않는다/.test(rec.text)));
    assert.equal(r.calls.filter((c) => c.label !== 'Haiku').length, 2);
  });

  it('이어 붙인 실행이 실패하면 다음 위임은 잇지 않고 맥락을 실어 새로 띄운다', async () => {
    isolate();
    const r = resumeSpy(false);
    const { session } = make(conductSpy().exec, undefined, r.exec);
    for (let i = 0; i < 3; i += 1) {
      await session.send('이 타입 에러 고쳐줘');
      await session.approve();
    }
    const primaries = r.calls.filter((c) => c.label !== 'Haiku');
    assert.deepEqual(primaries.map((c) => c.resume), [undefined, 'eng-1', undefined]);
    assert.match(primaries[2]?.prompt ?? '', /^\[최근 대화\]/);
  });

  it('codex 는 쓰기가 켜져 있으면 잇지 않는다 — 맥락을 실어 새로 띄운다 (final-review #1)', async () => {
    isolate();
    const r = resumeSpy();
    // R01 의 primary 는 Luna→codex (data/matrix.json, data/engines.json) — codex 는 resume+write 를 못 받는다.
    const { session } = make(conductSpy().exec, undefined, r.exec);
    await session.send('이 타입 에러 고쳐줘');
    await session.approve({ write: true });
    await session.send('이 타입 에러 고쳐줘');
    await session.approve({ write: true });
    const primaries = r.calls.filter((c) => c.role === 'primary');
    assert.equal(primaries.length, 2);
    assert.equal(primaries[1]?.resume, undefined);
    assert.match(primaries[1]?.prompt ?? '', /^\[최근 대화\]/);
  });

  it('슬롯이 다른 다음 위임은 잇지 않는다 (SPEC §10, final-review #3)', async () => {
    isolate();
    const r = resumeSpy();
    const { session } = make(conductSpy().exec, undefined, r.exec);
    await session.send('이 타입 에러 고쳐줘'); // R01: Luna → codex
    await session.approve();
    await session.send('이 아키텍처 설계 검토해줘'); // R10: Fable → claude — 엔진이 다르다
    await session.approve();
    const primaries = r.calls.filter((c) => c.role === 'primary');
    assert.equal(primaries.length, 2);
    assert.equal(primaries[1]?.resume, undefined);
    assert.match(primaries[1]?.prompt ?? '', /^\[최근 대화\]/);
  });
});

describe('대화 세션 — 압축 몫을 세지 못한 보고 (D-060)', () => {
  it('선언된 엔진의 위임은 spend 에 그 횟수를 남기고, 다시 열어도 Budget 이 되살린다', async () => {
    isolate();
    const usage = { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0 };
    const exec: SlotExecutor = (slot) =>
      Promise.resolve(slot.role === 'reviewer' ? { ...reply('PASS'), usage } : { ...reply('ran'), usage, compactionUncounted: true });
    const { session, dir } = make(conductSpy().exec, undefined, exec);
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    const spend = session.records().findLast((x) => x.kind === 'spend');
    assert.equal(spend?.kind === 'spend' ? spend.compactionUncounted : null, 1, 'reviewer 는 선언이 없어 세지 않는다');

    const reopened = new Budget(20);
    replaySpend(reopened, make(conductSpy().exec, dir).session.records());
    assert.match(reopened.summary(), /압축 토큰을 보고하지 않는 엔진 1회/);
  });
});

describe('대화 세션 — 재진입 방지 (final-review #2)', () => {
  it('메시지 처리 중 두 번째 send 는 거절된다 — 첫 await 전에 working 으로 바뀐다', async () => {
    const c = conductSpy();
    const { session } = make(c.exec);
    const first = session.send('이 타입 에러 고쳐줘');
    await assert.rejects(session.send('또'), SessionStateError);
    await first;
    assert.equal(session.state, 'blocked');
  });

  it('빈 메시지는 상태를 바꾸지 않는다', async () => {
    const { session } = make(conductSpy().exec);
    await session.send('   ');
    assert.equal(session.state, 'waiting_input');
  });

  it('라우팅 중 예외가 나면 에러 기록을 남기고 입력 대기로 돌아간다 — working 을 남기지 않는다', async () => {
    // classify()/assignmentById() 의 ClassifyError 는 route() 가 흡수해 unclassified 로 떨어뜨리므로
    // 던지지 않는다. 대신 assign() 안에서 모델 id 가 비어 던지도록 카탈로그를 망가뜨려 주입한다
    // (engines.json 이 깨진 상황의 재현 — 실제 엔진은 하나도 띄우지 않는다).
    // `id` 를 빼고 다시 만든다 — `delete` 는 readonly 필드라 안 되고, exactOptionalPropertyTypes 아래에서
    // 선택 필드를 지우는 이 저장소의 관례(constraints.md)는 값을 아예 담지 않는 쪽이다.
    const codexLuna = catalog.models.luna.availability.codex;
    const codexWithoutId = codexLuna ? { efforts: codexLuna.efforts } : null;
    const broken: typeof catalog = {
      ...catalog,
      models: {
        ...catalog.models,
        luna: {
          ...catalog.models.luna,
          availability: { ...catalog.models.luna.availability, codex: codexWithoutId },
        },
      },
    };
    const budget = new Budget(20, 2_000_000);
    const session = new ConversationSession({ approvalMode: 'manual',
      matrix, catalog: broken, kind: 'project', dir: mkdtempSync(path.join(os.tmpdir(), 'hs-session-')), id: '0923-1200-ddd',
      budget, journal: new Journal(), conduct: conductSpy().exec, executorFor: () => delegateSpy().exec,
    });
    const out = await session.send('이 타입 에러 고쳐줘');
    assert.deepEqual(out.map((r) => r.kind), ['user', 'error']);
    const error = out[1];
    assert.ok(error?.kind === 'error' && /라우팅이 끝나지 못했다/.test(error.text));
    assert.equal(session.state, 'waiting_input');
  });
});

describe('대화 세션 — 분류 폴백은 돌지 않는다 (D-033)', () => {
  it('규칙이 놓친 메시지는 LLM 분류 폴백 없이 지휘자가 바로 답한다', async () => {
    const c = conductSpy();
    const budget = new Budget(20, 2_000_000);
    const session = new ConversationSession({ approvalMode: 'manual',
      matrix, catalog, kind: 'project', dir: mkdtempSync(path.join(os.tmpdir(), 'hs-session-')), id: '0923-1200-eee',
      budget, journal: new Journal(), conduct: c.exec, executorFor: () => delegateSpy().exec,
    });
    // 분류 옵션을 아예 안 넘겨도 폴백이 돌면 안 된다 — PATH 를 비워 돈다면(=버그) 진짜 모델을 못 찾고
    // "시도하지 못했다" note 를 남긴다. 그 note 를 notes.length === 0 이 잡아낸다.
    const originalPath = process.env['PATH'];
    process.env['PATH'] = '';
    let out;
    try {
      out = await session.send('넌 누구니');
    } finally {
      process.env['PATH'] = originalPath;
    }
    assert.deepEqual(out.map((r) => r.kind), ['user', 'direct']);
    const direct = out[1];
    assert.ok(direct?.kind === 'direct');
    assert.equal(direct.notes.length, 0);
    assert.equal(c.prompts.length, 1);
  });
});

describe('대화 세션 — 제안·배정 카드 합치기 (D-064 결정 3)', () => {
  const SUGGEST_R01 = '타입 수정 요청으로 보인다.\nSUGGEST: R01';

  it('SUGGEST 가 나오면 직접 답 뒤에 배정 카드가 곧바로 서고 승인 대기로 멈춘다 — 엔진은 지휘자 한 번뿐이다', async () => {
    const c = conductSpy(SUGGEST_R01);
    const d = delegateSpy();
    const { session } = make(c.exec, undefined, d.exec);
    const out = await session.send('넌 누구니');
    assert.deepEqual(out.map((r) => r.kind), ['user', 'direct', 'plan']);
    const plan = out[2];
    assert.ok(plan?.kind === 'plan' && plan.taskId === 'R01' && plan.estimateUsd > 0);
    assert.equal(session.state, 'blocked');
    assert.equal(c.prompts.length, 1);
    assert.equal(d.calls.length, 0);
    // spend 는 카드 뒤에 붙는다 — 화면이 마지막 기록으로 카드를 고르는 데 걸리지 않는다 (renderer 는 spend 를 거른다).
    assert.equal(session.records().at(-1)?.kind, 'spend');
  });

  it('plan.reason 은 지휘자 제안이다 — 수동 지정이 아니다. 결정 로그 trigger 에도 그대로 남는다', async () => {
    const log = isolate();
    const { session } = make(conductSpy(SUGGEST_R01).exec);
    const out = await session.send('넌 누구니');
    assert.ok(out[2]?.kind === 'plan' && out[2].reason === '지휘자 제안 R01');
    await session.approve();
    const first = readDecisions(log)[0];
    assert.match(first?.trigger ?? '', /매트릭스 R01 · 지휘자 제안 R01$/);
    assert.doesNotMatch(first?.trigger ?? '', /수동 지정/);
  });

  it('승인은 그 카드 1회다 — 승인 한 번으로 위임이 돌고 결과·요약이 붙는다', async () => {
    isolate();
    const c = conductSpy(SUGGEST_R01);
    const d = delegateSpy();
    const { session } = make(c.exec, undefined, d.exec);
    await session.send('넌 누구니');
    const out = await session.approve();
    assert.deepEqual(out.map((r) => r.kind), ['approval', 'result', 'summary']);
    assert.deepEqual(d.calls.map((x) => x.label).sort(), ['Haiku', 'Luna']);
    assert.equal(session.state, 'waiting_input');
  });

  it('거절하면 실행 없이 입력 대기로 돌아가고 결정 로그에 declined 가 남는다', async () => {
    const log = isolate();
    const d = delegateSpy();
    const { session } = make(conductSpy(SUGGEST_R01).exec, undefined, d.exec);
    await session.send('넌 누구니');
    const out = session.reject();
    assert.ok(out[0]?.kind === 'approval' && out[0].approved === false);
    assert.equal(session.state, 'waiting_input');
    assert.equal(d.calls.length, 0);
    assert.deepEqual(readDecisions(log).map((r) => r.status), ['decided', 'declined']);
  });

  it('planAs 로 다른 행을 고르면 사람이 고른 것이다 — reason 은 수동 지정', async () => {
    const { session } = make(conductSpy(SUGGEST_R01).exec);
    await session.send('넌 누구니');
    session.reject();
    const out = await session.planAs('R02');
    assert.ok(out[0]?.kind === 'plan' && out[0].taskId === 'R02' && out[0].reason === '수동 지정 R02');
    assert.equal(session.state, 'blocked');
  });

  it('지휘자에게 묻기는 카드를 거절로 남기고 같은 메시지에 다시 답한다 — 새 카드가 서도 승인 대기다', async () => {
    const c = conductSpy(SUGGEST_R01);
    const { session } = make(c.exec);
    await session.send('넌 누구니');
    const out = await session.askConductor();
    assert.deepEqual(out.map((r) => r.kind), ['approval', 'direct', 'plan']);
    assert.ok(out[0]?.kind === 'approval' && out[0].approved === false);
    assert.equal(session.records().filter((r) => r.kind === 'user').length, 1);
    assert.equal(session.state, 'blocked');
  });

  it('SUGGEST: NONE·못 읽음·매트릭스에 없는 행이면 카드 없이 직접 답만 남는다', async () => {
    for (const reply of ['그냥 대화.\nSUGGEST: NONE', '제안 줄이 없다', '이상한 제안.\nSUGGEST: R99']) {
      const { session } = make(conductSpy(reply).exec);
      const out = await session.send('넌 누구니');
      assert.deepEqual(out.map((r) => r.kind), ['user', 'direct'], reply);
      assert.equal(session.state, 'waiting_input', reply);
    }
  });

  it('카드가 선 채 새 메시지를 보내면 그 배정은 거절로 남고 새 메시지를 처리한다', async () => {
    const log = isolate();
    const d = delegateSpy();
    const c = conductSpy(SUGGEST_R01);
    const { session } = make(c.exec, undefined, d.exec);
    await session.send('넌 누구니');
    const out = await session.send('아니 그냥 얘기하자');
    assert.deepEqual(out.map((r) => r.kind), ['approval', 'user', 'direct', 'plan']);
    assert.ok(out[0]?.kind === 'approval' && out[0].approved === false && out[0].turn === 1);
    assert.equal(out[1]?.turn, 2);
    assert.equal(d.calls.length, 0);
    assert.deepEqual(readDecisions(log).map((r) => r.status), ['decided', 'declined']);
  });

  it('처리 중(working)의 send 는 여전히 거절된다', async () => {
    const { session } = make(conductSpy(SUGGEST_R01).exec);
    const first = session.send('넌 누구니');
    await assert.rejects(session.send('또'), SessionStateError);
    await first;
  });

  it('누적 상한이면 승인해도 위임을 시작하지 않는다 (D-030)', async () => {
    isolate();
    const d = delegateSpy();
    const { session, budget } = make(conductSpy(SUGGEST_R01).exec, undefined, d.exec);
    await session.send('넌 누구니');
    budget.charge('x', 999, 0, undefined, 'api');
    const out = await session.approve();
    assert.ok(out.some((r) => r.kind === 'error' && /누적 상한/.test(r.text)));
    assert.equal(d.calls.length, 0);
  });

  it('옛 기록(제안 뒤 배정 없음)을 다시 열면 "Rxx 로 위임" 이 그대로 통한다 — reason 은 지휘자 제안', async () => {
    const c = conductSpy();
    const { dir } = make(c.exec);
    const file = transcriptPath(dir, '0923-1200-aaa');
    const at = { v: 1 as const, at: '2026-09-25T00:00:00.000Z', turn: 1 };
    const old: TranscriptRecord[] = [
      { ...at, kind: 'user', text: '넌 누구니' },
      { ...at, kind: 'direct', text: '타입 수정 요청으로 보인다.', suggest: 'R01', cost: '$0.01 actual', notes: [] },
    ];
    for (const r of old) appendRecord(file, r);
    const reopened = make(c.exec, dir).session;
    assert.equal(reopened.state, 'waiting_input');
    const out = await reopened.planAs('R01');
    assert.ok(out[0]?.kind === 'plan' && out[0].reason === '지휘자 제안 R01');
    assert.equal(reopened.state, 'blocked');
    assert.equal(reopened.records().filter((r) => r.kind === 'user').length, 1);
  });

  it('제안 카드가 선 채 다시 열면 되살리지 않는다 — 입력 대기, spend 재생은 그대로 (D-054)', async () => {
    const c = conductSpy(SUGGEST_R01);
    const { session, dir } = make(c.exec);
    await session.send('넌 누구니');
    const reopened = make(c.exec, dir);
    assert.equal(reopened.session.state, 'waiting_input');
    const budget = new Budget(20, 2_000_000);
    replaySpend(budget, reopened.session.records());
    assert.ok(budget.charges.length > 0);
    await assert.rejects(reopened.session.approve(), SessionStateError);
  });
});

/**
 * D-065: 세션에서는 "위임할지·어느 행" 을 Jev 가 정한다. 지휘자는 직접 답만 한다.
 * 분류기는 가짜다 — 이 파일은 외부로 나가지 않는다.
 */
describe('대화 세션 — Jev 분류 (D-065)', () => {
  const answer = (choice: string, confidence: number, probabilities: Record<string, number> = { [choice]: 0.9, NONE: 0.1 }): JevChoiceAnswer => ({
    choice, probabilities, confidence, inputTokens: 900, outputTokens: 10, elapsedMs: 800,
  });
  const jevSpy = (result: JevChoiceAnswer | Error) => {
    const requests: JevChoiceRequest[] = [];
    const classifier: RowClassifier = (r) => (requests.push(r), result instanceof Error ? Promise.reject(result) : Promise.resolve(result));
    return { classifier, requests };
  };
  const makeJev = (conduct: SlotExecutor, classifier: RowClassifier) => {
    const session = new ConversationSession({ approvalMode: 'manual',
      matrix, catalog, kind: 'project', dir: mkdtempSync(path.join(os.tmpdir(), 'hs-session-')), id: '0929-1200-aaa',
      budget: new Budget(20, 2_000_000), journal: new Journal(), conduct, executorFor: () => delegateSpy().exec, classifier,
    });
    return session;
  };

  it('확신 있는 행은 지휘자를 부르지 않고 배정 카드가 선다 — 근거·토큰이 카드에 남는다', async () => {
    const c = conductSpy();
    const session = makeJev(c.exec, jevSpy(answer('R03', 0.97)).classifier);
    const out = await session.send('설정 화면에 다크 모드 토글을 넣어줘');
    assert.deepEqual(out.map((r) => r.kind), ['user', 'plan']);
    const plan = out[1];
    assert.ok(plan?.kind === 'plan' && plan.taskId === 'R03' && plan.reason === 'Jev R03 p=0.90 conf=0.97');
    assert.match(plan.notes[0] ?? '', /Jev 분류 → R03 .*입력 900·출력 10 토큰/);
    assert.equal(c.prompts.length, 0);
    assert.equal(session.state, 'blocked');
  });

  it('NONE 이면 지휘자가 직접 답한다 — 지휘자의 SUGGEST 가 Jev 판정을 뒤집지 못한다', async () => {
    const c = conductSpy('무엇을 도울까요?\nSUGGEST: R01');
    const session = makeJev(c.exec, jevSpy(answer('NONE', 0.99, { NONE: 0.99, R01: 0.01 })).classifier);
    const out = await session.send('넌 누구니');
    assert.deepEqual(out.map((r) => r.kind), ['user', 'direct']);
    assert.ok(out[1]?.kind === 'direct' && out[1].suggest === null);
    assert.match(out[1]?.kind === 'direct' ? (out[1].notes[0] ?? '') : '', /Jev 분류 → 맞는 행 없음/);
    assert.equal(session.state, 'waiting_input');
  });

  it('행이 확정되지 않은 턴(NONE·확신도 미만)은 행 제안 대신 직접 고르라는 프롬프트로 묻는다 — Jev 를 못 쓰면 옛 프롬프트다 (D-079)', async () => {
    const cases: [JevChoiceAnswer | Error, boolean][] = [
      [answer('NONE', 0.99, { NONE: 0.99, R01: 0.01 }), true],
      [answer('R06', 0.36, { R06: 0.4, R05: 0.3, R07: 0.2, NONE: 0.1 }), true],
      [new JevUnavailableError('rate-limit', '429'), false],
    ];
    for (const [result, unrouted] of cases) {
      const c = conductSpy();
      // 규칙이 잡지 않는 문장이다 — Jev 를 못 쓴 경우에도 지휘자까지 간다.
      await makeJev(c.exec, jevSpy(result).classifier).send('넌 누구니');
      assert.equal(/업무 행에 배정되지 않았다/.test(c.prompts[0] ?? ''), unrouted);
      assert.equal(/맞는 행을 제안한다/.test(c.prompts[0] ?? ''), !unrouted);
    }
  });

  it('GENERAL 이면 카드 없이 직접 답하고 행을 고르라고 묻는다 — 지휘자 SUGGEST 는 버리고 기록에 general 을 남긴다 (D-082)', async () => {
    const c = conductSpy('행에 맞지 않는 작업입니다.\nSUGGEST: R02');
    const session = makeJev(c.exec, jevSpy(answer('GENERAL', 0.86, { GENERAL: 0.9, NONE: 0.1 })).classifier);
    const out = await session.send('src/core 구조를 처음 보는 사람용으로 설명해줘');
    assert.deepEqual(out.map((r) => r.kind), ['user', 'direct']);
    const direct = out[1];
    assert.ok(direct?.kind === 'direct' && direct.suggest === null && direct.general === true);
    assert.match(direct.notes[0] ?? '', /Jev 분류 → 행에 안 맞는 작업 \(GENERAL/);
    assert.match(c.prompts[0] ?? '', /업무 행에 배정되지 않았다/);
    assert.equal(session.state, 'waiting_input');
  });

  it('GENERAL 은 미분류 로그에 세고 임계치를 넘으면 행 추가 제안을 싣는다 — NONE 은 세지 않는다 (D-082, D-022)', async () => {
    const none = makeJev(conductSpy().exec, jevSpy(answer('NONE', 0.99, { NONE: 0.99 })).classifier);
    await none.send('넌 누구니');
    assert.equal(readUnclassified(unclassifiedLogPath(none.dir)).length, 0);

    const session = makeJev(conductSpy().exec, jevSpy(answer('GENERAL', 0.86, { GENERAL: 0.9, NONE: 0.1 })).classifier);
    const notes: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const out = await session.send('모듈 의존 관계를 mermaid 로 그려줘');
      notes.push(out[1]?.kind === 'direct' ? [...out[1].notes] : []);
    }
    assert.deepEqual(readUnclassified(unclassifiedLogPath(session.dir)).map((r) => r.task), Array(3).fill('모듈 의존 관계를 mermaid 로 그려줘'));
    assert.equal(notes[1]?.length, 2, 'Jev 줄 + manual 이라 읽고 답하기를 묻는다는 줄 (D-083)');
    assert.match(notes[2]?.[1] ?? '', /미분류가 3회 반복됐다/);
  });

  it('확신도 미만이면 카드 없이 직접 답하고 후보를 보인다', async () => {
    const c = conductSpy('어떤 작업인지 더 알려 주세요.\nSUGGEST: R05');
    const session = makeJev(c.exec, jevSpy(answer('R06', 0.36, { R06: 0.4, R05: 0.3, R07: 0.2, NONE: 0.1 })).classifier);
    const out = await session.send('버그도 고치고 테스트도 추가하고 성능도');
    assert.deepEqual(out.map((r) => r.kind), ['user', 'direct']);
    assert.match(out[1]?.kind === 'direct' ? (out[1].notes[0] ?? '') : '', /후보 R06 0\.40 · R05 0\.30 · R07 0\.20/);
  });

  it('Jev 를 못 쓰면 옛 경로 그대로다 — 규칙 · 지휘자 SUGGEST, 사유는 기록에 남는다', async () => {
    const c = conductSpy('작업으로 보입니다.\nSUGGEST: R03');
    const session = makeJev(c.exec, jevSpy(new JevUnavailableError('rate-limit', '429')).classifier);
    const out = await session.send('넌 누구니');
    assert.deepEqual(out.map((r) => r.kind), ['user', 'direct', 'plan']);
    const [, direct, plan] = out;
    assert.ok(direct?.kind === 'direct' && /^Jev 미사용 \(429 호출 한도 \(429\)\)/.test(direct.notes[0] ?? ''));
    assert.ok(plan?.kind === 'plan' && plan.reason === '지휘자 제안 R03');
  });

  it('Jev 로 나가는 맥락은 최근 2턴·1200자 이내다 — 대화 세션 맥락 상한과 따로다', async () => {
    const jev = jevSpy(answer('NONE', 1, { NONE: 1 }));
    const session = makeJev(conductSpy().exec, jev.classifier);
    for (const m of ['하나', '둘', '셋', '넷']) await session.send(m);
    const state = jev.requests.at(-1)?.state as { recent_conversation: string; message: string };
    assert.equal(state.message, '넷');
    assert.match(state.recent_conversation, /둘[\s\S]*셋/);
    assert.doesNotMatch(state.recent_conversation, /하나/);
    assert.ok(state.recent_conversation.length <= 1200);
  });

  it('행 지정(planAs)에는 Jev 를 부르지 않는다', async () => {
    const jev = jevSpy(answer('NONE', 1, { NONE: 1 }));
    const session = makeJev(conductSpy().exec, jev.classifier);
    await session.send('넌 누구니');
    const before = jev.requests.length;
    const out = await session.planAs('R02');
    assert.equal(jev.requests.length, before);
    assert.ok(out[0]?.kind === 'plan' && out[0].reason === '수동 지정 R02');
  });
});
