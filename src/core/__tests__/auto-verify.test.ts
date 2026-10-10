import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLimits } from '../../data/limits.ts';
import { autoCommands, sandboxVerdict } from '../auto-verify.ts';

const folder = (files: Record<string, string>): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-auto-verify-'));
  for (const [file, body] of Object.entries(files)) writeFileSync(path.join(dir, file), body, 'utf8');
  return dir;
};
const cmds = (dir: string, row: string, verify: Record<string, unknown> = {}, exclude: readonly string[] = []) => {
  const file = path.join(dir, 'verify.json');
  writeFileSync(file, JSON.stringify(verify), 'utf8');
  return autoCommands(dir, row, loadLimits().verifyScripts, file, exclude);
};

describe('Core 가 고르는 검증 명령 (D-096 W1 + W2)', () => {
  it('lint·typecheck 는 모든 쓰기 행, test 는 R01·R04·R06 에만 — typecheck 가 type-check 를 이기고, 매니저는 잠금 파일로 고른다', () => {
    const dir = folder({
      'package.json': JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc', 'type-check': 'tsc -b', test: 'vitest run', build: 'next build' } }),
      'pnpm-lock.yaml': '',
    });
    assert.deepEqual(cmds(dir, 'R01').commands.map((c) => c.cmd), ['pnpm run lint', 'pnpm run typecheck', 'pnpm run test']);
    assert.deepEqual(cmds(dir, 'R03').commands.map((c) => c.cmd), ['pnpm run lint', 'pnpm run typecheck']);
  });

  it('선언(phase 없는 것)이 먼저 오고, phase 선언은 돌리지 않고 남기며, 같은 명령(npm test ≡ npm run test·사람이 적은 것)은 한 번만이다', () => {
    const dir = folder({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'node --test' } }) });
    const picked = cmds(dir, 'R01', { default: ['npm run check'], R01: ['npm test', 'before:npm test'] }, ['npm run lint']);
    assert.deepEqual(picked.commands.map((c) => c.cmd), ['npm run check', 'npm test']);
    assert.deepEqual(picked.commands[0]?.argv, ['/bin/sh', '-c', 'npm run check']);
    assert.match(picked.notes[0] ?? '', /phase 선언을 돌리지 않는다 — `before:npm test`/);
  });

  it('npm init 자리표시 test 는 돌리지 않는다 — 늘 실패하는 명령이다 (D-093 과 같은 판정)', () => {
    const dir = folder({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
    assert.deepEqual(cmds(dir, 'R01').commands, []);
  });

  it('V3a 판정 — exit 0 은 통과, 머리줄 없는 실패는 시작 못 함, 네트워크·/dev 밖 쓰기 거부만 막은 것으로 센다', () => {
    const noise = ['(node) sysctl-read kern.bootargs', '(bash) file-write-data /dev/dtracehelper', '(node) mach-lookup com.apple.logd'];
    assert.deepEqual(sandboxVerdict(0, true, ['(node) network-bind local:*:0']), { kind: 'ran' });
    assert.deepEqual(sandboxVerdict(1, false, []), { kind: 'not-started' });
    assert.deepEqual(sandboxVerdict(1, true, noise), { kind: 'ran' });
    assert.deepEqual(sandboxVerdict(1, true, [...noise, '(node) file-write-create /Users/me/.cache/x']), { kind: 'blocked', denials: ['(node) file-write-create /Users/me/.cache/x'] });
    assert.deepEqual(sandboxVerdict(-1, false, []), { kind: 'ran' });
  });
});
