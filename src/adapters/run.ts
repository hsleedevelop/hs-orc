/**
 * 프로세스 관리 (SPEC §3.7).
 * - 취소는 **프로세스 그룹 단위**다. 자식이 손자를 띄우면 자식만 죽여서는 좀비가 남고 비용이 계속 나간다.
 *   엔진 그룹 밖으로 나간 자손(codex 의 셸 명령)은 따로 모아 같이 신호를 보낸다 (Q24, D-078).
 * - 원본 stdout/stderr 를 파싱과 무관하게 보존한다.
 * - stdin 은 닫는다. 세 CLI 모두 stdin 이 TTY 가 아니면 입력을 기다린다(codex 는 무기한).
 */
import { execFileSync, spawn } from 'node:child_process';
import type { CacheWrite, EngineCompaction, RunEvent, RunHandle, RunOutcome, RunResult, Usage } from './types.ts';
import { createLineSplitter, parseLine, type StreamFormat } from './stream.ts';

export interface SpawnSpec {
  readonly bin: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly format: StreamFormat;
  /** 부모 env 위에 덮어 실을 값 (D-061). 없으면 부모 env 를 그대로 물려준다. */
  readonly env?: Readonly<Record<string, string>>;
}

/** SIGTERM 후 이 시간 안에 안 죽으면 그룹째 SIGKILL. */
const KILL_GRACE_MS = 2_000;

/**
 * 종료 신호(SIGTERM)는 보냈지만 SIGKILL 유예가 아직 안 끝난 대상 — `process.kill` 인자 그대로다(그룹은 음수).
 * 호스트가 유예 타이머(unref)를 기다리지 않고 나가도 SIGTERM 을 무시하는 엔진·자손이 남지 않게, 프로세스 종료 시점에
 * 동기로 SIGKILL 을 보낸다 (D-066). 대상은 `terminate` 가 이미 모아 두었으므로 훅은 `ps` 를 다시 부르지 않는다 (D-078).
 * 종료 신호를 보내지 않은 실행은 건드리지 않는다 — 그 실행을 남겨 두고 나가는 것은 호출자가 고른 것이다.
 */
const terminating = new Set<number>();
let exitHookInstalled = false;
const installExitHook = (): void => {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const target of terminating) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // 이미 사라졌다.
      }
    }
  });
};

/**
 * 엔진 자손 중 **엔진 프로세스 그룹 밖**에 있는 것 — `process.kill` 인자로 돌려준다 (Q24, D-078).
 * codex 는 셸 명령마다 새 프로세스 그룹을 만들어 `process.kill(-pid)` 가 닿지 않고, 엔진이 죽으면 그 명령은 ppid 1 고아로
 * 계속 돈다 (D-067 추가 실측 2 (c)). `ps` 스냅숏에서 ppid 로 자손을 따라가, 리더가 자손인 그룹은 `-pgid`(스냅숏 뒤 그 그룹에
 * 생긴 프로세스까지 닿는다), 리더가 트리 밖인 그룹의 자손은 pid 하나만 — 남의 그룹에는 신호를 보내지 않는다.
 * **엔진에 신호를 보내기 전에** 불러야 한다 — 엔진이 죽으면 자손이 ppid 1 로 옮겨 트리에서 끊긴다.
 * `ps` 가 없거나 실패하면 빈 목록이다 — 엔진 그룹 종료(기존 동작)만 남는다.
 */
export function outsideGroupDescendants(rootPid: number): number[] {
  let table: string;
  try {
    // POSIX 옵션이라 macOS(BSD ps)·Linux(procps) 가 같다.
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 2_000 });
  } catch {
    return [];
  }
  const pgidOf = new Map<number, number>();
  const childrenOf = new Map<number, number[]>();
  for (const line of table.split('\n')) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined || !pgid) continue;
    pgidOf.set(pid, pgid);
    const siblings = childrenOf.get(ppid);
    if (siblings) siblings.push(pid);
    else childrenOf.set(ppid, [pid]);
  }
  const descendants = new Set<number>();
  const queue = [rootPid];
  for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
    for (const child of childrenOf.get(pid) ?? []) {
      if (descendants.has(child)) continue;
      descendants.add(child);
      queue.push(child);
    }
  }
  const targets = new Set<number>();
  for (const pid of descendants) {
    const pgid = pgidOf.get(pid);
    if (pgid === undefined || pgid === rootPid) continue;
    targets.add(descendants.has(pgid) ? -pgid : pid);
  }
  return [...targets];
}

export function runProcess(spec: SpawnSpec, onEvent?: (event: RunEvent) => void): RunHandle {
  const startedAt = Date.now();
  const child = spawn(spec.bin, [...spec.argv], {
    cwd: spec.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(spec.env ? { env: { ...process.env, ...spec.env } } : {}),
    // 자기 프로세스 그룹을 갖게 해 손자까지 한 번에 종료할 수 있게 한다.
    detached: true,
  });

  let rawStdout = '';
  let rawStderr = '';
  let text = '';
  let ok = true;
  let usage: Usage | undefined;
  let cacheWrite: CacheWrite | undefined;
  let costUsd: number | undefined;
  let sessionId: string | undefined;
  const compactions: EngineCompaction[] = [];
  const unparsedLines: string[] = [];
  let outcome: RunOutcome | undefined;

  const emit = (event: RunEvent): void => {
    switch (event.kind) {
      case 'text':
        // codex 는 에이전트 메시지를 하나씩 통째로 낸다 — 붙이면 "…하겠습니다.위임 판단: …" 처럼 문단이 뭉친다.
        text = text ? `${text}\n\n${event.text}` : event.text;
        break;
      case 'done':
        text = event.text || text;
        ok = event.ok;
        if (event.costUsd !== undefined) costUsd = event.costUsd;
        break;
      case 'usage':
        usage = event.usage;
        break;
      case 'cacheWrite':
        cacheWrite = event.cacheWrite;
        break;
      case 'unparsed':
        unparsedLines.push(event.line);
        break;
      case 'session':
        sessionId = event.id;
        break;
      case 'compact':
        compactions.push(event.compaction);
        break;
      case 'notice':
        break;
    }
    onEvent?.(event);
  };

  const splitStdout = createLineSplitter();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    rawStdout += chunk;
    for (const line of splitStdout(chunk)) for (const event of parseLine(spec.format, line)) emit(event);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    rawStderr += chunk;
  });

  /** 신호를 보낼 곳 — `process.kill` 인자(그룹은 음수). 엔진 그룹 + 그룹 밖 자손 (D-078). */
  const targets = new Set<number>();
  const collectTargets = (): void => {
    if (child.pid === undefined) return;
    targets.add(-child.pid);
    for (const target of outsideGroupDescendants(child.pid)) targets.add(target);
    for (const target of targets) terminating.add(target);
  };
  /** 이미 죽었으면 ESRCH 가 나므로 삼킨다. */
  const signalAll = (signal: NodeJS.Signals): void => {
    for (const target of targets) {
      try {
        process.kill(target, signal);
      } catch {
        if (target !== -(child.pid ?? 0)) continue;
        try {
          child.kill(signal);
        } catch {
          // 이미 사라졌다.
        }
      }
    }
  };

  let killTimer: NodeJS.Timeout | undefined;
  const terminate = (reason: RunOutcome): void => {
    outcome ??= reason;
    // 엔진에 신호를 보내기 **전에** 모은다 — 엔진이 먼저 죽으면 그룹 밖 자손을 트리에서 못 찾는다 (D-078).
    collectTargets();
    installExitHook();
    signalAll('SIGTERM');
    // 엔진이 먼저 끝나도 이 타이머는 지우지 않는다 — SIGTERM 을 무시하는 그룹 밖 자손은 엔진 종료와 무관하게 남는다.
    killTimer ??= setTimeout(() => {
      // 유예 중 엔진이 새로 띄운 자손도 잡는다 (엔진이 아직 살아 있을 때만 트리에 보인다).
      collectTargets();
      signalAll('SIGKILL');
      for (const target of targets) terminating.delete(target);
    }, KILL_GRACE_MS).unref();
  };

  const timeoutTimer = setTimeout(() => terminate('timeout'), spec.timeoutMs);
  timeoutTimer.unref();

  const result = new Promise<RunResult>((resolve) => {
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timeoutTimer);
      // 마지막 줄에 개행이 없을 수 있다.
      for (const line of splitStdout('\n')) for (const event of parseLine(spec.format, line)) emit(event);

      resolve({
        outcome: outcome ?? (ok && exitCode === 0 ? 'ok' : 'error'),
        text: text.trim(),
        exitCode,
        signal,
        ...(usage ? { usage } : {}),
        ...(cacheWrite ? { cacheWrite } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        durationMs: Date.now() - startedAt,
        rawStdout,
        rawStderr,
        unparsedLines,
        ...(sessionId ? { sessionId } : {}),
        ...(compactions.length > 0 ? { compactions } : {}),
      });
    };

    child.on('error', (error) => {
      rawStderr += `${error.message}\n`;
      outcome ??= 'error';
      finish(null, null);
    });
    child.on('close', finish);
  });

  return { result, cancel: () => terminate('cancelled') };
}
