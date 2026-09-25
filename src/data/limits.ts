/** 상한 (SPEC §9, D-017). 상한 없는 자율 방식은 만들지 않는다. */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface Limits {
  readonly budgetUsd: number;
  /** 구독제에서 금액 대신 막는 것 (D-030). 돈이 아니라 사용량 한도가 희소 자원이다. */
  readonly tokenBudget: number;
  readonly maxIterations: number;
  readonly maxNodes: number;
  readonly runTimeoutMs: number;
  /** 대화 세션이 프롬프트에 싣는 최근 턴 수 (SPEC §6.4.3). */
  readonly contextTurns: number;
  /** 그 맥락의 글자 상한. 넘으면 앞을 자른다. */
  readonly contextChars: number;
}

const LIMITS_PATH = path.resolve(import.meta.dirname, '..', '..', 'data', 'limits.json');

let cached: Limits | undefined;

/** 수기 파일이라 값을 믿지 않는다. 0·음수 상한은 막지 않고, `contextChars` 가 2 미만이면 맥락 자르기가 깨진다. */
export function checkLimits(limits: Limits): Limits {
  for (const key of ['budgetUsd', 'tokenBudget', 'maxIterations', 'maxNodes', 'runTimeoutMs', 'contextTurns', 'contextChars'] as const) {
    const value = limits[key];
    if (!Number.isFinite(value) || value <= 0) throw new Error(`limits.json 의 ${key} 는 양수여야 한다: ${value}`);
  }
  if (!Number.isInteger(limits.contextTurns)) throw new Error(`limits.json 의 contextTurns 는 정수여야 한다: ${limits.contextTurns}`);
  if (!Number.isInteger(limits.contextChars) || limits.contextChars < 2) {
    throw new Error(`limits.json 의 contextChars 는 2 이상의 정수여야 한다: ${limits.contextChars}`);
  }
  return limits;
}

export function loadLimits(): Limits {
  cached ??= checkLimits(JSON.parse(readFileSync(LIMITS_PATH, 'utf8')) as Limits);
  return cached;
}
