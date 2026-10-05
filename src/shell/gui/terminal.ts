/**
 * 세션 폴더에서 **시스템 터미널**을 연다. 앱 안에 터미널을 심지 않는다 — 네이티브 의존성(pty) 없이
 * 사람이 쓰던 터미널을 그 폴더에서 띄우는 것이 목적이다.
 *
 * Electron 을 import 하지 않는다 (`worktree.ts` 와 같은 이유). shell 안에만 있다 (D-001).
 */
import { spawn } from 'node:child_process';

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
