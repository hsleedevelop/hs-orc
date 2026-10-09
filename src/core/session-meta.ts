/**
 * 세션 종료·보관 표식 (D-089) — 기록(JSONL) 밖의 사이드카 파일 `<id>.meta.json`.
 *
 * 기록에 새 kind 를 넣지 않는 이유: 화면·Core 의 `lastEvent` 두 벌, 목록 상태, Budget 재생(D-054), `isStale()` 의 기록 수가
 * 모두 기록을 센다. 종료·보관은 대화의 흐름이 아니라 세션의 바깥 상태라 기록을 건드리지 않는다.
 * 기록 파일은 지우지도 고치지도 않는다 — 보관은 숨김, 종료는 쓰기 잠금이다.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { projectStateDir } from './project-state.ts';
import { alive, createAtomically, removeDead } from './session-lock.ts';

export interface SessionMeta {
  /** 종료한 때. 있으면 이 세션에는 아무것도 보내지 않는다 — 열람만 된다. */
  readonly endedAt?: string;
  /** 보관한 때. 있으면 사이드바 기본 목록에서 숨는다 — 찾기·보내기는 그대로다. */
  readonly archivedAt?: string;
}

export class SessionEndedError extends Error {
  override name = 'SessionEndedError';
}

/** 기록(`<id>.jsonl`)·점유(`<id>.lock`) 옆이다. 목록은 `.jsonl` 만 세므로 세션으로 잡히지 않는다. */
export const metaPath = (dir: string, id: string, env: NodeJS.ProcessEnv = process.env): string =>
  path.join(projectStateDir(dir, env), 'sessions', `${id}.meta.json`);

/** 없거나 깨졌으면 빈 표식이다 — 깨진 표식 때문에 세션을 못 열면 안 된다. */
export function readSessionMeta(dir: string, id: string, env: NodeJS.ProcessEnv = process.env): SessionMeta {
  try {
    const parsed = JSON.parse(readFileSync(metaPath(dir, id, env), 'utf8')) as Record<string, unknown>;
    return {
      ...(typeof parsed['endedAt'] === 'string' ? { endedAt: parsed['endedAt'] } : {}),
      ...(typeof parsed['archivedAt'] === 'string' ? { archivedAt: parsed['archivedAt'] } : {}),
    };
  } catch {
    return {};
  }
}

/** 갱신 잠금을 이만큼 기다린다 — 갱신 한 번은 읽기·쓰기·rename 이라 이렇게 걸릴 수 없다. 넘으면 남은 잠금을 사람이 본다. */
const UPDATE_WAIT_MS = 3000;
const pause = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * 프로세스 사이 짧은 잠금 — 검사와 쓰기를 한 덩어리로 묶는다. 차지·죽은 잠금 넘겨받기는 세션 점유(D-085)와 같은 방식이다.
 * `UPDATE_WAIT_MS` 넘게 못 쥐면 `busy(pid)` 문구로 던진다 — 잠금 경로를 말해 남은 잠금을 사람이 지울 수 있게.
 */
function withFileLock<T>(lock: string, busy: (pid: number) => string, fn: () => T): T {
  mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + UPDATE_WAIT_MS;
  for (;;) {
    if (createAtomically(lock, JSON.stringify({ pid: process.pid }))) break;
    let seen: string;
    try {
      seen = readFileSync(lock, 'utf8');
    } catch {
      continue; // 그 사이 풀렸다.
    }
    const pid = (() => {
      try {
        return (JSON.parse(seen) as { pid?: unknown }).pid;
      } catch {
        return undefined;
      }
    })();
    if (typeof pid !== 'number' || !alive(pid)) {
      removeDead(lock, seen);
      continue;
    }
    if (Date.now() > deadline) throw new Error(`${busy(pid)} 그 프로세스가 아닌데 남았으면 ${lock} 을 지운다.`);
    pause(5);
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * 표식 갱신을 프로세스 사이에 직렬화한다 — `<id>.meta.json.lock`. rename 은 파일을 통째로 바꿔 끼울 뿐이라, 두 GUI 가 각자 읽은
 * 옛 값을 쓰면 남이 바꾼 칸(예: 복원하는 사이 붙은 `endedAt`)을 지운다.
 */
const withUpdateLock = <T>(file: string, fn: () => T): T =>
  withFileLock(`${file}.lock`, (pid) => `세션 표식을 갱신하지 못했다 — 다른 곳(pid ${pid})이 갱신 중이다.`, fn);

/**
 * 프로젝트(상태 키)의 역할 잠금 `sessions/roles.lock` (D-090). 오케스트레이터 0~1 은 다른 세션들을 보고 판정하므로 세션 점유(`<id>.lock`)로는
 * 못 막는다 — 두 프로세스가 각자 다른 세션을 쥐고 같은 순간 검사를 지나면 둘 다 쓴다(PR #126 리뷰). 오케스트레이터를 **늘리는** 쓰기
 * (만들기·지정·project 세션의 다시 열기·복원 — 숨은 워커도 그 사이 지정될 수 있어 역할까지 잠금 안에서 읽는다)는 모두 이 안에서 다시 검사하고 쓴다. 줄이는 쓰기(해제·종료)는 계약을 깨지 않아 잡지 않는다.
 */
export const roleLockPath = (dir: string, env: NodeJS.ProcessEnv = process.env): string =>
  path.join(projectStateDir(dir, env), 'sessions', 'roles.lock');

export const withRoleLock = <T>(dir: string, fn: () => T, env: NodeJS.ProcessEnv = process.env): T =>
  withFileLock(roleLockPath(dir, env), (pid) => `세션 역할을 바꾸지 못했다 — 다른 곳(pid ${pid})이 이 폴더의 역할을 바꾸는 중이다.`, fn);

/**
 * 한 칸만 바꾼다 — **잠금 안에서 최신 값을 읽어** 다른 칸은 그대로 둔다. 이미 같은 상태면 쓰지 않는다(때를 바꾸지 않는다).
 * rename 으로 바꿔 끼워 잠그지 않고 읽는 쪽(목록·검사)도 반쯤 쓴 파일을 보지 않는다.
 */
function update(dir: string, id: string, key: keyof SessionMeta, on: boolean, env: NodeJS.ProcessEnv): SessionMeta {
  const file = metaPath(dir, id, env);
  return withUpdateLock(file, () => {
    const current = readSessionMeta(dir, id, env);
    if ((current[key] !== undefined) === on) return current;
    const next: { -readonly [K in keyof SessionMeta]: SessionMeta[K] } = { ...current };
    if (on) next[key] = new Date().toISOString();
    else delete next[key];
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next)}\n`, 'utf8');
    renameSync(tmp, file);
    return next;
  });
}

export const setEnded = (dir: string, id: string, on: boolean, env: NodeJS.ProcessEnv = process.env): SessionMeta =>
  update(dir, id, 'endedAt', on, env);

export const setArchived = (dir: string, id: string, on: boolean, env: NodeJS.ProcessEnv = process.env): SessionMeta =>
  update(dir, id, 'archivedAt', on, env);

export const sessionEnded = (dir: string, id: string, env: NodeJS.ProcessEnv = process.env): boolean =>
  readSessionMeta(dir, id, env).endedAt !== undefined;

export const endedMessage = (id: string): string =>
  `세션 ${id} 은 종료됐다 — 읽기만 된다(hs-orc session show ${id}). 이어 쓰려면 GUI 세션 머리의 "다시 열기" 를 누른다.`;

/**
 * 종료된 세션이면 던진다. **쓰는 쪽은 점유를 쥔 뒤에 부른다** — GUI 는 점유를 쥔 채 표식을 쓰므로,
 * 쥐기 전에만 보면 그 사이 종료된 세션에 한 턴이 붙는다.
 */
export function assertNotEnded(dir: string, id: string, env: NodeJS.ProcessEnv = process.env): void {
  if (sessionEnded(dir, id, env)) throw new SessionEndedError(endedMessage(id));
}
