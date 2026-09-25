import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRecord, listSessions, prepareSession, readTranscript, transcriptPath, type TranscriptRecord } from '../transcript.ts';

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
});
