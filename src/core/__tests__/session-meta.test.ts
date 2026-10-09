/**
 * 세션 종료·보관 표식 (D-089) — 기록 밖의 사이드카다. 기록을 세는 모든 것(lastEvent·상태·Budget 재생·isStale)이 그대로인지 본다.
 */
import { describe, it, mock } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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

  it('두 프로세스의 복원·종료가 겹쳐도 서로의 칸을 지우지 않는다 — 복원이 읽고 쓰는 사이 붙은 endedAt 이 남는다 (PR #124 리뷰)', async () => {
    const dir = tmp();
    add(dir, 's4', { kind: 'user', text: '넌 누구니' });
    setArchived(dir, 's4', true);
    // 다른 GUI 프로세스의 종료 — 같은 세션의 endedAt 만 켠다.
    const other = [
      `import { setEnded } from ${JSON.stringify(path.resolve(import.meta.dirname, '../session-meta.ts'))};`,
      'setEnded(process.argv[1], process.argv[2], true);',
    ].join('\n');
    let child: ReturnType<typeof spawn> | null = null;
    const rename = fs.renameSync;
    // 복원이 옛 값을 읽고 바꿔 끼우기 직전 — 그 틈에 다른 프로세스가 종료하고, 늦게 끼운 복원이 그 칸을 덮는지 본다.
    mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (!child && String(to) === metaPath(dir, 's4')) {
        child = spawn(process.execPath, ['--input-type=module', '-e', other, dir, 's4'], { env: process.env, stdio: 'ignore' });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      }
      rename(from, to);
    });
    syncBuiltinESMExports();
    try {
      setArchived(dir, 's4', false);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
    const started = child as ReturnType<typeof spawn> | null;
    assert.ok(started, '복원이 바꿔 끼우는 자리를 지나야 한다');
    const code = await new Promise<number | null>((resolve) => started.once('exit', resolve));
    assert.equal(code, 0, '종료는 복원이 잠금을 놓은 뒤 이어서 된다');
    const meta = readSessionMeta(dir, 's4');
    assert.equal(meta.archivedAt, undefined);
    assert.ok(meta.endedAt, '잠그지 않으면 복원의 옛 스냅샷이 종료 표식을 지워 종료한 세션이 다시 쓰기 가능해진다');
    assert.equal(fs.existsSync(`${metaPath(dir, 's4')}.lock`), false);
  });

  it('죽은 프로세스가 남긴 갱신 잠금은 넘겨받는다', () => {
    const dir = tmp();
    mkdirSync(path.dirname(metaPath(dir, 's5')), { recursive: true });
    writeFileSync(`${metaPath(dir, 's5')}.lock`, JSON.stringify({ pid: 2 ** 22 + 12345 }));
    assert.ok(setEnded(dir, 's5', true).endedAt);
  });

  it('깨진 표식은 빈 표식이다 — 세션을 못 열게 하지 않는다', () => {
    const dir = tmp();
    mkdirSync(path.dirname(metaPath(dir, 's3')), { recursive: true });
    writeFileSync(metaPath(dir, 's3'), '{깨짐');
    assert.deepEqual(readSessionMeta(dir, 's3'), {});
  });
});
