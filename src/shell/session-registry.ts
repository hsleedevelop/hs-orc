/**
 * id·이름으로 세션을 찾는다 (D-085) — 다른 세션·오케스트레이터가 `hs-orc session send <id|이름>` 으로 부를 때다.
 *
 * 세션 id 는 폴더별 기록 안에서만 유일하다. 그래서 아는 폴더를 다 모아 찾는다: 부른 폴더 · GUI 최근 목록 ·
 * 상태 폴더의 출처 표식(`origin.json`, D-085 이후 기록이 남긴다) · 스크래치. 같은 상태 키는 한 폴더다.
 */
import path from 'node:path';
import { projectKey, stateOrigins } from '../core/project-state.ts';
import { listScratchSessions, listSessions, scratchRoot, type SessionSummary } from '../core/transcript.ts';
import { loadProjects, projectsFile } from './gui/projects.ts';

/** 스크래치 세션 폴더는 스크래치 목록이 따로 본다 — project 로 두 번 잡히지 않게 뺀다. */
function insideScratch(dir: string, env: NodeJS.ProcessEnv): boolean {
  const rel = path.relative(path.resolve(scratchRoot(env)), path.resolve(dir));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 아는 모든 세션, 최근 것이 먼저. 최근 목록을 못 읽어도 나머지로 찾는다. */
export function knownSessions(cwd: string, env: NodeJS.ProcessEnv = process.env): SessionSummary[] {
  let recent: string[] = [];
  try {
    recent = loadProjects(projectsFile(env));
  } catch {
    // 최근 목록은 보조다 — 깨졌다고 찾기를 막지 않는다.
  }
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of [cwd, ...recent, ...stateOrigins(env)]) {
    if (insideScratch(dir, env)) continue;
    const key = projectKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  return [...dirs.flatMap((d) => listSessions(d, 'project')), ...listScratchSessions(env)].sort((a, b) =>
    b.lastAt.localeCompare(a.lastAt),
  );
}

/** id 나 이름이 정확히 같은 세션들. 접두어·부분 일치는 하지 않는다. */
export function matchSessions(cwd: string, ref: string, env: NodeJS.ProcessEnv = process.env): SessionSummary[] {
  return knownSessions(cwd, env).filter((s) => s.id === ref || s.name === ref);
}

/** 둘 이상이면 던진다 — 짐작해서 남의 세션에 보내지 않는다. */
export function ambiguous(ref: string, hits: readonly SessionSummary[]): Error {
  return new Error(`${ref} 에 맞는 세션이 ${hits.length}개다 — 이름을 바꾸거나 다음 중 하나를 고른다:\n${hits.map((s) => `  ${s.id}  ${s.dir}`).join('\n')}`);
}

/** id 나 이름이 정확히 같은 세션 하나. 없거나 둘 이상이면 던진다. */
export function resolveSession(cwd: string, ref: string, env: NodeJS.ProcessEnv = process.env): SessionSummary {
  const hits = matchSessions(cwd, ref, env);
  const [only] = hits;
  if (only && hits.length === 1) return only;
  if (hits.length === 0) throw new Error(`그런 세션이 없다: ${ref} — hs-orc session ls`);
  throw ambiguous(ref, hits);
}

/** 다른 세션이 이미 쓰는 이름이면 던진다. 자기 자신의 이름은 겹침이 아니다. */
export function assertNameFree(cwd: string, name: string, self: { readonly dir: string; readonly id: string }, env: NodeJS.ProcessEnv = process.env): void {
  if (!name) return;
  const taken = knownSessions(cwd, env).find((s) => s.name === name && !(s.id === self.id && projectKey(s.dir) === projectKey(self.dir)));
  if (taken) throw new Error(`이름 ${name} 은 이미 다른 세션(${taken.id} · ${taken.dir})이 쓴다.`);
}
