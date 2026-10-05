/**
 * 세션 점유 표식과 목록 상태 (D-085). 다른 프로세스는 이 테스트를 띄운 부모(`process.ppid`)로 흉내 낸다 — 살아 있는 남의 pid 다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionBusyError, claimSession, foreignHold, lockPath, releaseSession, sessionHold } from '../session-lock.ts';
import { appendRecord, listSessions, recordedStatus, sessionName, transcriptPath, type TranscriptEntry, type TranscriptRecord } from '../transcript.ts';
import { markStateOrigin, stateOrigins } from '../project-state.ts';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'hs-lock-'));
const rec = (entry: TranscriptEntry, turn = 1): TranscriptRecord => ({ ...entry, v: 1, at: '2026-10-05T00:00:00.000Z', turn });
const foreign = (dir: string, id: string, pid = process.ppid): void => {
  mkdirSync(path.dirname(lockPath(dir, id)), { recursive: true });
  writeFileSync(lockPath(dir, id), JSON.stringify({ pid, by: 'gui', state: 'working', at: '2026-10-05T00:00:00.000Z' }));
};

describe('세션 점유 (D-085)', () => {
  it('쥐고 놓는다 — 첫 메시지 전(기록 폴더 없음)에도 쥔다', () => {
    const dir = tmp();
    claimSession(dir, 's1', 'working', 'cli');
    assert.equal(sessionHold(dir, 's1')?.state, 'working');
    assert.equal(foreignHold(dir, 's1'), null, '내 점유는 남의 것이 아니다');
    claimSession(dir, 's1', 'blocked', 'cli');
    assert.equal(sessionHold(dir, 's1')?.state, 'blocked');
    releaseSession(dir, 's1');
    assert.equal(existsSync(lockPath(dir, 's1')), false);
  });

  it('살아 있는 다른 프로세스가 쥐었으면 던지고, 그 점유는 놓지 않는다', () => {
    const dir = tmp();
    foreign(dir, 's2');
    assert.throws(() => claimSession(dir, 's2', 'working', 'cli'), SessionBusyError);
    assert.throws(() => claimSession(dir, 's2', 'working', 'cli'), /다른 곳\(gui · pid \d+\)에서 이 세션이 엔진이 도는 중/);
    releaseSession(dir, 's2');
    assert.equal(foreignHold(dir, 's2')?.pid, process.ppid);
  });

  it('죽은 pid 의 점유는 없는 것이다 — 넘겨받는다', () => {
    const dir = tmp();
    foreign(dir, 's3', 2 ** 22 + 12345);
    assert.equal(sessionHold(dir, 's3'), null);
    claimSession(dir, 's3', 'working', 'cli');
    assert.equal(sessionHold(dir, 's3')?.pid, process.pid);
  });
});

/**
 * 여러 프로세스가 같은 순간 claim 한다 — 시작 시각까지 바쁘게 기다렸다가 동시에 쥔다. 결과를 찍은 뒤 잠시 살아 있는다
 * (pid 가 살아 있어야 남의 점유다). 'wx' 직후의 빈 파일·죽은 표식을 둘이 함께 넘겨받던 결함의 회귀다 (PR #111 리뷰 1).
 */
async function race(dir: string, id: string, n: number): Promise<string[]> {
  const lock = path.resolve(import.meta.dirname, '../session-lock.ts');
  const code = `import { claimSession } from ${JSON.stringify(lock)};
const startAt = Number(process.argv[1]);
while (Date.now() < startAt) {}
try { claimSession(${JSON.stringify(dir)}, ${JSON.stringify(id)}, 'working', 'cli'); process.stdout.write('OK'); } catch { process.stdout.write('BUSY'); }
setTimeout(() => process.exit(0), 600);`;
  const startAt = String(Date.now() + 700);
  return Promise.all(
    Array.from({ length: n }, () => new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, startAt], { env: process.env });
      let out = '';
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('close', () => resolve(out));
    })),
  );
}

describe('세션 점유 — 동시 claim (D-085)', () => {
  it('새 자리든 죽은 표식이든 동시에 쥐면 하나만 이긴다', async () => {
    for (let round = 0; round < 4; round += 1) {
      const dir = tmp();
      if (round % 2 === 1) foreign(dir, 'r', 2 ** 22 + 777); // 죽은 pid 의 표식을 넘겨받는 경합
      const results = await race(dir, 'r', 6);
      assert.equal(results.filter((r) => r === 'OK').length, 1, `round ${round}: ${results.join(',')}`);
    }
  });
});

describe('목록 상태·이름 (D-085)', () => {
  it('기록 끝으로 상태를 정한다 — 비용·방식·이름 줄은 턴의 끝을 가리지 않는다', () => {
    const result = rec({ kind: 'result', outcome: 'rework', verdict: 'fail', text: '', review: '', evidence: '', decisionId: 'd' });
    assert.deepEqual(recordedStatus([]), { state: 'idle' });
    assert.deepEqual(recordedStatus([rec({ kind: 'user', text: 'a' }), rec({ kind: 'direct', text: 'b', suggest: null, cost: '', notes: [] })]), { state: 'idle' });
    assert.deepEqual(recordedStatus([result, rec({ kind: 'summary', text: '', next: '' }), rec({ kind: 'name', name: 'x' })]), { state: 'done', outcome: 'rework' });
    assert.deepEqual(recordedStatus([rec({ kind: 'approval', approved: true, write: false }), rec({ kind: 'mode', mode: 'auto' })]), { state: 'interrupted' });
    // 기록에만 남은 카드는 되살리지 않는다 — 승인 대기가 아니다.
    assert.deepEqual(recordedStatus([rec({ kind: 'plan', taskId: 'R01', title: '', reason: '', primary: '', reviewer: '', estimateUsd: 0, notes: [] })]), { state: 'idle' });
  });

  it('이름은 마지막 것이 이기고 빈 문자열은 지운다', () => {
    assert.equal(sessionName([rec({ kind: 'name', name: 'alpha' }), rec({ kind: 'name', name: 'beta' })]), 'beta');
    assert.equal(sessionName([rec({ kind: 'name', name: 'alpha' }), rec({ kind: 'name', name: '' })]), undefined);
  });

  it('목록은 점유를 기록보다 앞세우고 이름을 싣는다', () => {
    const dir = tmp();
    appendRecord(transcriptPath(dir, 'a1'), rec({ kind: 'name', name: 'web' }));
    appendRecord(transcriptPath(dir, 'a1'), rec({ kind: 'user', text: '안녕' }));
    assert.deepEqual(listSessions(dir, 'project')[0]?.status, { state: 'idle' });
    assert.equal(listSessions(dir, 'project')[0]?.name, 'web');
    foreign(dir, 'a1');
    assert.deepEqual(listSessions(dir, 'project')[0]?.status, { state: 'working', holder: { pid: process.ppid, by: 'gui' } });
    assert.equal(listSessions(dir, 'project').length, 1, '점유 파일은 세션으로 잡히지 않는다');
  });

  it('상태 폴더에 작업 폴더를 남겨 거꾸로 찾는다', () => {
    const dir = tmp();
    markStateOrigin(dir);
    markStateOrigin(dir);
    assert.ok(stateOrigins().includes(path.resolve(dir)));
  });
});
