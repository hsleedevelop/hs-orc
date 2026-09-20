/**
 * 실행별 원시 로그 보존 (PLAN S6-2, SPEC §3.5).
 * **파싱 실패가 원본 손실로 이어지지 않게** 어댑터가 보존한 raw 를 그대로 디스크에 남긴다.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface StoredRun {
  readonly dir: string;
  readonly files: readonly string[];
}

export function runStoreRoot(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  return env['HS_ORC_RUN_STORE'] ?? path.join(cwd, '.hs-orc', 'runs');
}

/** `<root>/<decisionId>/<seq>-<slot>.{stdout,stderr,meta.json}` */
export function storeRun(
  decisionId: string,
  seq: number,
  slotLabel: string,
  payload: { rawStdout: string; rawStderr: string; meta: Record<string, unknown> },
  root = runStoreRoot(),
): StoredRun {
  const dir = path.join(root, decisionId);
  mkdirSync(dir, { recursive: true });
  const base = `${String(seq).padStart(2, '0')}-${slotLabel.replace(/[^\w.-]/g, '_')}`;
  const files = [`${base}.stdout`, `${base}.stderr`, `${base}.meta.json`];
  writeFileSync(path.join(dir, files[0] as string), payload.rawStdout, 'utf8');
  writeFileSync(path.join(dir, files[1] as string), payload.rawStderr, 'utf8');
  writeFileSync(path.join(dir, files[2] as string), `${JSON.stringify(payload.meta, null, 2)}\n`, 'utf8');
  return { dir, files };
}
