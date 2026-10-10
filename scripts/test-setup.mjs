/**
 * 테스트 러너 전역 격리 — `npm test` 가 `node --import` 로 실어, 모든 테스트 파일 프로세스가 먼저 실행한다.
 * Jev 는 기본 켜짐이라(D-065) 키가 있는 셸에서는 CLI·GUI 를 띄우는 테스트가 실제로 api.typesafe.ai 를 부른다.
 * 자식 프로세스를 띄우는 테스트는 `...process.env` 로 이 값을 물려받는다.
 * 격리가 유지되는지는 `src/shell/__tests__/jev-leak.test.ts` 가 잰다.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HS_ORC_JEV = 'off';

/**
 * 홈을 기본값으로 쓰는 상태 경로도 전부 가둔다 — 테스트 파일 프로세스마다 하나의 임시 뿌리다.
 * 프로젝트별 상태(D-071, `~/.hs-orc/projects`)에 세션·원시 로그가 쌓이면 안 되고,
 * 최근 목록(`~/.hs-orc/projects.json`)을 읽으면 세션 찾기가 개발자의 실제 폴더를 뒤진다 — iCloud 폴더에서는 readdir 가 멈춘다.
 * 테스트가 자기 값을 넣으면 그것이 이긴다. 격리가 유지되는지는 `src/shell/__tests__/home-leak.test.ts` 가 잰다.
 */
const root = mkdtempSync(path.join(os.tmpdir(), 'hs-orc-state-'));
process.env.HS_ORC_PROJECT_STATE = path.join(root, 'projects');
process.env.HS_ORC_PROJECTS = path.join(root, 'projects.json');
process.env.HS_ORC_SCRATCH = path.join(root, 'scratch');
process.env.HS_ORC_WORKTREES = path.join(root, 'worktrees');
process.env.HS_ORC_DECISION_LOG = path.join(root, 'decision-log.jsonl');
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
