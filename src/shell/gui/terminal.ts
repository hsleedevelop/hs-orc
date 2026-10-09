/**
 * 세션 폴더에서 **시스템 터미널**을 연다. 앱 안에 터미널을 심지 않는다 — 네이티브 의존성(pty) 없이
 * 사람이 쓰던 터미널을 그 폴더에서 띄우는 것이 목적이다.
 *
 * Electron 을 import 하지 않는다 (`worktree.ts` 와 같은 이유). shell 안에만 있다 (D-001).
 */
import { spawn } from 'node:child_process';
import { runCommandText, shellQuote } from '../../core/run-app.ts';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TerminalCommand {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /**
   * 끝날 때까지 기다려 종료 코드로 성공을 가리는가. macOS `open` 은 앱을 넘기고 바로 끝나서
   * "그런 앱이 없다" 를 종료 코드로 말한다. 다른 플랫폼은 터미널 자체가 오래 살아 기다리면 안 된다.
   */
  readonly wait: boolean;
}

/**
 * 화면에서 고르는 터미널. 렌더러는 이 id 만 넘긴다 — 임의 앱 이름을 실행하게 두지 않는다(D-021).
 * `app` 은 macOS `open -a` 의 앱 이름, 그 밖 플랫폼에서는 소문자로 실행 파일 이름이 된다.
 */
export const TERMINALS = [
  { id: 'default', label: '기본' },
  { id: 'ghostty', label: 'Ghostty', app: 'Ghostty' },
  { id: 'otty', label: 'Otty', app: 'Otty' },
] as const;
export type TerminalId = (typeof TERMINALS)[number]['id'];

export function isTerminalId(v: unknown): v is TerminalId {
  return TERMINALS.some((t) => t.id === v);
}

/**
 * 플랫폼별 명령. `기본` 이면 `HS_ORC_TERMINAL` 로 바꾼 터미널, 없으면 플랫폼 기본 — macOS 는 `open -a` 에 줄 앱 이름(`iTerm`),
 * 그 밖은 실행 파일. 경로는 셸을 거치지 않고 인자·cwd 로만 넘긴다 — 폴더 이름의 공백·따옴표가 명령이 되지 않게.
 */
export function terminalCommand(
  dir: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  terminal: TerminalId = 'default',
): TerminalCommand {
  const picked = TERMINALS.find((t) => t.id === terminal);
  const app = picked && 'app' in picked ? picked.app : undefined;
  const custom = (platform === 'darwin' ? app : app?.toLowerCase()) ?? (env['HS_ORC_TERMINAL']?.trim() || undefined);
  if (platform === 'darwin') return { cmd: 'open', args: ['-a', custom ?? 'Terminal', dir], cwd: dir, wait: true };
  if (platform === 'win32') return { cmd: custom ?? 'cmd.exe', args: custom ? [] : ['/c', 'start', 'cmd.exe'], cwd: dir, wait: false };
  return { cmd: custom ?? 'x-terminal-emulator', args: [], cwd: dir, wait: false };
}

/** 터미널을 띄운다. 못 띄우면 던진다 — "열었다" 고 거짓말하지 않는다. */
export function openTerminal(dir: string, command: TerminalCommand = terminalCommand(dir)): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.cmd, [...command.args], {
      cwd: command.cwd,
      detached: !command.wait,
      stdio: ['ignore', 'ignore', command.wait ? 'pipe' : 'ignore'],
    });
    let err = '';
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
    child.once('error', (e) => reject(new Error(`터미널을 열지 못했다 (${command.cmd}): ${e.message}`)));
    if (command.wait) {
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`터미널을 열지 못했다 (${command.cmd} 종료 ${code}): ${err.trim() || '(stderr 없음)'}`)));
    } else {
      child.once('spawn', () => { child.unref(); resolve(); });
    }
  });
}

/** 인용은 Core 와 같은 함수다 — 지휘자 안내 명령(`runCommandText`)과 터미널 스크립트가 같은 규칙을 쓴다. */
export { shellQuote };

/**
 * 터미널이 실행할 `.command` 스크립트 본문 (D-091). 폴더로 가서 argv 를 돌리고, 끝나면(Ctrl-C 포함) 그 폴더의 로그인 셸로 남는다 —
 * 창을 닫는 터미널(Ghostty)에서도 실패 출력이 사라지지 않게. 폴더·인자는 모두 작은따옴표 인용이다 — 이름의 `'`·`$`·`;` 가 명령이 되지 않는다.
 */
export function runScript(dir: string, argv: readonly string[]): string {
  const command = argv.map(shellQuote).join(' ');
  return [
    '#!/bin/sh',
    '# hs-orc 앱 실행 (D-091) — 사람이 실행 카드에서 확인한 명령이다.',
    // Ctrl-C 는 포그라운드 그룹 전체에 간다 — 잡지 않으면 이 sh 도 죽어 아래 안내·셸로 남기가 돌지 않는다. 잡은(무시가 아닌) 신호는
    // 자식에게 기본 동작으로 넘어가므로 서버는 그대로 멈춘다.
    "trap ':' INT",
    `cd ${shellQuote(dir)} || exit 1`,
    `printf '%s\\n' ${shellQuote(`[hs-orc] ${dir} 에서 ${argv.join(' ')} — Ctrl-C 로 멈춘다`)}`,
    command,
    'code=$?',
    `printf '\\n[hs-orc] 끝났다 (exit %s) — 이 창은 이 폴더의 셸로 남는다\\n' "$code"`,
    'exec "${SHELL:-/bin/zsh}" -l',
    '',
  ].join('\n');
}

/** 실행 스크립트를 두는 곳 — 열고 나면 쓸모가 없어 한 시간 지난 것은 다음 실행 때 지운다. */
const RUN_DIR = path.join(os.tmpdir(), 'hs-orc-run');
const RUN_KEEP_MS = 60 * 60 * 1000;

/**
 * 고른 터미널 창에서 이 폴더의 argv 를 연다 (D-091 — Q29 A2). macOS 만 된다: 실행 비트를 준 `.command` 파일을 `open -a <앱>` 으로 넘긴다 —
 * Terminal·Ghostty·Otty 모두 이 문서 유형을 받아 사용자의 로그인 셸에서 돌린다(D-091 실측). AppleScript(자동화 권한)를 쓰지 않는다.
 * 서버의 수명·로그·중지는 그 창의 것이다 — hs-orc 는 띄운 뒤 모른다. 연 앱 이름을 돌려준다. 못 열면 던진다.
 */
export async function runInTerminal(
  dir: string,
  argv: readonly string[],
  terminal: TerminalId = 'default',
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  open: (command: TerminalCommand) => Promise<void> = (command) => openTerminal(command.cwd, command),
): Promise<string> {
  if (platform !== 'darwin') throw new Error(`터미널 창에 명령을 실어 여는 것은 macOS 만 된다 — 터미널에서 직접 실행한다: ${runCommandText(dir, argv)}`);
  const base = terminalCommand(dir, platform, env, terminal);
  const app = base.args[1] ?? 'Terminal';
  mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  const now = Date.now();
  for (const name of readdirSync(RUN_DIR)) {
    const file = path.join(RUN_DIR, name);
    try {
      if (now - statSync(file).mtimeMs > RUN_KEEP_MS) rmSync(file, { force: true });
    } catch {
      // 다른 hs-orc 가 지웠다.
    }
  }
  const file = path.join(RUN_DIR, `run-${now}-${randomBytes(4).toString('hex')}.command`);
  writeFileSync(file, runScript(dir, argv), { mode: 0o700 });
  await open({ cmd: 'open', args: ['-a', app, file], cwd: dir, wait: true });
  return app;
}
