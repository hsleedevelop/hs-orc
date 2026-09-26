/**
 * 프로세스 관리 (SPEC §3.7).
 * - 취소는 **프로세스 그룹 단위**다. 자식이 손자를 띄우면 자식만 죽여서는 좀비가 남고 비용이 계속 나간다.
 * - 원본 stdout/stderr 를 파싱과 무관하게 보존한다.
 * - stdin 은 닫는다. 세 CLI 모두 stdin 이 TTY 가 아니면 입력을 기다린다(codex 는 무기한).
 */
import { spawn } from 'node:child_process';
import type { EngineCompaction, RunEvent, RunHandle, RunOutcome, RunResult, Usage } from './types.ts';
import { createLineSplitter, parseLine, type StreamFormat } from './stream.ts';

export interface SpawnSpec {
  readonly bin: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly format: StreamFormat;
}

/** SIGTERM 후 이 시간 안에 안 죽으면 그룹째 SIGKILL. */
const KILL_GRACE_MS = 2_000;

export function runProcess(spec: SpawnSpec, onEvent?: (event: RunEvent) => void): RunHandle {
  const startedAt = Date.now();
  const child = spawn(spec.bin, [...spec.argv], {
    cwd: spec.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    // 자기 프로세스 그룹을 갖게 해 손자까지 한 번에 종료할 수 있게 한다.
    detached: true,
  });

  let rawStdout = '';
  let rawStderr = '';
  let text = '';
  let ok = true;
  let usage: Usage | undefined;
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

  /** 그룹째 종료. 이미 죽었으면 ESRCH 가 나므로 삼킨다. */
  const killGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // 이미 사라졌다.
      }
    }
  };

  let killTimer: NodeJS.Timeout | undefined;
  const terminate = (reason: RunOutcome): void => {
    outcome ??= reason;
    killGroup('SIGTERM');
    killTimer ??= setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
  };

  const timeoutTimer = setTimeout(() => terminate('timeout'), spec.timeoutMs);
  timeoutTimer.unref();

  const result = new Promise<RunResult>((resolve) => {
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      // 마지막 줄에 개행이 없을 수 있다.
      for (const line of splitStdout('\n')) for (const event of parseLine(spec.format, line)) emit(event);

      resolve({
        outcome: outcome ?? (ok && exitCode === 0 ? 'ok' : 'error'),
        text: text.trim(),
        exitCode,
        signal,
        ...(usage ? { usage } : {}),
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
