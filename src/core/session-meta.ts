/**
 * 세션 종료·보관 표식 (D-089) — 기록(JSONL) 밖의 사이드카 파일 `<id>.meta.json`.
 *
 * 기록에 새 kind 를 넣지 않는 이유: 화면·Core 의 `lastEvent` 두 벌, 목록 상태, Budget 재생(D-054), `isStale()` 의 기록 수가
 * 모두 기록을 센다. 종료·보관은 대화의 흐름이 아니라 세션의 바깥 상태라 기록을 건드리지 않는다.
 * 기록 파일은 지우지도 고치지도 않는다 — 보관은 숨김, 종료는 쓰기 잠금이다.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { projectStateDir } from './project-state.ts';

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

/** 한 칸만 바꾼다. rename 으로 바꿔 끼워 읽는 쪽이 반쯤 쓴 파일을 보지 않는다. */
function update(dir: string, id: string, key: keyof SessionMeta, on: boolean, env: NodeJS.ProcessEnv): SessionMeta {
  const next: { -readonly [K in keyof SessionMeta]: SessionMeta[K] } = { ...readSessionMeta(dir, id, env) };
  if (on) next[key] = new Date().toISOString();
  else delete next[key];
  const file = metaPath(dir, id, env);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next)}\n`, 'utf8');
  renameSync(tmp, file);
  return next;
}

/** 이미 같은 상태면 때를 바꾸지 않는다. */
export function setEnded(dir: string, id: string, on: boolean, env: NodeJS.ProcessEnv = process.env): SessionMeta {
  const meta = readSessionMeta(dir, id, env);
  return (meta.endedAt !== undefined) === on ? meta : update(dir, id, 'endedAt', on, env);
}

export function setArchived(dir: string, id: string, on: boolean, env: NodeJS.ProcessEnv = process.env): SessionMeta {
  const meta = readSessionMeta(dir, id, env);
  return (meta.archivedAt !== undefined) === on ? meta : update(dir, id, 'archivedAt', on, env);
}

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
