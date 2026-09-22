import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { assign } from '../assign.ts';
import { createExecutor } from '../executor.ts';

/**
 * 쓰기 권한 부여 지점은 `createExecutor` **한 곳**이고, 거기서 reviewer 가 구조적으로 배제된다 (D-025).
 * 판정 대상을 스스로 고칠 수 있는 reviewer 는 독립 검증자가 아니다 — 그래서 argv 를
 * **실제로 받은 프로세스**에서 읽어 증명한다. 어댑터 내부를 흉내내면 배선이 끊겨도 초록이 뜬다.
 *
 * 가짜 바이너리를 PATH 앞에 둔다. 진짜 엔진을 띄우지 않으므로 돈이 들지 않는다.
 */
const catalog = loadEngines();
const matrix = loadMatrix();
const row = matrix.assignments.find((a) => a.id === 'R01');
if (!row) throw new Error('R01 이 매트릭스에 없다.');
const plan = assign(matrix, catalog, row);

const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'hs-orc-fakebin-'));
const originalPath = process.env['PATH'] ?? '';

/** 받은 argv 를 파일로 남기고 곧바로 끝나는 가짜 엔진. */
function installFake(name: string): void {
  const file = path.join(fakeDir, name);
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@" > "${file}.argv"\nexit 0\n`, 'utf8');
  chmodSync(file, 0o755);
}

const argvOf = (name: string): string => readFileSync(path.join(fakeDir, `${name}.argv`), 'utf8');

before(() => {
  installFake('codex');
  installFake('claude');
  process.env['PATH'] = `${fakeDir}${path.delimiter}${originalPath}`;
});

after(() => {
  process.env['PATH'] = originalPath;
  rmSync(fakeDir, { recursive: true, force: true });
});

describe('쓰기 권한은 primary 슬롯만 받는다 (D-025)', () => {
  it('--write 를 켜도 reviewer 는 읽기 전용이다', async () => {
    const execute = createExecutor(catalog, fakeDir, 10_000, { write: true });
    await execute(plan.slots.primary, 'P');
    await execute(plan.slots.reviewer, 'R');

    assert.equal(plan.slots.primary.engine, 'codex');
    assert.match(argvOf('codex'), /workspace-write/);
    assert.equal(plan.slots.reviewer.engine, 'claude');
    assert.doesNotMatch(
      argvOf('claude'),
      /acceptEdits/,
      'reviewer 가 쓰기를 받았다 — 판정 대상을 스스로 고칠 수 있으면 독립 검증이 아니다.',
    );
  });

  it('옵션이 없으면 두 슬롯 다 읽기 전용이다 — 외부 쓰기는 옵트인이다', async () => {
    const execute = createExecutor(catalog, fakeDir, 10_000);
    await execute(plan.slots.primary, 'P');
    await execute(plan.slots.reviewer, 'R');
    assert.doesNotMatch(argvOf('codex'), /workspace-write/);
    assert.doesNotMatch(argvOf('claude'), /acceptEdits/);
  });
});

/**
 * SPEC §3.7 — 파싱 실패가 **원본 손실로 이어지지 않는다.**
 *
 * 어댑터는 원래부터 raw 를 보존했지만 `SlotRun` 에 그 자리가 없어 executor 경계에서 버려졌고,
 * 셸은 남은 `text` 를 "원시 로그" 라는 이름으로 디스크에 썼다. codex·cursor 의 토큰 보고가
 * 통째로 사라진 이유가 그것이다(2026-09-22 첫 실사용). 이 테스트가 그 경계를 고정한다.
 */
describe('원시 출력은 파싱과 무관하게 보존된다 (SPEC §3.7)', () => {
  const garbage = '{ 이건 JSON 이 아니다\n또 한 줄';

  it('파싱이 통째로 실패해도 stdout 원본이 그대로 올라온다', async () => {
    const file = path.join(fakeDir, 'claude');
    writeFileSync(file, `#!/bin/sh\nprintf '%s' '${garbage}'\nprintf '%s' 'stderr 한 줄' >&2\nexit 0\n`, 'utf8');
    chmodSync(file, 0o755);

    const run = await createExecutor(catalog, fakeDir, 10_000)(plan.slots.reviewer, 'R');
    assert.equal(run.text, '', '파싱된 텍스트는 비어야 한다 — 그래야 이 테스트가 raw 를 보는 것이다');
    assert.equal(run.rawStdout, garbage, 'text 가 아니라 **원본**이 보존돼야 한다');
    assert.equal(run.rawStderr, 'stderr 한 줄');
  });

  it('정상 응답에서도 raw 는 파싱 결과가 아니라 원본이다 — 토큰 보고가 여기 실려 온다', async () => {
    const line = JSON.stringify({ type: 'result', is_error: false, result: 'ok', usage: { input_tokens: 11, output_tokens: 5 } });
    const file = path.join(fakeDir, 'claude');
    writeFileSync(file, `#!/bin/sh\ncat <<'JSONL'\n${line}\nJSONL\n`, 'utf8');
    chmodSync(file, 0o755);

    const run = await createExecutor(catalog, fakeDir, 10_000)(plan.slots.reviewer, 'R');
    assert.equal(run.text, 'ok');
    assert.match(run.rawStdout, /input_tokens/, '사용량이 raw 에 없으면 단가 선언(D-027)이 소급 계산될 수 없다');
    assert.notEqual(run.rawStdout, run.text);
  });
});
