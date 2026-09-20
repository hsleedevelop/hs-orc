/**
 * 행별 기본 검증 명령 (SPEC §5, PLAN "여전히 남는 것").
 *
 * **추론하지 않는다.** 업무 유형만 보고 `npm test` 를 넣는 순간 그 프로젝트에서 틀리고,
 * 틀린 검증으로 닫은 완료는 "증거로 닫았다"는 거짓말이 된다.
 * 대신 프로젝트가 `data/verify.json` 에 **선언**하고, 제품은 그것을 그대로 읽는다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface VerifyCommand {
  readonly cmd: string;
  readonly phase?: string;
}

const VERIFY_PATH = (env: NodeJS.ProcessEnv = process.env): string =>
  env['HS_ORC_VERIFY_CONFIG'] ?? path.resolve(import.meta.dirname, '..', '..', 'data', 'verify.json');

/** `phase:명령` 이면 단계를 떼어낸다. 콜론이 명령의 일부일 수 있으므로 앞머리만 본다. */
export function parseVerify(entry: string): VerifyCommand {
  const [head, ...rest] = entry.split(':');
  return rest.length > 0 && head !== undefined && /^[a-z-]+$/.test(head)
    ? { cmd: rest.join(':'), phase: head }
    : { cmd: entry };
}

/** 선언이 없으면 **빈 배열**이다 — "기본값이 있겠지"로 채우지 않는다. */
export function defaultVerify(rowId: string, env: NodeJS.ProcessEnv = process.env): VerifyCommand[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(VERIFY_PATH(env), 'utf8')) as Record<string, unknown>;
  } catch {
    return []; // 설정 파일이 없는 것은 정상이다.
  }
  const pick = (key: string): string[] => (Array.isArray(parsed[key]) ? (parsed[key] as string[]) : []);
  const entries = [...pick('default'), ...pick(rowId)];
  return entries.filter((e) => typeof e === 'string' && e.trim()).map(parseVerify);
}
