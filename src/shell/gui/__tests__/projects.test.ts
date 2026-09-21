/**
 * 최근 프로젝트 목록. **홈에 저장한다** — 이 테스트는 그 경로를 env 로 가두고 돈다
 * (진짜 `~/.hs-orc/projects.json` 을 건드리는 테스트는 아무도 못 믿는다).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_RECENT, describeProject, forgetProject, loadProjects, rememberProject, validateProject } from '../projects.ts';

const sandbox = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-projects-'));
  return { dir, file: path.join(dir, 'projects.json') };
};

describe('프로젝트 폴더', () => {
  it('폴더가 아니면 거절한다 — 잘못된 cwd 로 엔진을 띄우면 남의 파일을 고친다', () => {
    const { dir } = sandbox();
    assert.equal(validateProject(dir), dir);
    assert.throws(() => validateProject(path.join(dir, '없는-폴더')), /폴더가 아니다/);
  });

  it('git 여부와 표시용 짧은 경로를 같이 낸다', () => {
    const { dir } = sandbox();
    assert.equal(describeProject(dir).git, false, '.git 이 없으면 changed-files 증거가 성립하지 않는다');
    mkdirSync(path.join(dir, '.git'));
    const info = describeProject(dir, path.dirname(dir));
    assert.equal(info.git, true);
    assert.equal(info.name, path.basename(dir));
    assert.equal(info.short, `~/${path.basename(dir)}`, '홈 아래는 ~ 로 줄인다');
  });

  it('linked worktree 도 git 으로 본다 — 거기 `.git` 은 파일이다', () => {
    const { dir } = sandbox();
    writeFileSync(path.join(dir, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n', 'utf8');
    assert.equal(describeProject(dir).git, true);
  });

  it('최근 목록은 맨 앞으로 당기고 중복을 지운다', () => {
    const { dir, file } = sandbox();
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    rememberProject(a, file);
    rememberProject(b, file);
    assert.deepEqual(rememberProject(a, file), [a, b]);
    assert.deepEqual(forgetProject(b, file), [a]);
  });

  it(`${MAX_RECENT}개를 넘기지 않는다 — 더 쌓이면 목록이 아니라 로그다`, () => {
    const { dir, file } = sandbox();
    for (let i = 0; i < MAX_RECENT + 5; i += 1) rememberProject(path.join(dir, `p${i}`), file);
    assert.equal(loadProjects(file).length, MAX_RECENT);
  });

  it('파일이 없거나 깨져도 화면은 떠야 한다 — 빈 목록이다', () => {
    const { file } = sandbox();
    assert.deepEqual(loadProjects(file), []);
    writeFileSync(file, '{ 깨진', 'utf8');
    assert.deepEqual(loadProjects(file), []);
  });
});
