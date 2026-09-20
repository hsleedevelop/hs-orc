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
