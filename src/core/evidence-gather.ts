/**
 * 기계적으로 모을 수 있는 증거 (SPEC §5).
 * 사람이 적어 줘야 하는 것(문서 절·리뷰·측정)은 `--evidence <file.json>` 으로 받는다.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Evidence } from './evidence.ts';
import { gitEnv } from './git-env.ts';

/** 명령을 실제로 돌려 exit code 를 받는다. **출력이 아니라 코드가 증거다.** */
export function runCommand(cmd: string, cwd = process.cwd(), phase?: string, timeout = 300_000): Evidence {
  const r = spawnSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    kind: 'command',
    cmd,
    // 시그널로 죽으면 exit code 가 null 이다. -1 로 기록해 "성공"으로 읽히지 않게 한다.
    exitCode: r.status ?? -1,
    output: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000),
    ...(phase !== undefined ? { phase } : {}),
  };
}

/** 변경 파일 목록 — git 이 진실이다. 모델이 말한 목록을 믿지 않는다. 훅 아래에서도 `cwd` 의 저장소를 읽는다. */
export function changedFiles(cwd = process.cwd()): Evidence {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const files = (r.stdout ?? '')
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  return { kind: 'changed-files', files };
}

/**
 * 자동 쓰기 전 미커밋 파일 (D-086 H5). `changedFiles` 와 달리 **실패를 깨끗함으로 읽지 않는다** — git 이 없거나
 * 종료 코드가 0 이 아니면 `null` 이고, 호출자는 모르는 상태로 묻는다(fail-closed).
 */
export function uncommittedFiles(cwd: string): string[] | null {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) return null;
  return (r.stdout ?? '').split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
}

/** 테스트가 있다는 흔적 (D-093). 넓게 잡는다 — 하나라도 걸리면 "테스트 없음" 이라고 말하지 않는다. */
const TEST_TRACES = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
  '**/test_*.*',
  '**/__tests__',
  '**/test',
  '**/tests',
  '**/{jest,vitest,playwright,cypress}.config.*',
];

/**
 * 대상 폴더에 기존 테스트가 **없다고 결정론으로 말할 수 있는가** (D-093). 말할 수 있으면 근거 한 줄, 아니면 `null`.
 * 안전 쪽이다: `package.json` 이 있고, `scripts.test` 가 없거나 `npm init` 의 자리표시(`no test specified`)이고,
 * 테스트 흔적이 하나도 없을 때만이다. `package.json` 이 없는 폴더(Swift·Python…)는 판정하지 않는다 —
 * 테스트가 있는데 "없음" 으로 읽으면 안 돌린 위임이 통과한다.
 */
export function noTests(cwd: string): string | null {
  let scripts: unknown;
  try {
    scripts = (JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: unknown }).scripts;
  } catch {
    return null;
  }
  const test = scripts !== null && typeof scripts === 'object' ? (scripts as Record<string, unknown>)['test'] : undefined;
  if (test !== undefined && !(typeof test === 'string' && /no test specified/.test(test))) return null;
  const traces = globSync(TEST_TRACES, { cwd, exclude: (p) => /(^|\/)(node_modules|\.git|\.next)$/.test(p) });
  if (traces.length > 0) return null;
  return `package.json 에 test 스크립트가 없고${test === undefined ? '' : '(npm init 자리표시뿐)'} 테스트 파일·설정이 없다`;
}

/** 선언된 테스트 파일의 작업 전 내용 (D-047). 키는 cwd 기준 상대 경로다. */
export type TestSnapshot = ReadonlyMap<string, string>;

const findTests = (globs: readonly string[], cwd: string): string[] =>
  globSync([...globs], { cwd, exclude: (p) => /(^|\/)(node_modules|\.git)$/.test(p) }).sort();

export function snapshotTests(globs: readonly string[], cwd = process.cwd()): TestSnapshot {
  return new Map(findTests(globs, cwd).map((f) => [f, readFileSync(path.join(cwd, f), 'utf8')]));
}

/** `before` 의 줄이 `after` 안에 **순서대로 전부** 있는가 — 줄 추가만 한 변경이다. */
function appendOnly(before: string, after: string): boolean {
  const next = after.split('\n');
  let i = 0;
  for (const line of before.split('\n')) {
    while (i < next.length && next[i] !== line) i += 1;
    if (i === next.length) return false;
    i += 1;
  }
  return true;
}

/**
 * 기존 테스트가 약해졌는가 (D-047). 파일이 지워졌거나 원래 줄이 바뀌거나 빠졌으면 `weakened`, 새 파일·줄 추가는 `added`.
 * 줄 단위라 원래 줄을 남긴 채 사이에 `return;` 을 끼우는 약화는 못 잡는다 — reviewer·사람 몫이다.
 */
export function testChanges(
  before: TestSnapshot,
  globs: readonly string[],
  cwd = process.cwd(),
): Extract<Evidence, { kind: 'test-files' }> {
  const weakened: string[] = [];
  const added: string[] = [];
  for (const [file, old] of before) {
    const full = path.join(cwd, file);
    if (!existsSync(full)) {
      weakened.push(`\`${file}\` 가 지워졌다`);
      continue;
    }
    const now = readFileSync(full, 'utf8');
    if (now === old) continue;
    if (appendOnly(old, now)) added.push(`\`${file}\` +${now.split('\n').length - old.split('\n').length}줄`);
    else weakened.push(`\`${file}\` 기존 줄이 바뀌거나 지워졌다`);
  }
  for (const file of findTests(globs, cwd)) if (!before.has(file)) added.push(`\`${file}\` 새 파일`);
  return { kind: 'test-files', weakened, added };
}

/** `--evidence <file.json>` — 배열 하나. 모양 검사는 `collect` 가 한다. */
export function loadEvidenceFile(file: string): Evidence[] {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`증거 파일의 최상위는 배열이어야 한다: ${file}`);
  return parsed as Evidence[];
}
