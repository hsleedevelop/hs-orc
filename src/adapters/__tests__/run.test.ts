import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../run.ts';

const sh = (script: string, timeoutMs = 10_000) =>
  runProcess({ bin: '/bin/sh', argv: ['-c', script], cwd: process.cwd(), timeoutMs, format: 'claude' });

/** 이 파일이 띄운 손자 pid 전부. 마지막에 하나도 안 남았는지 확인한다. */
const spawnedGrandchildren: number[] = [];

const grandchildPidOf = (stderr: string): number => {
  const pid = Number(stderr.trim().split('\n')[0]);
  assert.ok(Number.isInteger(pid) && pid > 0, `손자 pid 를 못 읽었다: ${stderr}`);
  spawnedGrandchildren.push(pid);
  return pid;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * codex 흉내 (D-067 추가 실측 2 (c)): 셸 명령을 **새 세션·프로세스 그룹**(setsid — node `detached`)으로 띄우고,
 * SIGTERM 에는 명령을 정리하지 않고 끝난다. 손자 pid 를 stderr 첫 줄(또는 `pidFile`)로 알린다.
 * 손자의 pgid 가 엔진과 같으면 이 가짜는 검사할 경우를 만들지 못한 것이다 — 던져서 드러낸다.
 */
const newGroupEngineScript = (command: string, pidFile?: string): string => `
  const { spawn, execFileSync } = require('node:child_process');
  const c = spawn('/bin/sh', ['-c', ${JSON.stringify(command)}], { detached: true, stdio: 'ignore' });
  const pgid = (pid) => execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  setTimeout(() => {
    if (pgid(c.pid) === pgid(process.pid)) throw new Error('손자가 새 그룹을 만들지 않았다');
    ${pidFile ? `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));` : `process.stderr.write(c.pid + '\\n');`}
  }, 200);
  setInterval(() => {}, 1000);
`;
const newGroupEngine = (command: string) =>
  runProcess({ bin: process.execPath, argv: ['-e', newGroupEngineScript(command)], cwd: process.cwd(), timeoutMs: 30_000, format: 'claude' });

/** 실제 좀비 여부는 `kill -0` 로만 알 수 있다 — 종료를 기다리지 않고 단정하면 초록 거짓말이 된다. */
const waitGone = async (pid: number, ms = 5_000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
};

describe('프로세스 실행', () => {
  it('stdout 의 JSONL 을 파싱해 최종 텍스트와 사용량을 채운다', async () => {
    const line = JSON.stringify({ type: 'result', is_error: false, result: 'ok', usage: { input_tokens: 7, output_tokens: 3 } });
    const result = await sh(`printf '%s\\n' '${line}'`).result;
    assert.equal(result.outcome, 'ok');
    assert.equal(result.text, 'ok');
    assert.equal(result.usage?.inputTokens, 7);
  });

  it('codex 의 에이전트 메시지 여러 개는 빈 줄로 나눠 잇는다 — 문단이 뭉치지 않는다', async () => {
    const msg = (t: string) => JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: t } });
    const result = await runProcess({
      bin: '/bin/sh',
      argv: ['-c', `printf '%s\\n' '${msg('확인하겠습니다.')}' '${msg('고쳤습니다.')}'`],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      format: 'codex',
    }).result;
    assert.equal(result.text, '확인하겠습니다.\n\n고쳤습니다.');
  });

  it('개행 없이 끝난 마지막 줄도 잃지 않는다', async () => {
    const line = JSON.stringify({ type: 'result', is_error: false, result: '끝' });
    const result = await sh(`printf '%s' '${line}'`).result;
    assert.equal(result.text, '끝');
  });

  it('파싱이 실패해도 원본 stdout/stderr 를 보존한다 (SPEC §3.7)', async () => {
    const result = await sh(`printf 'garbage\\n'; printf 'boom\\n' >&2`).result;
    assert.match(result.rawStdout, /garbage/);
    assert.match(result.rawStderr, /boom/);
    assert.deepEqual(result.unparsedLines, ['garbage']);
  });

  it('0 이 아닌 종료 코드는 error 다', async () => {
    const result = await sh('exit 3').result;
    assert.equal(result.outcome, 'error');
    assert.equal(result.exitCode, 3);
  });
});

describe('취소와 타임아웃', () => {
  it('취소하면 손자 프로세스까지 죽는다 (좀비 없음)', async () => {
    // 자식(sh)이 손자(sleep)를 띄우고 손자 pid 를 stderr 로 알려 준다.
    const handle = sh('sleep 120 & echo $! >&2; wait');
    // 손자 pid 가 stderr 에 실릴 때까지 잠깐 기다린다.
    await new Promise((r) => setTimeout(r, 400));
    handle.cancel();
    const result = await handle.result;

    assert.equal(result.outcome, 'cancelled');
    const grandchild = grandchildPidOf(result.rawStderr);
    assert.equal(await waitGone(grandchild), true, `손자 ${grandchild} 가 살아남았다 (좀비)`);
  });

  it('타임아웃도 그룹째 종료하고 outcome 을 timeout 으로 남긴다', async () => {
    const handle = sh('sleep 120 & echo $! >&2; wait', 400);
    const result = await handle.result;
    assert.equal(result.outcome, 'timeout');
    const grandchild = grandchildPidOf(result.rawStderr);
    assert.equal(await waitGone(grandchild), true, `손자 ${grandchild} 가 살아남았다 (좀비)`);
  });

  it('SIGTERM 을 무시하는 자식도 유예 후 SIGKILL 로 죽는다', async () => {
    const handle = sh("trap '' TERM; sleep 120 & echo $! >&2; wait", 300);
    const result = await handle.result;
    assert.notEqual(result.outcome, 'ok');
    const grandchild = grandchildPidOf(result.rawStderr);
    assert.equal(await waitGone(grandchild, 8_000), true, `손자 ${grandchild} 가 살아남았다 (좀비)`);
  });

  it('취소 직후 호스트가 유예를 기다리지 않고 나가도 SIGTERM 무시 손자가 남지 않는다 (D-066)', async () => {
    const pidFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'hs-exit-')), 'pid');
    // 호스트 프로세스: SIGTERM 을 무시하는 손자를 띄우고 취소한 뒤 2초 유예 전에 process.exit 한다(chat 의 두 번째 Ctrl-C).
    const host = `
      import { runProcess } from ${JSON.stringify(new URL('../run.ts', import.meta.url).href)};
      const h = runProcess({ bin: '/bin/sh', argv: ['-c', "trap '' TERM; sleep 120 & echo $! > ${pidFile}; wait"], cwd: process.cwd(), timeoutMs: 60000, format: 'claude' });
      await new Promise((r) => setTimeout(r, 500));
      h.cancel();
      await new Promise((r) => setTimeout(r, 100));
      process.exit(130);
    `;
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', host], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(ran.status, 130, ran.stderr);
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(Number.isInteger(grandchild) && grandchild > 0);
    spawnedGrandchildren.push(grandchild);
    assert.equal(await waitGone(grandchild, 1_500), true, `손자 ${grandchild} 가 호스트 종료 뒤에도 살아남았다`);
  });

  it('취소하면 새 프로세스 그룹을 만든 손자도 죽는다 — 엔진이 정리 없이 끝나도 (Q24, D-078)', async () => {
    const handle = newGroupEngine('sleep 120');
    await new Promise((r) => setTimeout(r, 600));
    handle.cancel();
    const result = await handle.result;
    assert.equal(result.outcome, 'cancelled');
    const grandchild = grandchildPidOf(result.rawStderr);
    assert.equal(await waitGone(grandchild), true, `새 그룹 손자 ${grandchild} 가 살아남았다 (고아)`);
  });

  it('엔진이 SIGTERM 에 바로 끝나도 SIGTERM 을 무시하는 새 그룹 손자는 유예 뒤 SIGKILL 로 죽는다 (Q24, D-078)', async () => {
    const handle = newGroupEngine("trap '' TERM; exec sleep 120");
    await new Promise((r) => setTimeout(r, 600));
    handle.cancel();
    const result = await handle.result;
    const grandchild = grandchildPidOf(result.rawStderr);
    assert.equal(await waitGone(grandchild, 8_000), true, `새 그룹 손자 ${grandchild} 가 살아남았다 (고아)`);
  });

  it('취소 직후 호스트가 나가도 SIGTERM 을 무시하는 새 그룹 손자가 남지 않는다 (Q24, D-078)', async () => {
    const pidFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'hs-exit-')), 'pid');
    const host = `
      import { runProcess } from ${JSON.stringify(new URL('../run.ts', import.meta.url).href)};
      const h = runProcess({ bin: process.execPath, argv: ['-e', ${JSON.stringify(newGroupEngineScript("trap '' TERM; exec sleep 120", pidFile))}], cwd: process.cwd(), timeoutMs: 60000, format: 'claude' });
      await new Promise((r) => setTimeout(r, 800));
      h.cancel();
      await new Promise((r) => setTimeout(r, 100));
      process.exit(130);
    `;
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', host], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(ran.status, 130, ran.stderr);
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(Number.isInteger(grandchild) && grandchild > 0);
    spawnedGrandchildren.push(grandchild);
    assert.equal(await waitGone(grandchild, 1_500), true, `새 그룹 손자 ${grandchild} 가 호스트 종료 뒤에도 살아남았다`);
  });

  it('이 파일이 띄운 손자가 하나도 남지 않는다', () => {
    // pgrep -f 로 세지 않는다 — 검사 셸 자신의 커맨드라인이 패턴에 걸려 자기를 센다(실측).
    assert.ok(spawnedGrandchildren.length >= 7, '손자를 하나도 추적하지 못했다');
    assert.deepEqual(spawnedGrandchildren.filter(alive), []);
  });
});
