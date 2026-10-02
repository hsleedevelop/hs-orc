/**
 * `hs-orc chat` (D-056). 실행기는 전부 가짜다 — 이 파일이 돈을 쓰면 아무도 안 돌린다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { SlotExecutor } from '../../core/executor.ts';
import { Journal } from '../../core/journal.ts';
import { appendRecord, prepareSession, transcriptPath, type TranscriptRecord } from '../../core/transcript.ts';
import { assembleSession, restoreBudget } from '../conversation.ts';
import type { ApprovalMode } from '../../data/limits.ts';
import { findSession, interruptGuard, openingLines, parseChatArgs, renderRecord, runChat } from '../chat.ts';

const at = { v: 1 as const, at: '2026-09-26T00:00:00.000Z', turn: 1 };

describe('chat — 기록 렌더', () => {
  it('직접 답은 본문·비용을 찍고, 제안이 있으면 그 행을 알린다 — 배정 카드가 곧이어 붙는다', () => {
    const lines = renderRecord({ ...at, kind: 'direct', text: '안녕하세요', suggest: 'R01', cost: '$0.0110 actual', notes: [] });
    assert.deepEqual(lines, ['안녕하세요', '비용   $0.0110 actual', '제안   R01 (지휘자)']);
  });

  it('배정은 두 슬롯과 추정 비용을 찍는다', () => {
    const lines = renderRecord({
      ...at, kind: 'plan', taskId: 'R01', title: '타입 에러', reason: '규칙', primary: 'Luna·low → codex/x', reviewer: 'Haiku·low → claude/y', estimateUsd: 0.5, notes: [],
    });
    assert.deepEqual(lines, ['업무   R01 타입 에러  (규칙)', '배정   primary  Luna·low → codex/x', '       reviewer Haiku·low → claude/y', '비용   $0.5 (추정)']);
  });

  it('사다리 ④ 배정은 더한 reviewer 를 한 줄 더 찍는다 — 옛 기록(reviewer2 없음)은 위처럼 두 슬롯 그대로다 (D-072)', () => {
    const lines = renderRecord({
      ...at, kind: 'plan', taskId: 'R01', title: '타입 에러', reason: '사다리', primary: 'Terra·high → codex/x', reviewer: 'Haiku·low → claude/y', reviewer2: 'Sonnet·low → claude/z', estimateUsd: 6.7, notes: [],
    });
    assert.deepEqual(lines.slice(1, 4), ['배정   primary  Terra·high → codex/x', '       reviewer Haiku·low → claude/y', '       reviewer Sonnet·low → claude/z  (사다리 ④ 추가 — 둘 다 PASS 일 때만 PASS)']);
  });

  it('맥락을 잘랐으면 잘린 양을 알린다 (D-053)', () => {
    const lines = renderRecord({ ...at, kind: 'direct', text: '답', suggest: null, cost: '$0 x', notes: [], cut: { turns: 2, chars: 300 } });
    assert.ok(lines.includes('맥락   앞 대화 2턴·300자를 싣지 못했다'));
  });

  it('엔진이 압축했으면 결과 아래 알린다 (D-058)', () => {
    const lines = renderRecord({
      ...at, kind: 'result', outcome: 'ok', verdict: 'pass', text: '고쳤다', review: '', evidence: 'e', decisionId: 'd',
      compacted: [{ trigger: 'auto', preTokens: 180000, postTokens: 12000 }, { trigger: 'manual' }],
    });
    assert.ok(lines.includes('압축   엔진이 앞 맥락을 요약으로 바꿨다 (auto 180000→12000 토큰)'));
    assert.ok(lines.includes('압축   엔진이 앞 맥락을 요약으로 바꿨다 (manual)'));
  });

  it('spend 줄은 화면에 찍지 않는다 (D-054)', () => {
    assert.deepEqual(renderRecord({ ...at, kind: 'spend', charges: [], tokens: 0, unreported: 0 } as unknown as TranscriptRecord), []);
  });
});

const drive = async (lines: readonly string[], suggest?: string, mode: ApprovalMode = 'manual', kind: 'scratch' | 'project' = 'scratch') => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hs-chat-'));
  process.env['HS_ORC_DECISION_LOG'] = path.join(tmp, 'log.jsonl');
  process.env['HS_ORC_RUN_STORE'] = path.join(tmp, 'runs');
  process.env['HS_ORC_SCRATCH'] = path.join(tmp, 'scratch');
  const calls: string[] = [];
  const exec: SlotExecutor = (slot, prompt) => {
    calls.push(slot.label);
    // 직접 답 프롬프트에만 [이번 메시지] 가 든다 — suggest 가 주어지면 그 행을 제안한다.
    if (suggest && prompt.includes('[이번 메시지]')) return Promise.resolve({ ok: true, text: `제안한다.\nSUGGEST: ${suggest}`, rawStdout: '', rawStderr: '', durationMs: 1 });
    return Promise.resolve({ ok: true, text: slot.label === 'Haiku' ? 'PASS' : `ran:${prompt}`, rawStdout: '', rawStderr: '', durationMs: 1 });
  };
  const { dir, id } = prepareSession(kind, kind === 'project' ? tmp : process.cwd());
  const budget = restoreBudget(dir, id);
  const session = assembleSession({ approvalMode: mode, kind, dir, id, budget, journal: new Journal(), execute: exec });
  let out = '';
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });
  await runChat(session, budget, { input: Readable.from([lines.map((l) => `${l}\n`).join('')]), output }, { verify: [] });
  return { out, calls, session };
};

describe('chat — 입력 루프', () => {
  it('잡담은 지휘자가 직접 답한다', async () => {
    const { out, session } = await drive(['넌 누구니']);
    assert.match(out, /나 {5}넌 누구니/);
    assert.deepEqual(session.records().filter((r) => r.kind !== 'spend' && r.kind !== 'mode').map((r) => r.kind), ['user', 'direct']);
  });

  it('배정이 뜨면 y 로 읽기 전용 위임하고 누적을 찍는다', async () => {
    const { out, session } = await drive(['이 타입 에러 고쳐줘', 'y']);
    assert.match(out, /업무 {3}R01/);
    assert.match(out, /승인 {3}읽기 전용/);
    assert.match(out, /누적 {3}/);
    assert.ok(session.records().some((r) => r.kind === 'result'));
    assert.equal(session.state, 'waiting_input');
  });

  it('n 은 거절하고 엔진을 띄우지 않는다', async () => {
    const { calls, session } = await drive(['이 타입 에러 고쳐줘', 'n']);
    assert.deepEqual(calls, []);
    assert.ok(session.records().some((r) => r.kind === 'approval' && !r.approved));
  });

  it('스크래치에서 w 는 오류 한 줄 뒤 승인 대기로 남고, 이어서 y 가 위임한다', async () => {
    const { out, session } = await drive(['이 타입 에러 고쳐줘', 'w', 'y']);
    assert.match(out, /오류 {3}.*쓰기를 켤 수 없다/);
    assert.ok(session.records().some((r) => r.kind === 'approval' && r.approved && !r.write));
  });

  it('입력이 승인 대기 중에 끝나면 승인하지 않고 끝난다', async () => {
    const { calls, session } = await drive(['이 타입 에러 고쳐줘']);
    assert.deepEqual(calls, []);
    assert.equal(session.records().at(-1)?.kind, 'plan');
  });

  it('빈 줄·모르는 명령·형식 틀린 /task 는 유료 호출도 턴도 만들지 않는다', async () => {
    const { out, calls, session } = await drive(['', '   ', '/foo', '/task', '/task 1']);
    assert.deepEqual(calls, []);
    assert.equal(session.records().length, 0);
    assert.match(out, /모르는 명령이다: \/foo/);
  });

  it('/task Rxx 는 마지막 메시지를 그 행으로 배정한다', async () => {
    const { session } = await drive(['넌 누구니', '/task R02']);
    const plan = session.records().findLast((r) => r.kind === 'plan');
    assert.equal(plan?.kind === 'plan' ? plan.taskId : '', 'R02');
  });

  it('승인 대기가 아닐 때 온 y·w·n·a 는 메시지로 보내지 않는다 — 위임 중 미리 친 답이 유료 직접 답으로 새지 않는다', async () => {
    const { out, calls, session } = await drive(['넌 누구니', 'y', 'n']);
    assert.equal(calls.length, 1, '첫 메시지의 지휘자 1회뿐');
    assert.equal(session.records().filter((r) => r.kind === 'user').length, 1);
    assert.match(out, /승인 대기 중인 배정이 없다/);
  });

  it('승인 대기 중에도 /quit 은 승인하지 않고 나가고, /help 는 도움말을 보여준 뒤 계속 묻는다', async () => {
    const { out, calls, session } = await drive(['이 타입 에러 고쳐줘', '/help', '/quit', 'y']);
    assert.deepEqual(calls, []);
    assert.equal(session.records().at(-1)?.kind, 'plan');
    assert.match(out, /명령 {3}메시지를 그냥 쓰면/);
    assert.doesNotMatch(out, /y·w·n·a 중 하나로 답한다/);
  });

  it('지휘자 제안은 곧바로 배정 카드가 되고 y 한 번으로 위임한다 — 사유는 지휘자 제안', async () => {
    const { out, session } = await drive(['넌 누구니', 'y'], 'R01');
    assert.match(out, /제안 {3}R01 \(지휘자\)/);
    assert.match(out, /업무 {3}R01 .*\(지휘자 제안 R01\)/);
    assert.deepEqual(session.records().filter((r) => r.kind !== 'spend' && r.kind !== 'mode').map((r) => r.kind), ['user', 'direct', 'plan', 'approval', 'result', 'summary']);
  });

  it('카드가 선 채 공백이 든 문장을 쓰면 거절하고 새 메시지로 보낸다 — 한 단어는 되묻는다', async () => {
    const { out, session } = await drive(['넌 누구니', 'yes', '아니 그냥 얘기하자'], 'R01');
    assert.match(out, /y·w·n·a 중 하나로 답한다/);
    const kinds = session.records().filter((r) => r.kind !== 'spend' && r.kind !== 'mode').map((r) => r.kind);
    assert.deepEqual(kinds, ['user', 'direct', 'plan', 'approval', 'user', 'direct', 'plan']);
    assert.ok(session.records().some((r) => r.kind === 'approval' && !r.approved));
  });

  it('/quit 뒤의 줄은 처리하지 않는다', async () => {
    const { calls } = await drive(['/quit', '넌 누구니']);
    assert.deepEqual(calls, []);
  });
});

describe('chat — 진입', () => {
  it('인자를 읽고, 모르는 옵션과 --scratch·--resume 동시 지정은 던진다', () => {
    assert.deepEqual(parseChatArgs(['--scratch', '--verify', 'npm test']), { scratch: true, list: false, help: false, verify: ['npm test'] });
    assert.equal(parseChatArgs(['--resume', 'abc']).resume, 'abc');
    assert.throws(() => parseChatArgs(['--oops']), /모르는 옵션/);
    assert.throws(() => parseChatArgs(['--resume']), /값이 없다/);
    assert.throws(() => parseChatArgs(['--scratch', '--resume', 'x']), /함께 쓸 수 없다/);
  });

  it('--help 는 도움말 요청으로 읽는다', () => {
    assert.equal(parseChatArgs(['--help']).help, true);
    assert.equal(parseChatArgs([]).help, false);
  });

  it('다시 열 때 깨진 기록 줄 수를 알린다 (SPEC §6.4.1)', async () => {
    const { session } = await drive(['넌 누구니']);
    appendFileSync(transcriptPath(session.dir, session.id), '{깨진 줄\n');
    const budget = restoreBudget(session.dir, session.id);
    const reopened = assembleSession({ approvalMode: 'manual', kind: 'scratch', dir: session.dir, id: session.id, budget, journal: new Journal() });
    assert.ok(openingLines(reopened, budget).includes('경고   기록에 깨진 줄 1개 — 건너뛰고 보여준다'));
  });

  it('없는 세션 id 는 찾지 못한다', () => {
    process.env['HS_ORC_SCRATCH'] = mkdtempSync(path.join(os.tmpdir(), 'hs-chat-none-'));
    assert.equal(findSession(mkdtempSync(path.join(os.tmpdir(), 'hs-chat-cwd-')), 'nope'), undefined);
  });

  it('스크래치 세션을 id 로 찾는다', async () => {
    const { session } = await drive(['넌 누구니']);
    assert.equal(findSession(process.cwd(), session.id)?.dir, session.dir);
  });

  it('위임 도중 끊긴 세션을 다시 열면 끊김을 알린다', async () => {
    const { session } = await drive(['이 타입 에러 고쳐줘']);
    appendRecord(transcriptPath(session.dir, session.id), { v: 1, at: new Date().toISOString(), turn: 1, kind: 'approval', approved: true, write: false });
    const budget = restoreBudget(session.dir, session.id);
    const reopened = assembleSession({ approvalMode: 'manual', kind: 'scratch', dir: session.dir, id: session.id, budget, journal: new Journal() });
    assert.ok(openingLines(reopened, budget).some((l) => l.startsWith('끊김')));
  });

  it('승인 안 된 배정으로 끝난 세션은 그 배정을 되살리지 않는다고 알린다', async () => {
    const { session } = await drive(['이 타입 에러 고쳐줘']);
    const budget = restoreBudget(session.dir, session.id);
    const reopened = assembleSession({ approvalMode: 'manual', kind: 'scratch', dir: session.dir, id: session.id, budget, journal: new Journal() });
    assert.ok(openingLines(reopened, budget).some((l) => l.includes('되살리지 않는다') && l.includes('/task R01')));
    assert.equal(reopened.state, 'waiting_input');
  });
});

describe('chat — Ctrl-C', () => {
  it('취소할 위임이 아닌 실행(직접 답·요약)이 도는 중이면 첫 Ctrl-C 는 경고만 하고 기다린다, 두 번째는 나간다', () => {
    const lines: string[] = [];
    const guard = interruptGuard({ state: 'working', records: () => [], cancel: () => false }, (l) => lines.push(l));
    assert.equal(guard(), 'wait');
    assert.match(lines.join('\n'), /엔진을 남겨 둔 채/);
    assert.equal(guard(), 'exit');
  });

  it('위임이 도는 중이면 첫 Ctrl-C 는 그 위임만 취소하고, 같은 위임 중 두 번째는 나간다 (D-066)', () => {
    const lines: string[] = [];
    let cancels = 0;
    const guard = interruptGuard({ state: 'working', records: () => [], cancel: () => { cancels += 1; return cancels === 1; } }, (l) => lines.push(l));
    assert.equal(guard(), 'wait');
    assert.equal(cancels, 1);
    assert.match(lines.join('\n'), /위임을 취소한다/);
    assert.doesNotMatch(lines.join('\n'), /엔진을 남겨 둔 채/);
    assert.equal(guard(), 'exit');
    assert.equal(cancels, 1, '두 번째는 취소를 다시 보내지 않고 나간다');
  });

  it('도는 위임을 Ctrl-C 로 취소하면 결과 줄을 찍고 세션은 다음 입력을 받는다 (D-066)', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'hs-chat-cancel-'));
    process.env['HS_ORC_DECISION_LOG'] = path.join(tmp, 'log.jsonl');
    process.env['HS_ORC_RUN_STORE'] = path.join(tmp, 'runs');
    process.env['HS_ORC_SCRATCH'] = path.join(tmp, 'scratch');
    const roles: string[] = [];
    const exec: SlotExecutor = (slot, prompt, options) => {
      roles.push(slot.role);
      if (slot.role === 'reviewer') return Promise.resolve({ ok: true, text: 'PASS', rawStdout: '', rawStderr: '', durationMs: 1 });
      if (prompt.includes('다시')) return Promise.resolve({ ok: true, text: 'ran', rawStdout: '', rawStderr: '', durationMs: 1 });
      return new Promise((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve({ ok: false, cancelled: true, text: '', rawStdout: '', rawStderr: '', durationMs: 1 }), { once: true });
      });
    };
    const { dir, id } = prepareSession('scratch', process.cwd());
    const budget = restoreBudget(dir, id);
    const session = assembleSession({ approvalMode: 'manual', kind: 'scratch', dir, id, budget, journal: new Journal(), execute: exec });
    let out = '';
    const output = new Writable({ write(chunk: Buffer, _enc, cb) { out += chunk.toString(); cb(); } });
    // 입력은 두 번에 나눠 준다 — 취소 뒤 줄이 그 위임 도중에 미리 쌓이지 않게(쌓이면 승인 답으로 읽힌다).
    const input = new Readable({ read() {} });
    const chat = runChat(session, budget, { input, output }, { verify: [] });
    input.push('이 타입 에러 고쳐줘\ny\n');
    for (let i = 0; i < 200 && !session.cancellable; i += 1) await new Promise<void>((r) => setImmediate(r));
    assert.equal(session.cancellable, true);

    const guard = interruptGuard(session, (l) => { out += `${l}\n`; });
    assert.equal(guard(), 'wait');
    for (let i = 0; i < 200 && session.state !== 'waiting_input'; i += 1) await new Promise<void>((r) => setImmediate(r));
    assert.equal(session.state, 'waiting_input');
    input.push('이 타입 에러 다시 고쳐줘\ny\n');
    for (let i = 0; i < 400 && !session.records().some((r) => r.kind === 'summary'); i += 1) await new Promise<void>((r) => setImmediate(r));
    input.push(null);
    await chat;

    assert.match(out, /결과 {3}취소됨 · 결정 /);
    assert.match(out, /증거 {3}취소됨 — primary 실행 중/);
    assert.deepEqual(roles.slice(0, 1), ['primary'], '취소한 위임은 reviewer 를 띄우지 않는다');
    const kinds = session.records().filter((r) => r.kind !== 'spend' && r.kind !== 'mode').map((r) => r.kind);
    assert.deepEqual(kinds, ['user', 'plan', 'approval', 'result', 'user', 'plan', 'approval', 'result', 'summary'], '취소 뒤 새 위임이 돈다');
  });

  it('입력 대기 중이면 바로 나간다', () => {
    const guard = interruptGuard({ state: 'waiting_input', records: () => [], cancel: () => false }, () => undefined);
    assert.equal(guard(), 'exit');
  });
});

describe('chat — 사다리 (D-068)', () => {
  it('/ladder 는 실패·미검증 뒤 상향 카드만 세운다 — y 로 승인하기 전에는 엔진을 더 띄우지 않고, 카드에 올라간 것이 찍힌다', async () => {
    const { out, calls, session } = await drive(['이 타입 에러 고쳐줘', 'y', '/ladder']);
    assert.match(out, /다음 {3}사다리 다음 단계: ①코드·로그·재현 조건 보강/);
    assert.match(out, /사다리 ①코드·로그·재현 조건 보강 — 결정 \S+ 의 같은 요청을 상향한다/);
    assert.match(out, / {7}①코드·로그·재현 조건 보강 — 직전 실패의 reviewer 검증·증거/);
    assert.equal(session.state, 'blocked');
    assert.equal(calls.filter((c) => c === 'Luna').length, 1, '상향 카드는 시작하지 않는다');
  });

  it('auto 에서도 사다리 카드는 묻는 이유 A3 를 찍고 자동 시작하지 않는다', async () => {
    const { out, calls, session } = await drive(['/mode auto', '이 타입 에러 고쳐줘', '/ladder']);
    assert.match(out, /묻는 이유 {2}A3 사다리 상향 배정/);
    assert.equal(calls.filter((c) => c === 'Luna').length, 1);
    assert.equal(session.state, 'blocked');
  });

  it('결과가 없거나 카드가 선 채면 세우지 않고 이유를 말한다', async () => {
    const none = await drive(['/ladder']);
    assert.match(none.out, /오류 {3}.*상향할 결과가 없다/);
    const blocked = await drive(['이 타입 에러 고쳐줘', '/ladder']);
    assert.match(blocked.out, /이미 선 배정이 있다/);
  });
});

describe('chat — 승인 방식 (D-064)', () => {
  it('/mode 는 지금 방식을 보이고, 바꾸면 기록에 남는다 — 모르는 방식은 거절한다', async () => {
    const { out, session } = await drive(['/mode', '/mode auto', '/mode auto', '/mode yolo'], undefined, 'manual');
    assert.match(out, /방식 {3}manual \(manual · auto-ask · auto\)/);
    assert.match(out, /방식 {3}승인 방식 → auto/);
    assert.match(out, /방식 {3}이미 auto/);
    assert.match(out, /모르는 방식이다: yolo/);
    assert.equal(session.mode, 'auto');
    assert.equal(session.records().filter((r) => r.kind === 'mode').length, 1);
  });

  it('auto 에서는 y 없이 시작한다 — 카드·자동 승인 줄·결과가 그대로 찍힌다', async () => {
    const { out, calls } = await drive(['/mode auto', '이 타입 에러 고쳐줘']);
    assert.match(out, /업무 {3}R\d{2} /);
    assert.match(out, /승인 {3}자동 승인 · auto · 묻는 조건 없음/);
    assert.match(out, /결과 {3}/);
    assert.ok(calls.length >= 2);
    assert.doesNotMatch(out, /승인\? /);
  });

  it('/write 는 auto 에서도 카드를 세우고 묻는 이유를 찍는다 — 자동 승인은 쓰기를 켜지 않는다', async () => {
    const { out, calls } = await drive(['/mode auto', '/write 이 타입 에러 고쳐줘'], undefined, 'manual', 'project');
    assert.match(out, /묻는 이유 {2}H2 쓰기를 켠 위임/);
    assert.doesNotMatch(out, /자동 승인/);
    assert.equal(calls.length, 0);
  });

  it('--approval 은 시작 인자로 파싱하고 모르는 값은 던진다', () => {
    assert.equal(parseChatArgs(['--approval', 'auto-ask']).approval, 'auto-ask');
    assert.equal(parseChatArgs([]).approval, undefined);
    assert.throws(() => parseChatArgs(['--approval', 'yolo']), /--approval 은/);
  });
});
