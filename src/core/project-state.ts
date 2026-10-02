/**
 * 프로젝트별 상태의 자리 (D-071) — **홈이다**: `~/.hs-orc/projects/<키>/{runs,sessions,unclassified.jsonl}`.
 *
 * 작업 폴더 안(`.hs-orc/`)에 두면 그 폴더가 비어 있지 않게 된다. 빈 폴더를 요구하는 스캐폴더
 * (`npx create-expo-app .` 등)가 primary 위임에서 거절된다. 그래서 hs-orc 는 작업 폴더에 **아무것도 만들지 않는다.**
 * 옛 자리(`<폴더>/.hs-orc/`)는 읽기 폴백으로만 남는다 — 옮기지도 지우지도 않는다.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 폴더 하나의 키 — `<basename>-<실제 경로 sha256 앞 8자리>`. 워크트리 슬러그(D-028 결정 2)와 같은 규칙이다.
 * 이름은 `ls` 로 사람이 알아보라고, 해시는 서로 다른 `api` 두 개를 가르라고 붙인다.
 * 실제 경로로 재므로 링크·`/var`↔`/private/var` 같은 별칭이 한 키로 모인다. 없는 폴더는 그 경로 그대로 잰다.
 */
export function projectKey(dir: string): string {
  const real = (() => {
    try {
      return realpathSync(dir);
    } catch {
      return path.resolve(dir);
    }
  })();
  return `${path.basename(real)}-${createHash('sha256').update(real).digest('hex').slice(0, 8)}`;
}

/** 모든 프로젝트 상태의 뿌리. `HS_ORC_PROJECT_STATE` 로 옮길 수 있다 — 테스트 격리가 이것을 쓴다. */
export function projectStateRoot(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env['HS_ORC_PROJECT_STATE'] ?? path.join(home, '.hs-orc', 'projects');
}

export function projectStateDir(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(projectStateRoot(env), projectKey(dir));
}

/** D-071 이전 자리. **읽기만 한다.** */
export const legacyStateDir = (dir: string): string => path.join(dir, '.hs-orc');
