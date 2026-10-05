import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openTerminal, terminalCommand } from '../terminal.ts';

describe('세션 폴더 터미널', () => {
  it('macOS 는 open -a 로 연다 — 폴더는 공백이 있어도 인자 하나다', () => {
    const dir = '/tmp/my project';
    assert.deepEqual(terminalCommand(dir, 'darwin', {}), { cmd: 'open', args: ['-a', 'Terminal', dir], cwd: dir, wait: true });
    assert.deepEqual(terminalCommand(dir, 'darwin', { HS_ORC_TERMINAL: 'Ghostty' }).args, ['-a', 'Ghostty', dir]);
  });

  it('그 밖은 터미널을 그 폴더 cwd 로 띄우고 기다리지 않는다', () => {
    assert.deepEqual(terminalCommand('/w', 'linux', {}), { cmd: 'x-terminal-emulator', args: [], cwd: '/w', wait: false });
    assert.equal(terminalCommand('/w', 'linux', { HS_ORC_TERMINAL: 'kitty' }).cmd, 'kitty');
  });

  it('못 띄우면 던진다 — 종료 코드와 없는 실행 파일 모두', async () => {
    await assert.rejects(openTerminal('.', { cmd: 'false', args: [], cwd: '.', wait: true }), /종료 1/);
    await assert.rejects(openTerminal('.', { cmd: 'hs-orc-no-such-terminal', args: [], cwd: '.', wait: false }), /ENOENT/);
  });
});
