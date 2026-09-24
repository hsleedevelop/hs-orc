/**
 * 의존성이 설치돼 있는가 (D-028 후속). **세 셸이 같이 쓴다** — GUI 만 알면 반쪽이다.
 * 첫 실사용은 CLI 였고, 거기서 primary 가 막혔다.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

function isDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 설치할 것이 있는가. 의존성 필드가 모두 비었고 workspaces 도 없으면 `node_modules` 가 없어도 정상이다 —
 * 그 상태에 "npm install" 을 권하면 오탐이다 (2026-09-24 R01 실측, 의존성 0개 스크래치 저장소).
 * 못 읽으면 있다고 본다 — 확인 못 한 것을 "설치할 것 없음" 으로 넘기지 않는다.
 */
function declaresDeps(manifest: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
    if (pkg['workspaces'] !== undefined) return true;
    return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some((field) => {
      const deps = pkg[field];
      return typeof deps === 'object' && deps !== null && Object.keys(deps).length > 0;
    });
  } catch {
    return true;
  }
}

/**
 * 의존성이 설치돼 있는가.
 *
 * 워크트리를 새로 만들면 `node_modules` 가 따라오지 않는다. 그 상태로 `--write` 를 켜고 돌리면
 * primary 가 자기 산출물을 검증하지 못해 **시간과 돈을 태우고 나서야** 막힌다 —
 * 2026-09-22 첫 실사용에서 실제로 그랬다.
 *
 * **설치를 대신 해 주지 않는다.** 네트워크를 쓰고 시간이 걸리는 일이라 사람이 결정한다.
 * 제품은 사실과 명령을 보여줄 뿐이다 (D-022 의 "제안만 한다" 와 같은 정신).
 */
export type DepStatus =
  /** 판단할 매니페스트가 없다. Node 프로젝트가 아니거나 우리가 모르는 생태계다 — 아는 척하지 않는다. */
  | { readonly kind: 'unknown' }
  | { readonly kind: 'missing'; readonly manifest: string; readonly install: string }
  | { readonly kind: 'ready'; readonly manifest: string };

/** `package.json` 만 본다. 이 제품이 아는 생태계가 그것뿐이고, 모르는 것을 추측하지 않는다. */
export function depStatus(dir: string): DepStatus {
  const manifest = path.join(dir, 'package.json');
  if (!existsSync(manifest)) return { kind: 'unknown' };
  if (isDir(path.join(dir, 'node_modules')) || !declaresDeps(manifest)) return { kind: 'ready', manifest: 'package.json' };
  // lock 파일이 있으면 `ci` 가 맞다 — 워크트리에서 의존성 버전이 본체와 갈리면 검증이 거짓이 된다.
  const install = existsSync(path.join(dir, 'package-lock.json')) ? 'npm ci' : 'npm install';
  return { kind: 'missing', manifest: 'package.json', install };
}
