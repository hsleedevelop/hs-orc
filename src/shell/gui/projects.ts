/**
 * GUI 가 작업할 **프로젝트 폴더** 목록.
 *
 * Electron 을 import 하지 않는다 — `service.ts` 와 같은 이유다. 창 없이 테스트한다.
 *
 * 저장 위치가 홈인 것은 의도다. `bin/hs-orc.mjs` 가 못 박은 두 기준(설치 위치 = 매트릭스,
 * cwd = 실행 산출물) 중 **어느 쪽도 아니다** — 최근 목록은 특정 프로젝트의 산출물이 아니라
 * 이 사람의 것이라, 프로젝트를 옮겨 다녀도 따라와야 한다.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { depStatus, type DepStatus } from '../deps.ts';

/** 최근 목록 상한. 더 쌓이면 목록이 아니라 로그다. */
export const MAX_RECENT = 10;

export interface ProjectInfo {
  readonly dir: string;
  /** 화면에 크게 쓰는 이름 — 마지막 경로 조각. */
  readonly name: string;
  /** 홈을 `~` 로 줄인 표시용 경로. */
  readonly short: string;
  /**
   * git 작업 트리인가 — 증거(`git status --porcelain`)가 성립하는 폴더인지 화면에서 알려준다.
   * **디렉터리인지 묻지 않는다**: linked worktree 의 `.git` 은 본체를 가리키는 *파일*이다.
   */
  readonly git: boolean;
  /** 지금 이 순간 존재하는가. 지워진 폴더도 목록에는 남기되 회색으로 보여 준다. */
  readonly exists: boolean;
  /** 검증 명령이 성립하는 상태인가. 새 워크트리는 거의 항상 `missing` 이다. */
  readonly deps: DepStatus;
}

export function projectsFile(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env['HS_ORC_PROJECTS'] ?? path.join(home, '.hs-orc', 'projects.json');
}

function isDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    // 없는 폴더다. 예외를 위로 던지면 화면이 안 뜬다.
    return false;
  }
}

export function describeProject(dir: string, home = os.homedir()): ProjectInfo {
  const resolved = path.resolve(dir);
  return {
    dir: resolved,
    name: path.basename(resolved) || resolved,
    short: resolved.startsWith(`${home}/`) ? `~${resolved.slice(home.length)}` : resolved,
    git: existsSync(path.join(resolved, '.git')),
    exists: isDir(resolved),
    deps: depStatus(resolved),
  };
}

/** 폴더가 아니면 **거절한다.** 잘못된 cwd 로 엔진을 띄우면 남의 프로젝트를 고칠 수 있다. */
export function validateProject(dir: string): string {
  const resolved = path.resolve(dir);
  if (!isDir(resolved)) throw new Error(`폴더가 아니다: ${resolved}`);
  return resolved;
}

export function loadProjects(file = projectsFile()): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const recent = (parsed as { recent?: unknown }).recent;
    if (!Array.isArray(recent)) return [];
    return recent.filter((d): d is string => typeof d === 'string').map((d) => path.resolve(d));
  } catch {
    // 파일이 없거나 깨졌다. 최근 목록이 비는 것은 복구 가능한 상태다 — 화면은 떠야 한다.
    return [];
  }
}

function save(recent: readonly string[], file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ recent }, null, 2)}\n`, 'utf8');
}

/** 맨 앞으로 당기고 중복을 지운다. 저장에 실패해도 **호출자에게는 알린다**(조용히 삼키지 않는다). */
export function rememberProject(dir: string, file = projectsFile()): string[] {
  const resolved = path.resolve(dir);
  const recent = [resolved, ...loadProjects(file).filter((d) => d !== resolved)].slice(0, MAX_RECENT);
  save(recent, file);
  return recent;
}

export function forgetProject(dir: string, file = projectsFile()): string[] {
  const resolved = path.resolve(dir);
  const recent = loadProjects(file).filter((d) => d !== resolved);
  save(recent, file);
  return recent;
}

export { depStatus, type DepStatus } from '../deps.ts';
