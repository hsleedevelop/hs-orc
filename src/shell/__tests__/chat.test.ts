/**
 * `hs-orc chat` (D-056). 실행기는 전부 가짜다 — 이 파일이 돈을 쓰면 아무도 안 돌린다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { SlotExecutor } from '../../core/executor.ts';
import { Journal } from '../../core/journal.ts';
import { prepareSession, type TranscriptRecord } from '../../core/transcript.ts';
import { assembleSession, restoreBudget } from '../conversation.ts';
import { renderRecord, runChat } from '../chat.ts';

const at = { v: 1 as const, at: '2026-09-26T00:00:00.000Z', turn: 1 };

describe('chat — 기록 렌더', () => {
  it('직접 답은 본문·비용을 찍고, 제안이 있으면 /task 명령을 알려준다', () => {
    const lines = renderRecord({ ...at, kind: 'direct', text: '안녕하세요', suggest: 'R01', cost: '$0.0110 actual', notes: [] });
    assert.deepEqual(lines, ['안녕하세요', '비용   $0.0110 actual', '제안   R01 — /task R01 로 위임한다']);
  });

  it('배정은 두 슬롯과 추정 비용을 찍는다', () => {
    const lines = renderRecord({
      ...at, kind: 'plan', taskId: 'R01', title: '타입 에러', reason: '규칙', primary: 'Luna·low → codex/x', reviewer: 'Haiku·low → claude/y', estimateUsd: 0.5, notes: [],
    });
    assert.deepEqual(lines, ['업무   R01 타입 에러  (규칙)', '배정   primary  Luna·low → codex/x', '       reviewer Haiku·low → claude/y', '비용   $0.5 (추정)']);
  });

  it('맥락을 잘랐으면 잘린 양을 알린다 (D-053)', () => {
    const lines = renderRecord({ ...at, kind: 'direct', text: '답', suggest: null, cost: '$0 x', notes: [], cut: { turns: 2, chars: 300 } });
    assert.ok(lines.includes('맥락   앞 대화 2턴·300자를 싣지 못했다'));
  });

  it('spend 줄은 화면에 찍지 않는다 (D-054)', () => {
    assert.deepEqual(renderRecord({ ...at, kind: 'spend', charges: [], tokens: 0, unreported: 0 } as unknown as TranscriptRecord), []);
  });
});

const drive = async (lines: readonly string[]) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hs-chat-'));
  process.env['HS_ORC_DECISION_LOG'] = path.join(tmp, 'log.jsonl');
  process.env['HS_ORC_RUN_STORE'] = path.join(tmp, 'runs');
  process.env['HS_ORC_SCRATCH'] = path.join(tmp, 'scratch');
  const calls: string[] = [];
  const exec: SlotExecutor = (slot, prompt) => {
    calls.push(slot.label);
    return Promise.resolve({ ok: true, text: slot.label === 'Haiku' ? 'PASS' : `ran:${prompt}`, rawStdout: '', rawStderr: '', durationMs: 1 });
  };
  const { dir, id } = prepareSession('scratch', process.cwd());
  const budget = restoreBudget(dir, id);
  const session = assembleSession({ kind: 'scratch', dir, id, budget, journal: new Journal(), execute: exec });
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
    assert.deepEqual(session.records().filter((r) => r.kind !== 'spend').map((r) => r.kind), ['user', 'direct']);
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

  it('/quit 뒤의 줄은 처리하지 않는다', async () => {
    const { calls } = await drive(['/quit', '넌 누구니']);
    assert.deepEqual(calls, []);
  });
});
