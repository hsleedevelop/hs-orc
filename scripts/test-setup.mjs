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
 * 프로젝트별 상태(D-071)의 뿌리도 가둔다 — 기본값은 **진짜 홈**(`~/.hs-orc/projects`)이라,
 * 세션·원시 로그를 쓰는 테스트가 거기 쌓이면 안 된다. 테스트 파일 프로세스마다 하나다.
 */
const projectState = mkdtempSync(path.join(os.tmpdir(), 'hs-orc-state-'));
process.env.HS_ORC_PROJECT_STATE = projectState;
process.on('exit', () => rmSync(projectState, { recursive: true, force: true }));
