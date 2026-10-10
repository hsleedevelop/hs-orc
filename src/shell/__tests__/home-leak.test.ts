import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { decisionLogPath } from '../../core/decision-log.ts';
import { projectStateRoot } from '../../core/project-state.ts';
import { scratchRoot } from '../../core/transcript.ts';
import { projectsFile } from '../gui/projects.ts';
import { worktreesRoot } from '../gui/worktree.ts';

/**
 * 홈 누수 가드 — 테스트가 개발자의 실제 `~/.hs-orc`·`~/.claude/logs` 에 닿지 않는다.
 *
 * 실측: 최근 목록(`~/.hs-orc/projects.json`)이 갇히지 않아 `chat --resume`·`findSession` 이 개발자의 실제 폴더를
 * 뒤졌고, iCloud 폴더의 readdir 에서 `npm test` 가 멈췄다. `scripts/test-setup.mjs` 가 홈 기준 경로를 임시 뿌리로 돌리고,
 * 자식 프로세스는 `...process.env` 로 물려받는다. 그 격리가 **풀렸는지** 여기서 잰다.
 * 음성 대조: 같은 함수에 환경변수만 빼면 홈을 가리킨다 — 가드가 무의미하게 통과하지 않는다는 증거.
 */
const home = os.homedir();
const underHome = (p: string): boolean => {
  const rel = path.relative(home, path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const PATHS: ReadonlyArray<readonly [string, (env?: NodeJS.ProcessEnv) => string]> = [
  ['HS_ORC_PROJECT_STATE', (env) => projectStateRoot(env)],
  ['HS_ORC_PROJECTS', (env) => projectsFile(env)],
  ['HS_ORC_SCRATCH', (env) => scratchRoot(env)],
  ['HS_ORC_WORKTREES', (env) => worktreesRoot('/repo', env)],
  ['HS_ORC_DECISION_LOG', (env) => decisionLogPath(env)],
];

describe('홈 누수 가드', () => {
  it('테스트 프로세스의 홈 기준 경로가 모두 홈 바깥이다', () => {
    for (const [name, resolve] of PATHS) {
      assert.ok(process.env[name], `${name} 가 비었다 — npm test 의 --import scripts/test-setup.mjs 가 빠졌거나 그 줄이 지워졌다.`);
      assert.equal(underHome(resolve()), false, `${name} 이 홈을 가리킨다: ${resolve()}`);
    }
  });

  it('음성 대조: 환경변수가 없으면 같은 경로가 홈을 가리킨다', () => {
    for (const [name, resolve] of PATHS) assert.equal(underHome(resolve({})), true, `${name} 의 기본값이 홈이 아니다 — 이 가드를 다시 본다.`);
  });
});
