/**
 * 세션 점유 표식 (D-085) — 어느 프로세스가 이 세션을 쥐고 있나.
 *
 * GUI·`chat`·`session send` 는 각자 프로세스다. 한 세션의 기록(JSONL)에 두 프로세스가 번갈아 쓰면 턴 번호가 겹치고
 * Budget 재생(D-054)이 어긋난다. 그래서 엔진이 도는 동안(`working`)과 배정 카드가 메모리에 선 동안(`blocked`)
 * `<세션>.lock` 을 쥔다. 목록은 이 파일로 다른 프로세스의 "진행 중"·"승인 대기" 를 본다.
 * 쥔 프로세스가 죽었으면(pid 가 없으면) 없는 것으로 본다 — 앱이 끊겨도 세션이 영영 잠기지 않게.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { projectStateDir } from './project-state.ts';

export type HoldState = 'working' | 'blocked';
/** 누가 쥐었나 — 화면이 "다른 곳에서 도는 중" 을 말할 때 쓴다. */
export type HoldBy = 'gui' | 'chat' | 'cli';

export interface SessionHold {
  readonly pid: number;
  readonly by: HoldBy;
  readonly state: HoldState;
  readonly at: string;
}

export class SessionBusyError extends Error {
  override name = 'SessionBusyError';
}

/** 기록(`<id>.jsonl`) 옆이다. 목록은 `.jsonl` 만 세므로 세션으로 잡히지 않는다. */
export const lockPath = (dir: string, id: string, env: NodeJS.ProcessEnv = process.env): string =>
  path.join(projectStateDir(dir, env), 'sessions', `${id}.lock`);

/** EPERM 은 남의 사용자 프로세스다 — 살아 있다. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHold(file: string): SessionHold | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as SessionHold;
    return typeof parsed.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

/** 살아 있는 점유만 돌려준다. 죽은 pid·깨진 파일은 없는 것이다. */
export function sessionHold(dir: string, id: string, env: NodeJS.ProcessEnv = process.env): SessionHold | null {
  const hold = readHold(lockPath(dir, id, env));
  return hold && alive(hold.pid) ? hold : null;
}

/** 다른 살아 있는 프로세스가 쥐었으면 그것. 이 프로세스의 점유는 남의 것이 아니다. */
export function foreignHold(dir: string, id: string, env: NodeJS.ProcessEnv = process.env): SessionHold | null {
  const hold = sessionHold(dir, id, env);
  return hold && hold.pid !== process.pid ? hold : null;
}

export function busyMessage(hold: SessionHold, file: string): string {
  const what = hold.state === 'working' ? '엔진이 도는 중' : '배정 카드가 승인을 기다리는 중';
  return `다른 곳(${hold.by} · pid ${hold.pid})에서 이 세션이 ${what}이다 — 끝난 뒤 다시 한다. 그 프로세스가 아닌데 남았으면 ${file} 을 지운다.`;
}

/**
 * 세션을 쥔다. 다른 살아 있는 프로세스가 쥐었으면 던진다. 이 프로세스가 이미 쥐었으면 상태만 바꾼다 —
 * 같은 세션의 동시 호출은 세션 상태 검사가 막는다.
 */
export function claimSession(dir: string, id: string, state: HoldState, by: HoldBy, env: NodeJS.ProcessEnv = process.env): void {
  const file = lockPath(dir, id, env);
  const body = JSON.stringify({ pid: process.pid, by, state, at: new Date().toISOString() } satisfies SessionHold);
  const other = foreignHold(dir, id, env);
  if (other) throw new SessionBusyError(busyMessage(other, file));
  // 파일이 없을 때만 'wx' 로 만든다 — 둘이 동시에 비어 있는 것을 보고 만들면 늦은 쪽이 EEXIST 로 진다.
  // 우리 것이거나 죽은 것은 덮는다.
  if (readHold(file) === null) {
    // 첫 메시지 전의 세션은 기록 폴더가 아직 없다.
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      writeFileSync(file, body, { flag: 'wx' });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raced = foreignHold(dir, id, env);
      if (raced) throw new SessionBusyError(busyMessage(raced, file));
    }
  }
  writeFileSync(file, body);
}

/** 이 프로세스가 쥔 것만 놓는다 — 죽은 줄 알고 넘겨받은 다른 프로세스의 점유를 지우지 않게. */
export function releaseSession(dir: string, id: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = lockPath(dir, id, env);
  if (readHold(file)?.pid === process.pid) rmSync(file, { force: true });
}

/** 세션의 지금 상태를 점유에 맞춘다 — `blocked` 면 쥐고, 아니면 놓는다. */
export function syncHold(dir: string, id: string, state: HoldState | null, by: HoldBy, env: NodeJS.ProcessEnv = process.env): void {
  if (state === null) releaseSession(dir, id, env);
  else claimSession(dir, id, state, by, env);
}
