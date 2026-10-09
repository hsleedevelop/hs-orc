/**
 * 세션 종료·보관 표식 (D-089) — 기록 밖의 사이드카다. 기록을 세는 모든 것(lastEvent·상태·Budget 재생·isStale)이 그대로인지 본다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lockPath } from '../session-lock.ts';
import { metaPath, readSessionMeta, setArchived, setEnded } from '../session-meta.ts';
import { appendRecord, listSessions, readSessionLog, transcriptPath, type TranscriptEntry } from '../transcript.ts';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'hs-meta-'));
const add = (dir: string, id: string, entry: TranscriptEntry): void =>
  appendRecord(transcriptPath(dir, id), { ...entry, v: 1, at: '2026-10-09T00:00:00.000Z', turn: 1 });

describe('세션 종료·보관 표식 (D-089)', () => {
  it('표식은 기록 밖이다 — 기록 수는 그대로, 목록은 사이드카를 세션으로 세지 않고 종료·보관을 싣는다', () => {
    const dir = tmp();
    add(dir, 's1', { kind: 'user', text: '넌 누구니' });
    add(dir, 's1', { kind: 'result', outcome: 'ok', verdict: 'pass', text: '', review: '', evidence: '', decisionId: 'd' });
    setEnded(dir, 's1', true);
    setArchived(dir, 's1', true);
    assert.equal(readSessionLog(dir, 's1').records.length, 2, '기록에 줄을 붙이면 isStale·Budget 재생·lastEvent 가 흔들린다');
    assert.ok(readdirSync(path.dirname(metaPath(dir, 's1'))).includes('s1.meta.json'));
    const [only, ...rest] = listSessions(dir, 'project');
    assert.equal(rest.length, 0);
    assert.equal(only?.status?.state, 'ended');
    assert.equal(only?.archived, true);

    setEnded(dir, 's1', false);
    setArchived(dir, 's1', false);
    const back = listSessions(dir, 'project')[0];
    assert.equal(back?.status?.state, 'done', '풀면 기록이 말하는 상태로 돌아간다');
    assert.equal(back?.archived, undefined);
  });

  it('살아 있는 점유가 종료보다 앞선다 — 도는 프로세스가 가장 정확한 사실이다', () => {
    const dir = tmp();
    add(dir, 's2', { kind: 'user', text: '넌 누구니' });
    setEnded(dir, 's2', true);
    mkdirSync(path.dirname(lockPath(dir, 's2')), { recursive: true });
    writeFileSync(lockPath(dir, 's2'), JSON.stringify({ pid: process.ppid, by: 'chat', state: 'working', at: '' }));
    assert.equal(listSessions(dir, 'project')[0]?.status?.state, 'working');
  });

  it('깨진 표식은 빈 표식이다 — 세션을 못 열게 하지 않는다', () => {
    const dir = tmp();
    mkdirSync(path.dirname(metaPath(dir, 's3')), { recursive: true });
    writeFileSync(metaPath(dir, 's3'), '{깨짐');
    assert.deepEqual(readSessionMeta(dir, 's3'), {});
  });
});
