/**
 * 기계적으로 모을 수 있는 증거 (SPEC §5).
 * 사람이 적어 줘야 하는 것(문서 절·리뷰·측정)은 `--evidence <file.json>` 으로 받는다.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Evidence } from './evidence.ts';

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

/** 변경 파일 목록 — git 이 진실이다. 모델이 말한 목록을 믿지 않는다. */
export function changedFiles(cwd = process.cwd()): Evidence {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const files = (r.stdout ?? '')
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  return { kind: 'changed-files', files };
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
