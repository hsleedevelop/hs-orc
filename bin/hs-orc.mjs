#!/usr/bin/env node
/**
 * hs-orc 진입점 — 어느 프로젝트 디렉터리에서든 부른다.
 *
 *   hs-orc "<작업>" [옵션…]        → src/shell/cli.ts
 *   hs-orc tui ["<작업>"] [옵션…]  → src/shell/tui/main.ts
 *   hs-orc gui                      → 렌더러 번들 → electron src/shell/gui/main.ts
 *
 * **빌드 산출물(dist/)을 만들지 않는다** (D-019). `.ts` 를 Node 타입 스트리핑으로 그대로 실행한다.
 * 이 파일만 `.mjs` 인 이유가 그것이다 — 진입점 자신은 스트리핑 없이 떠야 한다.
 *
 * **Shell 만 건드린다** (D-001). Core·adapters·data 는 이 파일이 import 하지 않는다.
 *
 * 경로 해석이 두 기준으로 갈리는 것은 **의도다**:
 *   설치 위치 기준 — data/{matrix,engines,limits,verify}.json. 어디서 부르든 같은 매트릭스다.
 *   cwd 기준       — .hs-orc/runs, .hs-orc/unclassified.jsonl. 산출물은 작업 중인 프로젝트에 쌓인다.
 * `src/shell/__tests__/bin.test.ts` 가 이 갈림을 프로세스 수준에서 고정한다.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const USAGE = `hs-orc ${version} — 작업 1건을 분류·배정하고 두 슬롯(primary·reviewer)으로 실행한다.

  hs-orc "<작업>" [옵션…]        배정·비용 제시. 실제 실행은 --run 이다 (승인 게이트).
  hs-orc tui ["<작업>"] [옵션…]  TUI
  hs-orc chat [--scratch|--resume <id>|--list]  대화 세션 (줄 입력)
  hs-orc gui                      GUI (Electron)
  hs-orc -- "<작업>"              첫 인자를 하위명령으로 해석하지 않는다
  hs-orc --help | --version

cli 옵션 전체는 인자 없이 \`hs-orc\` 를 부르면 나온다.
매트릭스는 설치 위치를 읽는다: ${ROOT}
실행 산출물은 **부른 디렉터리**의 .hs-orc/ 에 쌓인다.`;

// 스트리핑이 꺼져 있으면 첫 import 에서 문법 오류로 죽는다 — 원인을 알 수 없는 실패 대신 여기서 막는다.
// `process.features.typescript` 가 없는 구버전은 플래그로 판정한다 (`??` 는 undefined 만 받는다).
const typeStripping =
  process.features.typescript ??
  /--experimental-(strip|transform)-types/.test(`${process.env.NODE_OPTIONS ?? ''} ${process.execArgv.join(' ')}`);
if (!typeStripping) {
  process.stderr.write(
    `hs-orc 는 .ts 를 그대로 실행한다 (D-019: 빌드 단계 없음). 이 Node 는 타입 스트리핑이 꺼져 있다.\n` +
      `  실행 중: node ${process.versions.node}\n` +
      `  해결: 타입 스트리핑이 기본으로 켜진 Node 로 올리거나, NODE_OPTIONS=--experimental-strip-types 를 준다.\n`,
  );
  process.exit(1);
}

/** 설치 위치의 `.ts` 를 **같은 프로세스에서** 띄운다. */
async function runShell(relative, args) {
  const target = path.join(ROOT, relative);
  if (!existsSync(target)) {
    process.stderr.write(`설치가 깨졌다 — 그런 파일이 없다: ${target}\n`);
    process.exit(1);
  }
  // 하위 프로세스를 하나 더 두지 않는다. 래퍼가 끼면 TUI 의 raw mode 와
  // 엔진 프로세스 그룹 종료(SPEC §3)가 한 겹 멀어진다. argv 만 실제 호출 모양으로 바꾼다.
  process.argv = [process.argv[0], target, ...args];
  await import(pathToFileURL(target).href);
}

/** devDependency 바이너리는 **설치 위치**에서 찾는다. 없으면 조용히 넘어가지 않는다. */
function localBin(name) {
  const bin = path.join(ROOT, 'node_modules', '.bin', name);
  if (!existsSync(bin)) {
    process.stderr.write(
      `${name} 이 설치 위치에 없다: ${bin}\n` +
        `  GUI 는 devDependencies(esbuild·electron)를 쓴다. ${ROOT} 에서 npm install 을 먼저 한다.\n`,
    );
    process.exit(1);
  }
  return bin;
}

/**
 * 렌더러만 묶는다 — Chromium 은 TS 도 bare specifier 도 못 읽는다 (D-019 의 S7 개정).
 * cli·tui 에는 번들이 없다. 이 한 곳이 유일한 예외다.
 */
function bundleRenderer() {
  const r = spawnSync(
    localBin('esbuild'),
    [
      'src/shell/gui/renderer/app.ts',
      '--bundle',
      '--format=esm',
      '--outfile=src/shell/gui/renderer/bundle.js',
      '--log-level=warning',
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  return r.status ?? 1;
}

function runGui(args) {
  const built = bundleRenderer();
  if (built !== 0) process.exit(built);
  // electron 은 **부른 디렉터리**에서 돌린다 — .hs-orc/ 가 작업 중인 프로젝트에 쌓여야 한다.
  const r = spawnSync(localBin('electron'), [path.join(ROOT, 'src/shell/gui/main.ts'), ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}

const argv = process.argv.slice(2);
const first = argv[0];

if (first === '--help' || first === '-h' || first === 'help') {
  process.stdout.write(`${USAGE}\n`);
} else if (first === '--version' || first === '-v') {
  process.stdout.write(`${version}\n`);
} else if (first === 'tui') {
  await runShell('src/shell/tui/main.ts', argv.slice(1));
} else if (first === 'chat') {
  await runShell('src/shell/chat-main.ts', argv.slice(1));
} else if (first === 'gui') {
  runGui(argv.slice(1));
} else if (first === 'build-gui') {
  // package.json 의 `build:gui` 가 부른다. esbuild 호출을 두 군데 적어 두면 갈라진다.
  process.exit(bundleRenderer());
} else {
  await runShell('src/shell/cli.ts', first === '--' ? argv.slice(1) : argv);
}
