/**
 * 기계적으로 모을 수 있는 증거 (SPEC §5).
 * 사람이 적어 줘야 하는 것(문서 절·리뷰·측정)은 `--evidence <file.json>` 으로 받는다.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

/** `--evidence <file.json>` — 배열 하나. 모양 검사는 `collect` 가 한다. */
export function loadEvidenceFile(file: string): Evidence[] {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`증거 파일의 최상위는 배열이어야 한다: ${file}`);
  return parsed as Evidence[];
}
