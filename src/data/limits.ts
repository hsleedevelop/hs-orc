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
}

const LIMITS_PATH = path.resolve(import.meta.dirname, '..', '..', 'data', 'limits.json');

let cached: Limits | undefined;

export function loadLimits(): Limits {
  cached ??= JSON.parse(readFileSync(LIMITS_PATH, 'utf8')) as Limits;
  return cached;
}
