/**
 * Core 가 고르는 검증 명령 (D-096 — Q30 결정 2·3·4·V3a).
 *
 * 쓰기 위임 뒤에는 사람이 승인 때 적은 명령 말고도 Core 가 두 가지를 더한다 — 프로젝트 선언(W1, `verify.json`)과
 * `package.json` 의 허용 스크립트(W2, `limits.json` `verifyScripts`). 둘 다 **사람 클릭 없이** primary 가 쓴 코드를 돌리므로
 * primary 와 같은 경계(`codex sandbox -P :workspace`)에서만 돈다. codex 가 없으면 돌리지 않는다 — sandbox 밖으로 내리지 않는다.
 * W2 는 primary 직전에 본 스크립트(본문·`pre`·`post`)와 글자까지 같을 때만 돈다(S2) — 위임이 `"lint": "exit 0"` 으로 약화하면 돌지 않는다.
 */
import os from 'node:os';
import path from 'node:path';
import { resolveBinary } from '../adapters/resolve.ts';
import { loadEngines } from '../data/engines.ts';
import { loadLimits, verifyGroups, type VerifyScripts } from '../data/limits.ts';
import { defaultVerify } from '../data/verify.ts';
import type { CommandEvidence } from './evidence-gather.ts';
import { runTarget, sameRunTarget, type RunHook, type RunTarget } from './run-app.ts';
import { runArgv, type CommandRunner } from './scaffold.ts';

export interface AutoVerify {
  /** codex 바이너리. 찾지 못했으면 null — Core 가 고른 명령은 돌리지 않는다. */
  readonly codex: string | null;
  readonly runner: CommandRunner;
  readonly scripts: VerifyScripts;
}

/** 실제 조립용 — PATH 의 codex 와 셸 없는 실행기(D-088). 셸 함수(`CODEX_HOME` 주입 등)는 거치지 않는다. */
export function defaultAutoVerify(): AutoVerify {
  let codex: string | null;
  try {
    codex = resolveBinary(loadEngines().engines.codex);
  } catch {
    codex = null;
  }
  return { codex, runner: runArgv, scripts: loadLimits().verifyScripts };
}

/** 카드(W3)와 실행이 함께 쓰는 한 명령. `target` 이 있으면 W2 — 그 스냅숏과 지금 `package.json` 을 대조한다. */
export interface AutoCommand {
  /** 사람이 읽는 명령 — `npm run lint` 또는 선언 문자열. */
  readonly cmd: string;
  /** sandbox 안에서 돌 argv. */
  readonly argv: readonly string[];
  readonly target?: RunTarget;
}

/** 카드(plan 기록)에 싣는 모양 (D-096 W3) — 읽기 전용 표시다. */
export interface AutoVerifyShown {
  readonly cmd: string;
  readonly body?: string;
  readonly hooks?: readonly RunHook[];
}

export const shownOf = (commands: readonly AutoCommand[]): AutoVerifyShown[] =>
  commands.map((c) => ({ cmd: c.cmd, ...(c.target ? { body: c.target.body, ...(c.target.hooks.length > 0 ? { hooks: c.target.hooks } : {}) } : {}) }));

/** npm 이 `run` 없이 받는 스크립트 — 선언의 `npm test` 와 W2 의 `npm run test` 는 같은 명령이다. */
const RUNLESS = new Set(['test', 'start', 'stop', 'restart']);

/**
 * 이 위임에서 Core 가 고를 명령. 선언(W1, phase 없는 것만)이 먼저, 그다음 W2 스크립트다. `exclude`(사람이 적은 명령)와 같은 것은 뺀다.
 * phase 선언은 돌리지 않고 `notes` 로 남긴다 — phase 를 실행 시점으로 나누는 것은 CLI once·loop(D-045) 몫이다.
 */
export function autoCommands(
  dir: string,
  rowId: string,
  scripts: VerifyScripts,
  verifyFile: string,
  exclude: readonly string[],
): { readonly commands: AutoCommand[]; readonly notes: string[] } {
  const seen = new Set(exclude.map((c) => c.trim()));
  const commands: AutoCommand[] = [];
  const notes: string[] = [];
  for (const v of defaultVerify(rowId, verifyFile)) {
    if (v.phase !== undefined) {
      notes.push(`세션 위임은 phase 선언을 돌리지 않는다 — \`${v.phase}:${v.cmd}\` (CLI once·loop 몫, D-045)`);
      continue;
    }
    if (seen.has(v.cmd.trim())) continue;
    seen.add(v.cmd.trim());
    commands.push({ cmd: v.cmd, argv: ['/bin/sh', '-c', v.cmd] });
  }
  for (const group of verifyGroups(scripts, rowId)) {
    const t = runTarget(dir, group);
    if ('why' in t) continue;
    // `npm init` 자리표시 test 는 늘 실패한다 — 테스트가 없다는 뜻이다(D-093 과 같은 판정).
    if (/no test specified/.test(t.body)) continue;
    const cmd = t.argv.join(' ');
    const alias = RUNLESS.has(t.script) ? `${t.pm} ${t.script}` : null;
    if (seen.has(cmd) || (alias !== null && seen.has(alias))) continue;
    seen.add(cmd);
    commands.push({ cmd, argv: t.argv, target: t });
  }
  return { commands, notes };
}

/** 위임이 W2 스크립트를 바꿨나 (S2). 지금 다시 고른 대상이 스냅숏과 argv·본문·pre/post 까지 같아야 같다. */
export function scriptChanged(dir: string, target: RunTarget): boolean {
  const now = runTarget(dir, [target.script]);
  return 'why' in now || !sameRunTarget(target, now);
}

/** `codex sandbox` 로 감싼 argv — primary(`workspace-write`)와 같은 경계다. 거부 로그는 끝난 뒤 stderr 에 나온다. */
export const sandboxArgv = (codex: string, cwd: string, argv: readonly string[]): string[] =>
  [codex, 'sandbox', '-P', ':workspace', '-C', cwd, '--log-denials', '--', ...argv];

/** `--log-denials` 의 머리줄 (D-096 실측 사실 3). 감싸개가 돌았으면 거부가 없어도(`None found.`) 나온다. */
export const DENIAL_HEADER = '=== Sandbox denials ===';

/**
 * 진짜 실패를 가릴 수 있는 거부인가 (V3a). 네트워크와 `/dev/` 밖 쓰기만 센다 — 통과한 실행에도 늘 나오는
 * 시작 잡음(`sysctl-read`·`mach-lookup`·`system-info`·`/dev/` 쓰기)은 세지 않는다(실측 사실 4).
 */
export function blockingDenial(line: string): boolean {
  const m = /^\((.+?)\) (\S+)(?: (.*))?$/.exec(line);
  if (!m) return false;
  const op = m[2] ?? '';
  return op.startsWith('network-') || (op.startsWith('file-write') && !(m[3] ?? '').startsWith('/dev/'));
}

export type SandboxVerdict =
  | { readonly kind: 'ran' }
  /** 머리줄 없이 실패했다 — 감싸개가 돌지 못했다(없는 프로필 등, 실측 사실 2). */
  | { readonly kind: 'not-started' }
  | { readonly kind: 'blocked'; readonly denials: readonly string[] };

/** V3a 판정 순서. exit 0 은 거부와 무관하게 통과다 — 막힌 부수 효과가 있어도 명령은 성공했다. -1(시간 초과)은 D-046 그대로 둔다. */
export function sandboxVerdict(exitCode: number, headerSeen: boolean, denials: readonly string[]): SandboxVerdict {
  if (exitCode === 0 || exitCode === -1) return { kind: 'ran' };
  if (!headerSeen) return { kind: 'not-started' };
  const blocking = denials.filter(blockingDenial);
  return blocking.length > 0 ? { kind: 'blocked', denials: blocking } : { kind: 'ran' };
}

const TAIL_LINES = 60;
const TAIL_CHARS = 4000;

/**
 * Core 가 고른 명령 하나를 sandbox 안에서 돌린다. 출력은 줄마다 받아 머리줄 앞(명령 출력)과 뒤(거부)를 가른다 —
 * 실행기의 꼬리는 둘이 섞이고 거부가 길면 명령 출력이 밀려난다. npm 은 매 실행 `~/.npm/_logs` 에 쓰려다 막히므로(실측 사실 4)
 * 로그 폴더를 임시 폴더로 돌린다 — 아니면 진짜 lint 실패마다 `file-write` 거부가 붙어 `unverified` 로 숨는다.
 */
export async function runSandboxed(
  auto: AutoVerify & { readonly codex: string },
  command: AutoCommand,
  cwd: string,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<{ readonly evidence: CommandEvidence; readonly cancelled: boolean; readonly verdict: SandboxVerdict }> {
  const output: string[] = [];
  const denials: string[] = [];
  let headerSeen = false;
  const run = await auto.runner(sandboxArgv(auto.codex, cwd, command.argv), {
    cwd,
    timeoutMs: options.timeoutMs ?? 300_000,
    env: { ...process.env, npm_config_logs_dir: path.join(os.tmpdir(), 'hs-orc-npm-logs') },
    ...(options.signal ? { signal: options.signal } : {}),
    onLine: (line) => {
      if (line.trim() === DENIAL_HEADER) headerSeen = true;
      else if (headerSeen) denials.push(line.trim());
      else {
        output.push(line);
        if (output.length > TAIL_LINES) output.shift();
      }
    },
  });
  const exitCode = run.outcome === 'timeout' || run.outcome === 'cancelled' ? -1 : (run.exitCode ?? -1);
  const tail = output.join('\n');
  return {
    evidence: { kind: 'command', cmd: command.cmd, exitCode, output: tail.length > TAIL_CHARS ? `…${tail.slice(-(TAIL_CHARS - 1))}` : tail },
    cancelled: run.outcome === 'cancelled',
    verdict: sandboxVerdict(exitCode, headerSeen, denials),
  };
}
