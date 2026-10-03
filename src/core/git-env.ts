/**
 * 자식 git 이 **`cwd` 의 저장소**를 보게 하는 환경.
 *
 * shell(워크트리)·core(증거 수집)·테스트가 같은 목록을 쓴다 — 목록이 갈라지면 어느 한쪽이 바깥 저장소를 본다.
 */

/**
 * 상속하면 **다른 저장소를 보게 되는** 환경 변수.
 *
 * git 이 훅·필터·별칭을 부를 때 이것들을 심는다. 그 안에서 hs-orc 가 돌면
 * `cwd` 가 무엇이든 자식 git 은 바깥 저장소의 GIT_DIR·인덱스를 쓴다
 * (실측: pre-commit 훅에서 `git worktree add` 가 `.git/index: Not a directory` 로 죽었다.
 * 2026-10-03 에는 훅 아래 테스트의 `git init` 이 공유 config 의 `core.bare` 를 true 로 뒤집었다).
 */
export const INHERITED_GIT_ENV = [
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
] as const;

/** `cwd` 가 유일한 기준이 되도록 위 변수를 지운 환경. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of INHERITED_GIT_ENV) delete env[key];
  return env;
}
