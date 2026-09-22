/**
 * git worktree — **격리된 작업 폴더**.
 *
 * `--write` 를 켜면 primary 슬롯이 파일을 고친다(D-025). 그 대상이 지금 사람이 편집 중인
 * 작업 트리면 되돌리기가 사람 몫이 된다. 워크트리는 그 위험을 **브랜치 하나로 가둔다** —
 * 마음에 안 들면 브랜치째 버리면 된다.
 *
 * 워크트리는 **저장소 밖, 홈에 둔다** (ao 와 같은 자리). 저장소 안(`.hs-orc/worktrees/`)에 두면
 * 프로젝트마다 무시 설정을 강요하고, 검색·빌드·감시 도구가 저장소를 재귀로 훑는다.
 *
 * Electron 을 import 하지 않는다 (`service.ts`·`projects.ts` 와 같은 이유). shell 안에만 있다 (D-001).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface WorktreeInfo {
  readonly dir: string;
  /** detached HEAD 면 null 이다 — "브랜치가 있다"고 거짓말하지 않는다. */
  readonly branch: string | null;
  readonly head: string;
  /** 저장소의 본체 작업 트리인가. 첫 항목이 언제나 본체다. */
  readonly main: boolean;
  readonly locked: boolean;
}

/** 워크트리 이름에 쓸 수 있는 글자. `..` 나 `/` 를 막는 것이 요점이다 — 경로가 저장소 밖으로 나가면 안 된다. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 상속하면 **다른 저장소를 보게 되는** 환경 변수.
 *
 * git 이 훅·필터·별칭을 부를 때 이것들을 심는다. 그 안에서 hs-orc 가 돌면
 * `cwd` 가 무엇이든 자식 git 은 바깥 저장소의 GIT_DIR·인덱스를 쓴다
 * (실측: pre-commit 훅에서 `git worktree add` 가 `.git/index: Not a directory` 로 죽었다).
 */
const INHERITED_GIT_ENV = [
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
] as const;

/** `cwd` 가 유일한 기준이 되도록 위 변수를 지운 환경으로 git 을 띄운다. */
function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of INHERITED_GIT_ENV) delete env[key];
  return env;
}

function git(cwd: string, args: readonly string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
}

/** 이 폴더의 작업 트리 최상위. git 저장소가 아니면 null 이다 — 예외로 화면을 죽이지 않는다. */
export function repoRoot(cwd: string): string | null {
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? r.out.trim() : null;
}

/**
 * **본체** 작업 트리. 워크트리 안에서 `rev-parse --show-toplevel` 은 그 워크트리를 답하므로
 * 저장소를 가리키는 값으로 쓸 수 없다. 목록의 첫 항목이 언제나 본체다.
 */
export function mainWorktree(cwd: string): string | null {
  return listWorktrees(cwd)[0]?.dir ?? null;
}

/**
 * 저장소별 폴더 이름. 이름만 쓰면 서로 다른 저장소의 `api` 두 개가 같은 자리를 노린다 —
 * 실제 경로 해시를 붙여 갈라 둔다.
 */
export function repoSlug(mainDir: string): string {
  const real = (() => {
    try {
      return realpathSync(mainDir);
    } catch {
      return path.resolve(mainDir);
    }
  })();
  return `${path.basename(real)}-${createHash('sha256').update(real).digest('hex').slice(0, 8)}`;
}

/**
 * 워크트리를 두는 곳 — **홈이다**(`~/.hs-orc/worktrees/<저장소>/`). 저장소 안이 아니다.
 * `HS_ORC_WORKTREES` 로 뿌리를 옮길 수 있다.
 */
export function worktreesRoot(mainDir: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const root = env['HS_ORC_WORKTREES'] ?? path.join(home, '.hs-orc', 'worktrees');
  return path.join(root, repoSlug(mainDir));
}

/** `git worktree list --porcelain` 이 진실이다. 디렉터리를 뒤져 추측하지 않는다. */
export function listWorktrees(cwd: string): WorktreeInfo[] {
  const repo = repoRoot(cwd);
  if (repo === null) return [];
  const r = git(repo, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];

  const items: WorktreeInfo[] = [];
  let dir = '';
  let head = '';
  let branch: string | null = null;
  let locked = false;
  const flush = (): void => {
    if (dir) items.push({ dir, head, branch, main: items.length === 0, locked });
    dir = '';
    head = '';
    branch = null;
    locked = false;
  };
  for (const line of r.out.split('\n')) {
    if (line.startsWith('worktree ')) { flush(); dir = line.slice('worktree '.length); }
    else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length, 'HEAD '.length + 8);
    else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    else if (line === 'locked' || line.startsWith('locked ')) locked = true;
  }
  flush();
  return items;
}

/**
 * 같은 폴더인가. **심볼릭 링크를 풀고 비교한다** — git 은 실제 경로를 답하는데(`/private/var/…`)
 * 화면이 들고 있는 것은 링크 경로(`/var/…`)일 수 있다. 문자열로만 비교하면 "현재 워크트리 없음"이 된다.
 */
export function samePath(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

export interface CreateOptions {
  /** 분기 기준. 기본은 현재 HEAD — 화면에서 고르게 하려면 여기로 준다. */
  readonly from?: string;
}

/**
 * 워크트리를 만들고 그 정보를 낸다. **브랜치를 새로 판다** (`hs-orc/<name>`).
 * 이미 있으면 만들지 않고 던진다 — 조용히 기존 것을 재사용하면 남의 작업 위에서 엔진이 돈다.
 */
export function createWorktree(cwd: string, name: string, options: CreateOptions = {}): WorktreeInfo {
  if (!NAME.test(name)) throw new Error(`워크트리 이름에 쓸 수 없는 글자다 (영문·숫자·. _ - 만): ${name}`);
  const repo = mainWorktree(cwd);
  if (repo === null) throw new Error(`git 저장소가 아니다: ${cwd}`);

  const root = worktreesRoot(repo);
  const dir = path.join(root, name);
  if (existsSync(dir)) throw new Error(`이미 있다: ${dir}`);
  mkdirSync(root, { recursive: true });

  const branch = `hs-orc/${name}`;
  const args = ['worktree', 'add', '-b', branch, dir, ...(options.from === undefined ? [] : [options.from])];
  const r = git(repo, args);
  // 실패를 성공으로 바꾸지 않는다. git 이 한 말을 그대로 올린다.
  if (!r.ok) throw new Error(`git worktree add 실패: ${r.err || '(stderr 없음)'}`);

  const made = listWorktrees(repo).find((w) => samePath(w.dir, dir));
  if (made === undefined) throw new Error(`만들었지만 목록에 없다: ${dir}`);
  return made;
}

export interface RemoveResult {
  readonly dir: string;
  /** 브랜치까지 지웠는가. 머지되지 않은 커밋이 있으면 **남긴다** — 작업을 조용히 버리지 않는다. */
  readonly branchDeleted: boolean;
  readonly note: string;
}

/**
 * 워크트리를 지운다. **파괴적이다** — 호출 전에 사용자 승인을 받아야 한다.
 *
 * 지키는 것:
 *   - 본체 작업 트리는 못 지운다.
 *   - `--force` 를 쓰지 않는다. 커밋 안 한 변경이 있으면 git 이 거절하고, 그 말을 그대로 올린다.
 *   - 브랜치는 `git branch -d`(머지된 것만) 로만 지운다. 거절당하면 남기고 그렇다고 말한다.
 *   - **실행 기록이 남아 있으면 거절한다.** 산출물은 cwd 기준으로 쌓이므로(`bin/hs-orc.mjs`)
 *     워크트리를 지우면 그 안의 `.hs-orc/runs/` 도 같이 사라진다. "증거로 종료" 하는 제품이
 *     증거를 조용히 버리면 안 된다 — 2026-09-22 에 실제로 첫 실사용 원시 로그를 이렇게 잃었다.
 */
export function removeWorktree(cwd: string, target: string): RemoveResult {
  const items = listWorktrees(cwd);
  const found = items.find((w) => samePath(w.dir, target));
  if (found === undefined) throw new Error(`이 저장소의 워크트리가 아니다: ${target}`);
  if (found.main) throw new Error('본체 작업 트리는 지울 수 없다');
  if (found.locked) throw new Error(`잠긴 워크트리다 — git worktree unlock 이 먼저다: ${found.dir}`);

  // 증거가 먼저다. git 이 dirty 를 거절하는 것과 같은 자리에서 같은 방식으로 막는다.
  const runs = path.join(found.dir, '.hs-orc', 'runs');
  const kept = existsSync(runs) ? readdirSync(runs) : [];
  if (kept.length > 0) {
    throw new Error(
      `실행 기록 ${kept.length}건이 남아 있다: ${runs}\n` +
        '지우면 그 사이클의 원시 로그와 판정 근거가 사라진다. 옮기거나 지운 뒤 다시 한다.',
    );
  }

  const repo = items[0]?.dir ?? cwd;
  const removed = git(repo, ['worktree', 'remove', found.dir]);
  if (!removed.ok) throw new Error(`git worktree remove 실패: ${removed.err || '(stderr 없음)'}`);

  if (found.branch === null) return { dir: found.dir, branchDeleted: false, note: 'detached HEAD 라 지울 브랜치가 없다' };
  const branch = git(repo, ['branch', '-d', found.branch]);
  return {
    dir: found.dir,
    branchDeleted: branch.ok,
    note: branch.ok
      ? `브랜치 ${found.branch} 도 지웠다`
      : `브랜치 ${found.branch} 는 남겼다 — 머지되지 않은 커밋이 있다 (git branch -D 로 직접 지운다)`,
  };
}
