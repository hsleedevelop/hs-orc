/**
 * 대화 세션 (SPEC §6.4). 실행기는 전부 가짜다 — 이 파일이 돈을 쓰면 아무도 안 돌린다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { Budget } from '../budget.ts';
import { Journal } from '../journal.ts';
import type { SlotExecutor, SlotRun } from '../executor.ts';
import { ConversationSession, SessionStateError } from '../session.ts';
import { readDecisions } from '../decision-log.ts';

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
  const calls: { label: string; role: string; prompt: string; resume: string | undefined }[] = [];
  let primaries = 0;
  const exec: SlotExecutor = (slot, prompt, options) => {
    calls.push({ label: slot.label, role: slot.role, prompt, resume: options?.resume });
    if (slot.role === 'reviewer') return Promise.resolve(reply('PASS'));
    primaries += 1;
    const ok = primaries === 1 || secondOk;
    return Promise.resolve({ ...reply(ok ? 'ran' : '', ok), sessionId: `eng-${primaries}` });
  };
  return { exec, calls };
};

const make = (conduct: SlotExecutor, dir = mkdtempSync(path.join(os.tmpdir(), 'hs-session-')), execute = delegateSpy().exec) => {
  const budget = new Budget(20, 2_000_000);
  const session = new ConversationSession({
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

  it('맥락을 자르면 버린 양을 직접 답 기록에 남긴다 — 안 잘랐으면 남기지 않는다 (D-053)', async () => {
    const c = conductSpy();
    const session = new ConversationSession({
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
    // `.hs-orc` 자리에 평범한 파일을 둔다 — appendRecord 의 mkdirSync(`<dir>/.hs-orc/sessions`) 가
    // ENOTDIR 로 던진다. 어느 사용자 권한에서도 재현된다(chmod 불필요).
    const blocker = path.join(dir, '.hs-orc');
    writeFileSync(blocker, 'not a directory');
    const c = conductSpy();
    const { session } = make(c.exec, dir);
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
    assert.match(readDecisions(log)[0]?.note ?? '', /session 0923-1200-aaa$/);
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
    const last = out.at(-1);
    assert.ok(last?.kind === 'error' && /위임이 끝나지 못했다: 엔진 폭발/.test(last.text));
    assert.equal(session.state, 'waiting_input');
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
    const session = new ConversationSession({
      matrix, catalog, kind: 'scratch', dir: mkdtempSync(path.join(os.tmpdir(), 'hs-scratch-')), id: '0923-1200-bbb',
      budget, journal: new Journal(), conduct: conductSpy().exec, executorFor: () => delegateSpy().exec,
    });
    await session.send('이 타입 에러 고쳐줘');
    await assert.rejects(session.approve({ write: true }), SessionStateError);
    assert.equal(session.state, 'blocked');
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
    const session = new ConversationSession({
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
    const session = new ConversationSession({
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
