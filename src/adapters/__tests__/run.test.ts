import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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

  it('이 파일이 띄운 손자가 하나도 남지 않는다', () => {
    // pgrep -f 로 세지 않는다 — 검사 셸 자신의 커맨드라인이 패턴에 걸려 자기를 센다(실측).
    assert.ok(spawnedGrandchildren.length >= 3, '손자를 하나도 추적하지 못했다');
    assert.deepEqual(spawnedGrandchildren.filter(alive), []);
  });
});
