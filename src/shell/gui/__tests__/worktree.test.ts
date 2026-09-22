/**
 * git worktree — 격리된 작업 폴더.
 * 진짜 `git` 을 돌린다. 모킹하면 이 파일이 검증하는 것이 파서뿐이라 의미가 없다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorktree, listWorktrees, removeWorktree, repoRoot, samePath, worktreesRoot } from '../worktree.ts';

/**
 * git 이 훅에서 심는 변수를 지운 환경. pre-commit 훅 안에서 이 파일이 돌면
 * 이게 없을 때 자식 git 이 **바깥 저장소**를 본다 (worktree.ts 의 gitEnv 와 같은 이유).
 */
function bareEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX']) delete env[key];
  return env;
}

/**
 * 커밋 하나 있는 빈 저장소. `worktree add` 는 HEAD 가 없으면 실패한다.
 * 워크트리 뿌리도 같이 가둔다 — 기본값은 **진짜 홈**(`~/.hs-orc/worktrees`)이라 테스트가 거기 쓰면 안 된다.
 */
function repo(): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hs-wt-')));
  process.env['HS_ORC_WORKTREES'] = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hs-wtroot-')));
  const run = (args: string[]): void => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: bareEnv() });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  run(['init', '-q', '-b', 'main']);
  run(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

describe('워크트리', () => {
  it('git 저장소가 아니면 조용히 빈 목록이다 — 화면이 죽지 않는다', () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), 'hs-plain-'));
    assert.equal(repoRoot(plain), null);
    assert.deepEqual(listWorktrees(plain), []);
    assert.throws(() => createWorktree(plain, 'x'), /git 저장소가 아니다/);
  });

  it('본체 작업 트리가 목록의 첫 항목이다', () => {
    const dir = repo();
    const items = listWorktrees(dir);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.main, true);
    assert.equal(items[0]?.branch, 'main');
  });

  it('만들면 `hs-orc/<이름>` 브랜치로 **저장소 밖** 워크트리 뿌리에 생긴다', () => {
    const dir = repo();
    const made = createWorktree(dir, 'feat-1');
    assert.equal(made.branch, 'hs-orc/feat-1');
    assert.equal(made.main, false);
    assert.ok(samePath(made.dir, path.join(worktreesRoot(dir), 'feat-1')));
    assert.ok(existsSync(path.join(made.dir, '.git')));
    assert.equal(listWorktrees(dir).length, 2);
    assert.equal(made.dir.startsWith(dir), false, '저장소 안에 만들면 프로젝트마다 무시 설정을 강요한다');
    assert.ok(worktreesRoot(dir).includes(path.basename(dir)), '저장소별로 갈라 둔다');
  });

  it('경로를 저장소 밖으로 빼는 이름을 거절한다', () => {
    const dir = repo();
    for (const bad of ['../탈출', 'a/b', '', '.hidden']) {
      assert.throws(() => createWorktree(dir, bad), /쓸 수 없는 글자|git 저장소가 아니다/, `허용되면 안 된다: ${bad}`);
    }
  });

  it('같은 이름을 두 번 만들지 않는다 — 남의 작업 위에서 엔진이 돌면 안 된다', () => {
    const dir = repo();
    createWorktree(dir, 'dup');
    assert.throws(() => createWorktree(dir, 'dup'), /이미 있다/);
  });

  it('지우면 목록에서 빠지고 머지된 브랜치까지 정리한다', () => {
    const dir = repo();
    const made = createWorktree(dir, 'gone');
    const result = removeWorktree(dir, made.dir);
    assert.equal(result.branchDeleted, true);
    assert.equal(existsSync(made.dir), false);
    assert.deepEqual(listWorktrees(dir).map((w) => w.main), [true]);
  });

  it('커밋이 남은 브랜치는 **지우지 않고 그렇다고 말한다**', () => {
    const dir = repo();
    const made = createWorktree(dir, 'keep');
    const run = (args: string[]): void => { spawnSync('git', args, { cwd: made.dir, env: bareEnv() }); };
    run(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'work']);

    const result = removeWorktree(dir, made.dir);
    assert.equal(result.branchDeleted, false, '머지 안 된 작업을 조용히 버리면 안 된다');
    assert.match(result.note, /남겼다/);
    assert.equal(spawnSync('git', ['rev-parse', '--verify', 'hs-orc/keep'], { cwd: dir, env: bareEnv() }).status, 0);
  });

  it('커밋 안 한 변경이 있으면 거절한다 — --force 를 쓰지 않는다', () => {
    const dir = repo();
    const made = createWorktree(dir, 'dirty');
    writeFileSync(path.join(made.dir, 'untracked.txt'), 'x', 'utf8');
    assert.throws(() => removeWorktree(dir, made.dir), /worktree remove 실패/);
    assert.equal(existsSync(made.dir), true);
  });

  it('실행 기록이 남아 있으면 거절한다 — 증거를 조용히 버리지 않는다', () => {
    const dir = repo();
    const made = createWorktree(dir, 'evidence');
    mkdirSync(path.join(made.dir, '.hs-orc', 'runs', '0922-0858-275'), { recursive: true });
    writeFileSync(path.join(made.dir, '.hs-orc', 'runs', '0922-0858-275', '01-Luna.stdout'), '{"raw":1}', 'utf8');

    assert.throws(() => removeWorktree(dir, made.dir), /실행 기록 1건이 남아 있다/);
    assert.equal(existsSync(made.dir), true, '거절했으면 폴더도 그대로여야 한다');
  });

  it('본체는 지울 수 없다', () => {
    const dir = repo();
    assert.throws(() => removeWorktree(dir, dir), /본체 작업 트리는 지울 수 없다/);
  });

  it('심볼릭 링크 경로와 실제 경로를 같은 폴더로 본다', () => {
    const dir = repo();
    assert.equal(samePath(dir, `${dir}/.`), true);
  });
});
