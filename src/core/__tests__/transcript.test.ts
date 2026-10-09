import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendRecord,
  legacyTranscriptPath,
  listSessions,
  prepareSession,
  readSessionLog,
  readTranscript,
  recordedStatus,
  transcriptPath,
  type TranscriptRecord,
} from '../transcript.ts';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'hs-transcript-'));
const user = (turn: number, text: string): TranscriptRecord => ({ v: 1, at: '2026-09-23T00:00:00.000Z', turn, kind: 'user', text });

describe('대화 기록 (SPEC §6.4.1)', () => {
  it('append 한 순서대로 다시 읽는다', () => {
    const file = transcriptPath(tmp(), '0923-1200-abc');
    appendRecord(file, user(1, '안녕'));
    appendRecord(file, user(2, '다음'));
    const loaded = readTranscript(file);
    assert.deepEqual(loaded.records.map((r) => r.turn), [1, 2]);
    assert.equal(loaded.broken, 0);
  });

  it('깨진 줄은 건너뛰고 센다 — 조용히 줄어든 대화는 거짓이다', () => {
    const file = transcriptPath(tmp(), 'x');
    appendRecord(file, user(1, 'a'));
    appendFileSync(file, '{깨진\n{"v":2,"turn":9}\n');
    appendRecord(file, user(2, 'b'));
    const loaded = readTranscript(file);
    assert.deepEqual(loaded.records.map((r) => r.turn), [1, 2]);
    assert.equal(loaded.broken, 2);
  });

  it('아직 없는 기록은 빈 대화다 — 던지지 않는다', () => {
    assert.deepEqual(readTranscript(path.join(tmp(), 'none.jsonl')), { records: [], broken: 0 });
  });

  it('없는 것 말고 읽기 오류는 던진다 — 빈 대화로 삼키면 다음 send 가 턴 1 을 다시 쓴다', () => {
    const file = transcriptPath(tmp(), 'dir');
    mkdirSync(file, { recursive: true }); // 읽으면 EISDIR
    assert.throws(() => readTranscript(file), /EISDIR/);
  });

  it('목록은 읽지 못한 기록 하나 때문에 통째로 실패하지 않는다 — 그 세션을 읽지 못했다고 보여준다', () => {
    const dir = tmp();
    appendRecord(transcriptPath(dir, 'good'), user(1, '안녕'));
    mkdirSync(transcriptPath(dir, 'bad'), { recursive: true });
    const byId = new Map(listSessions(dir, 'project').map((s) => [s.id, s.preview]));
    assert.equal(byId.get('good'), '안녕');
    assert.equal(byId.get('bad'), '(읽지 못한 기록)');
  });

  it('스크래치는 HS_ORC_SCRATCH 안에 폴더를 만들고, project 는 만들지 않는다', () => {
    const root = tmp();
    const scratch = prepareSession('scratch', '/unused', { HS_ORC_SCRATCH: root });
    assert.equal(path.dirname(scratch.dir), root);
    assert.ok(existsSync(scratch.dir));
    assert.equal(path.basename(scratch.dir), scratch.id);
    const project = prepareSession('project', '/some/project', { HS_ORC_SCRATCH: root });
    assert.equal(project.dir, '/some/project');
    assert.match(project.id, /^\d{4}-\d{4}-[0-9a-f]{3}$/);
  });

  it('폴더의 세션을 최근 것부터 나열하고 첫 메시지를 미리보기로 쓴다', () => {
    const dir = tmp();
    appendRecord(transcriptPath(dir, 'a'), { ...user(1, '옛날'), at: '2026-09-22T00:00:00.000Z' });
    appendRecord(transcriptPath(dir, 'b'), { ...user(1, '최근'), at: '2026-09-23T00:00:00.000Z' });
    const list = listSessions(dir, 'project');
    assert.deepEqual(list.map((s) => [s.id, s.preview]), [['b', '최근'], ['a', '옛날']]);
    assert.deepEqual(listSessions(path.join(dir, 'none'), 'project'), []);
  });

  it('목록 행에 세션의 spend 합을 싣는다 — 청구액과 환산액을 섞지 않고, 내역 모르는 캐시 읽기는 하한으로 적는다', () => {
    const dir = tmp();
    const at = '2026-09-23T00:00:00.000Z';
    const file = transcriptPath(dir, 'spent');
    appendRecord(file, user(1, '안녕'));
    appendRecord(file, { v: 1, at, turn: 1, kind: 'spend', tokens: 1000, cacheReadTokens: 600, unreported: 0,
      charges: [{ label: 'a', usd: 0.01, source: 'actual', plan: 'subscription' }] });
    appendRecord(file, { v: 1, at, turn: 2, kind: 'spend', tokens: 500, unreported: 0,
      charges: [{ label: 'b', usd: 0.02, source: 'metered', plan: 'api' }] });
    appendRecord(transcriptPath(dir, 'free'), user(1, '무료'));

    const byId = new Map(listSessions(dir, 'project').map((s) => [s.id, s.usage]));
    assert.deepEqual(byId.get('spent'), { tokens: 1500, cacheReadTokens: 600, cacheReadPartial: true, billedUsd: 0.02, convertedUsd: 0.01 });
    assert.equal(byId.get('free'), undefined);
  });

  it('기록은 세션 폴더가 아니라 홈의 프로젝트 상태에 쓴다 (D-071)', () => {
    const dir = tmp();
    const file = transcriptPath(dir, 'a');
    assert.equal(path.relative(dir, file).startsWith('..'), true, `세션 폴더 안이다: ${file}`);
    assert.equal(path.dirname(path.dirname(path.dirname(file))), process.env['HS_ORC_PROJECT_STATE']);
  });

  it('옛 자리(D-071 이전)의 세션도 목록에 뜨고, 이어 쓴 새 자리 기록과 이어 읽는다 — 옛 파일은 건드리지 않는다', () => {
    const dir = tmp();
    appendRecord(legacyTranscriptPath(dir, 'old'), user(1, '옛 자리'));
    appendFileSync(legacyTranscriptPath(dir, 'old'), '{깨진\n');
    appendRecord(transcriptPath(dir, 'old'), user(2, '이어 씀'));
    appendRecord(transcriptPath(dir, 'new'), user(1, '새 자리'));

    const loaded = readSessionLog(dir, 'old');
    assert.deepEqual(loaded.records.map((r) => r.turn), [1, 2]);
    assert.equal(loaded.broken, 1);
    assert.deepEqual(listSessions(dir, 'project').map((s) => s.id).sort(), ['new', 'old']);
    assert.equal(readTranscript(legacyTranscriptPath(dir, 'old')).records.length, 1);
  });
});

describe('목록 상태·역할 (D-085 · D-090)', () => {
  const at = '2026-10-09T00:00:00.000Z';
  const result: TranscriptRecord = { v: 1, at, turn: 1, kind: 'result', outcome: 'ok', verdict: 'pass', text: '', review: '', evidence: '', decisionId: 'd' };

  it('결과 뒤의 설정 줄(역할 · 지휘자 · 방식 · 이름 · 비용)은 완료를 가리지 않는다', () => {
    for (const tail of [
      { kind: 'role', role: 'orchestrator' },
      { kind: 'orchestrator', model: 'opus', effort: 'high' },
      { kind: 'mode', mode: 'auto' },
      { kind: 'name', name: 'web' },
    ] as const) {
      assert.deepEqual(recordedStatus([user(1, '고쳐줘'), result, { v: 1, at, turn: 1, ...tail }]), { state: 'done', outcome: 'ok' }, tail.kind);
    }
  });

  it('목록 행에 역할을 싣는다 — role 줄이 없으면 워커, 마지막 것이 이긴다', () => {
    const dir = tmp();
    appendRecord(transcriptPath(dir, 'old'), user(1, '옛 세션'));
    appendRecord(transcriptPath(dir, 'orc'), { v: 1, at, turn: 0, kind: 'role', role: 'orchestrator' });
    appendRecord(transcriptPath(dir, 'back'), { v: 1, at, turn: 0, kind: 'role', role: 'orchestrator' });
    appendRecord(transcriptPath(dir, 'back'), { v: 1, at, turn: 0, kind: 'role', role: 'worker' });
    const roles = Object.fromEntries(listSessions(dir, 'project').map((s) => [s.id, s.role]));
    assert.deepEqual(roles, { old: 'worker', orc: 'orchestrator', back: 'worker' });
  });
});
