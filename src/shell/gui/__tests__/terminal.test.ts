import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import { openTerminal, runInTerminal, runScript, shellQuote, terminalCommand, type TerminalCommand } from '../terminal.ts';

describe('세션 폴더 터미널', () => {
  it('macOS 는 open -a 로 연다 — 폴더는 공백이 있어도 인자 하나다', () => {
    const dir = '/tmp/my project';
    assert.deepEqual(terminalCommand(dir, 'darwin', {}), { cmd: 'open', args: ['-a', 'Terminal', dir], cwd: dir, wait: true });
    assert.deepEqual(terminalCommand(dir, 'darwin', { HS_ORC_TERMINAL: 'Ghostty' }).args, ['-a', 'Ghostty', dir]);
  });

  it('고른 터미널이 HS_ORC_TERMINAL 을 이기고, 기본이면 환경 변수를 따른다', () => {
    const env = { HS_ORC_TERMINAL: 'iTerm' };
    assert.deepEqual(terminalCommand('/w', 'darwin', env, 'otty').args, ['-a', 'Otty', '/w']);
    assert.deepEqual(terminalCommand('/w', 'darwin', env, 'default').args, ['-a', 'iTerm', '/w']);
    assert.equal(terminalCommand('/w', 'linux', {}, 'ghostty').cmd, 'ghostty');
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

describe('터미널에서 앱 실행 (D-091)', () => {
  it('인용은 셸이 글자 그대로 되돌린다 — 폴더 이름의 따옴표·$·; 가 명령이 되지 않는다', () => {
    const evil = "/tmp/it's $(touch pwned); `id` && x";
    const out = spawnSync('/bin/sh', ['-c', `printf %s ${shellQuote(evil)}`], { encoding: 'utf8' });
    assert.equal(out.stdout, evil);
    const script = runScript(evil, ['npm', 'run', 'dev']);
    assert.equal(spawnSync('/bin/sh', ['-n'], { input: script }).status, 0, '문법이 맞다');
    assert.ok(script.includes(`cd ${shellQuote(evil)} || exit 1`));
    assert.ok(script.includes("'npm' 'run' 'dev'"));
  });

  it('Ctrl-C(그룹 SIGINT)는 명령만 멈추고 스크립트는 살아 끝난 안내를 찍는다 — 창이 폴더의 셸로 남는다', async () => {
    // 마지막 줄의 로그인 셸은 SHELL 로 바꿔 바로 끝나게 한다.
    const child = spawn('/bin/sh', ['-c', runScript(os.tmpdir(), ['sleep', '30'])], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, SHELL: '/usr/bin/true' } });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    await new Promise((r) => setTimeout(r, 300));
    process.kill(-(child.pid ?? 0), 'SIGINT');
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0);
    assert.match(out, /끝났다 \(exit 130\)/);
  });

  it('macOS 는 실행 비트를 준 .command 파일을 고른 앱으로 연다 — 연 앱 이름을 돌려준다', async () => {
    const opened: TerminalCommand[] = [];
    const open = (c: TerminalCommand) => { opened.push(c); return Promise.resolve(); };
    assert.equal(await runInTerminal('/w', ['pnpm', 'run', 'dev'], 'ghostty', 'darwin', {}, open), 'Ghostty');
    assert.equal(await runInTerminal('/w', ['npm', 'run', 'dev'], 'default', 'darwin', { HS_ORC_TERMINAL: 'iTerm' }, open), 'iTerm');
    const [first] = opened;
    assert.ok(first);
    assert.deepEqual(first.args.slice(0, 2), ['-a', 'Ghostty']);
    const file = first.args[2] ?? '';
    assert.match(file, /\.command$/);
    assert.equal(statSync(file).mode & 0o777, 0o700);
    assert.match(readFileSync(file, 'utf8'), /'pnpm' 'run' 'dev'/);
    for (const c of opened) rmSync(c.args[2] ?? '', { force: true });
  });

  it('macOS 밖은 열지 않고 칠 명령을 말하며 던진다', async () => {
    await assert.rejects(runInTerminal('/w', ['npm', 'run', 'dev'], 'default', 'linux', {}, () => Promise.resolve()), /macOS 만.*cd '\/w' && npm run dev/);
  });
});
