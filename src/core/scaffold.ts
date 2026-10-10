/**
 * 스캐폴딩 전용 경로 (D-088 — D-074 B1 번복, D-073 B3).
 *
 * 위임 엔진의 샌드박스는 네트워크·홈 쓰기를 막아 `npx create-*` 가 돌지 않는다(D-073 사실 8). 그래서 hs-orc 가
 * **허용 목록의 argv 만**, **사람이 카드에서 확인한 뒤**, **엔진 없이** 세션 폴더에서 직접 실행한다.
 * - 감지는 결정론이다(G1) — 문장에서 의도 낱말과 허용 목록의 키워드를 본다. 문장은 argv 에 들어가지 않는다.
 * - 실행은 셸 없이 spawn argv 다. 자기 프로세스 그룹으로 띄워 취소·시간 초과 때 그룹째 끝낸다(adapters/run.ts 와 같은 규칙).
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { outsideGroupDescendants } from '../adapters/run.ts';
import { ScaffoldError, checkScaffoldArgv, type Scaffolder, type Scaffolders } from '../data/scaffolders.ts';
import { gitEnv } from './git-env.ts';

/** "앱·프로젝트를 새로 만든다" 는 말 — 대상 바로 뒤에 만드는 동사가 온다. "앱을 시작하면"·"app create 버튼" 은 맞지 않는다 (PR #118 리뷰). */
const CREATE_KO = /(앱|app|프로젝트|project)\s*(하나|을|를|one)?\s*(새로\s*)?(만들|생성|셋업|setup|init|초기화)/i;
const CREATE_EN = /\b(create|make|init(ialize)?|set\s*up|bootstrap)\s+(an?\s+)?(new\s+)?([\w.-]+\s+)?(app|project)\b/i;

/** 새 프로젝트를 만든다는 뜻이 분명한 말. 카드를 못 세우는 폴더에서 종전 경로를 바꿀지는 이것으로만 정한다. */
const STRONG = [/스캐폴/, /scaffold/i, /bootstrap/i, /\bcreate-[a-z]/i, /새\s*(프로젝트|앱)/, /\bnew\s+(project|app)\b/i, CREATE_KO, CREATE_EN];

/** 그 밖에 스캐폴딩일 수 있는 말 — 허용 목록 키워드(next·expo·vite)와 함께일 때만 본다. `git init`·"DB 초기화" 는 대상이 없어 거른다. */
const WEAK = [/(?<!git\s)\binit\b/i, /초기화/];
const SUBJECT = /(앱|app|프로젝트|project|템플릿|template)/i;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 영문 낱말 경계 — 한글이 바로 붙어도("next앱") 맞는다. */
const mentions = (text: string, keyword: string): boolean => new RegExp(`(^|[^a-z0-9])${escape(keyword)}([^a-z0-9]|$)`).test(text);

export interface ScaffoldRequest {
  /** 정확히 하나가 맞으면 그것. 없거나 둘 이상이면 null — 카드를 세우지 않고 지휘자가 묻는다. */
  readonly scaffolder: Scaffolder | null;
  readonly candidates: readonly Scaffolder[];
  /** 새 프로젝트를 만든다는 뜻이 분명하다 (`STRONG`). 아니면 약한 말(init·초기화)과 키워드·대상이 겹친 것뿐이다. */
  readonly strong: boolean;
}

/** 새 프로젝트 생성 요청일 수 있는가. 아니면 null. 이 판정만으로 경로를 바꾸지 않는다 — 세션이 폴더 상태와 함께 본다. */
export function detectScaffold(text: string, catalog: Scaffolders): ScaffoldRequest | null {
  const lower = text.toLowerCase();
  const strong = STRONG.some((re) => re.test(text));
  if (!strong && !WEAK.some((re) => re.test(text))) return null;
  const candidates = catalog.scaffolders.filter((s) => s.keywords.some((k) => mentions(lower, k)));
  if (candidates.length === 0 && !SUBJECT.test(text)) return null;
  return { scaffolder: candidates.length === 1 ? (candidates[0] ?? null) : null, candidates, strong };
}

/** 빈 폴더 판정 — `ignore` 밖의 이름들. 못 읽으면 null(비어 있다고 보지 않는다). */
export function folderEntries(dir: string, ignore: readonly string[]): string[] | null {
  try {
    return readdirSync(dir).filter((n) => !ignore.includes(n)).sort();
  } catch {
    return null;
  }
}

/** 카드·실행이 쓰는 argv 가 지금 허용 목록의 항목과 글자까지 같은가 — 아니면 던진다. 카드가 선 뒤 목록이 바뀌었어도 옛 argv 를 돌리지 않는다. */
export function allowedArgv(argv: readonly string[], catalog: Scaffolders): Scaffolder {
  checkScaffoldArgv(argv);
  const hit = catalog.scaffolders.find((s) => s.argv.length === argv.length && s.argv.every((a, i) => a === argv[i]));
  if (!hit) throw new ScaffoldError(`허용 목록(data/scaffolders.json)에 없는 명령이다: ${argv.join(' ')}`);
  return hit;
}

/** 화면·기록에 보이는 명령 한 줄. 인자는 허용 모양이라 따옴표가 필요 없다. */
export const commandLine = (argv: readonly string[]): string => argv.join(' ');

export type CommandOutcome = 'ok' | 'failed' | 'cancelled' | 'timeout';

export interface CommandRun {
  readonly outcome: CommandOutcome;
  /** 시그널로 죽거나 띄우지 못했으면 null. */
  readonly exitCode: number | null;
  /** 출력 끝부분 — ANSI 를 지운 stdout·stderr 를 도착 순서대로. */
  readonly tail: string;
  readonly durationMs: number;
}

export interface CommandOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** 줄마다 (D-084 진행 줄). */
  readonly onLine?: (line: string) => void;
  readonly env?: NodeJS.ProcessEnv;
}

export type CommandRunner = (argv: readonly string[], options: CommandOptions) => Promise<CommandRun>;

const TAIL_LINES = 60;
const TAIL_CHARS = 4000;
const KILL_GRACE_MS = 2_000;
// eslint-disable-next-line no-control-regex -- 터미널 제어 문자를 지운다.
const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/**
 * argv 를 **셸 없이** 띄운다. 문자열 속 `$(…)`·`;`·`|` 는 글자 그대로 인자다. stdin 은 닫는다 — 묻는 스캐폴더는 기다리지 않고 끝나거나 시간 초과로 끝난다.
 * 취소·시간 초과는 엔진과 같은 규칙으로 그룹째(그룹 밖 자손 포함, D-078) SIGTERM → 유예 → SIGKILL 이다.
 * 끝낸 실행은 SIGKILL 단계가 지난 뒤에 돌아온다 — 돌아온 시점에 남은 자손이 없다 (D-094 리뷰).
 */
export const runArgv: CommandRunner = (argv, options) => {
  const startedAt = Date.now();
  const [bin, ...args] = argv;
  if (!bin) return Promise.reject(new ScaffoldError('빈 명령이다.'));
  return new Promise<CommandRun>((resolve) => {
    const child = spawn(bin, args, { cwd: options.cwd, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: options.env ?? process.env });
    const lines: string[] = [];
    let partial = '';
    let outcome: CommandOutcome | undefined;
    const take = (chunk: string): void => {
      const parts = (partial + chunk).replace(ANSI, '').split(/\r\n|\r|\n/);
      partial = parts.pop() ?? '';
      for (const raw of parts) {
        const line = raw.trimEnd();
        if (!line) continue;
        lines.push(line);
        if (lines.length > TAIL_LINES) lines.shift();
        options.onLine?.(line);
      }
    };
    child.stdout.setEncoding('utf8').on('data', take);
    child.stderr.setEncoding('utf8').on('data', take);

    const targets = new Set<number>();
    let killTimer: NodeJS.Timeout | undefined;
    let killed = false;
    // 끝낸 실행이 SIGKILL 단계 전에 닫히면 그 단계가 지난 뒤에 돌려준다 (D-094 리뷰).
    let afterKill: (() => void) | undefined;
    const signalAll = (sig: NodeJS.Signals): void => {
      for (const t of targets) {
        try {
          process.kill(t, sig);
        } catch {
          // 이미 사라졌다.
        }
      }
    };
    const terminate = (reason: CommandOutcome): void => {
      if (child.pid === undefined || outcome !== undefined) return;
      outcome = reason;
      // 신호 전에 모은다 — 먼저 죽이면 그룹 밖 자손이 트리에서 끊긴다 (D-078).
      targets.add(-child.pid);
      for (const t of outsideGroupDescendants(child.pid)) targets.add(t);
      signalAll('SIGTERM');
      killTimer = setTimeout(() => {
        killed = true;
        signalAll('SIGKILL');
        afterKill?.();
      }, KILL_GRACE_MS);
      killTimer.unref();
    };
    const timer = setTimeout(() => terminate('timeout'), options.timeoutMs);
    timer.unref();
    const onAbort = (): void => terminate('cancelled');
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    let settled = false;
    const finish = (exitCode: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (partial) take('\n');
      if (error) lines.push(`실행하지 못했다: ${error.message}`);
      const tail = lines.join('\n');
      const result: CommandRun = {
        outcome: outcome ?? (exitCode === 0 && !error ? 'ok' : 'failed'),
        exitCode,
        tail: tail.length > TAIL_CHARS ? `…${tail.slice(-(TAIL_CHARS - 1))}` : tail,
        durationMs: Date.now() - startedAt,
      };
      // 끝내려고 신호를 보냈는데 SIGKILL 단계 전에 닫혔다 — 셸은 SIGTERM 에 죽어도 출력을 떼어 낸 자손은 무시하고 남을 수 있다.
      // 여기서 돌려주면 호출자가 곧바로 process.exit 할 때 unref 타이머가 사라져 자손이 영구히 남는다(CLI 검증·스캐폴딩).
      // 그래서 SIGKILL 을 보낸 뒤 돌려주고, 그때까지 타이머가 프로세스를 붙잡게 한다.
      if (killTimer !== undefined && !killed) {
        afterKill = () => resolve(result);
        killTimer.ref();
        return;
      }
      resolve(result);
    };
    child.on('error', (error) => finish(null, error));
    child.on('close', (code) => finish(code));
  });
};

/** 스캐폴딩 뒤 git 이 없을 때 제안하는 첫 커밋 (D-088). 사용자의 git 신원으로 커밋한다 — 없으면 커밋이 실패하고 그대로 기록된다. */
export const GIT_INIT_COMMANDS: readonly (readonly string[])[] = [
  ['git', 'init'],
  ['git', 'add', '-A'],
  ['git', 'commit', '-m', 'chore: initial scaffold (hs-orc)'],
];

/** 차례로 돌리고 첫 실패에서 멈춘다. 돈 명령 수와 마지막 실행을 돌려준다. */
export async function runSequence(run: CommandRunner, commands: readonly (readonly string[])[], options: CommandOptions): Promise<{ readonly ran: number; readonly last: CommandRun; readonly tail: string; readonly durationMs: number }> {
  const tails: string[] = [];
  let durationMs = 0;
  let last: CommandRun | undefined;
  let ran = 0;
  for (const argv of commands) {
    last = await run(argv, { ...options, env: options.env ?? gitEnv() });
    ran += 1;
    durationMs += last.durationMs;
    tails.push(`$ ${commandLine(argv)}`, ...(last.tail ? [last.tail] : []));
    if (last.outcome !== 'ok') break;
  }
  if (!last) throw new ScaffoldError('돌릴 명령이 없다.');
  return { ran, last, tail: tails.join('\n').slice(-TAIL_CHARS), durationMs };
}
