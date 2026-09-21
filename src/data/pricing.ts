/**
 * 모델별 단가 선언 (SPEC §2.5, D-027).
 *
 * **제품은 단가를 추측하지 않는다.** `claude` 만 `total_cost_usd` 를 돌려주고 codex·cursor 는
 * 토큰만 준다. 여기에 단가를 선언한 모델만 `metered`(측정 토큰 × 선언 단가)로 계산되고,
 * 선언이 없으면 AA 벤치마크 `estimate` 로 남는다 — 어느 쪽인지는 누적 표시에 드러난다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 토큰 수. `adapters/types.ts` 의 `Usage` 와 **구조가 같지만 import 하지 않는다** —
 * data/ 는 adapters/ 를 참조할 수 없다 (SPEC §1 레이어 경계). 구조적 타입이라 그대로 들어온다.
 */
export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
}

export interface ModelPrice {
  /** 100만 토큰당 USD. */
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  /** 생략하면 input 단가를 쓴다. */
  readonly cachedInputPerMTok?: number;
  readonly cacheWritePerMTok?: number;
}

const pricingPath = (env: NodeJS.ProcessEnv = process.env): string =>
  env['HS_ORC_PRICING'] ?? path.resolve(import.meta.dirname, '..', '..', 'data', 'pricing.json');

const isPrice = (v: unknown): v is ModelPrice =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as ModelPrice).inputPerMTok === 'number' &&
  typeof (v as ModelPrice).outputPerMTok === 'number';

/** 선언이 없거나 파일이 깨졌으면 **빈 표**다 — 기본값을 지어내지 않는다. */
export function loadPricing(env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, ModelPrice>> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(pricingPath(env), 'utf8'));
  } catch {
    return {};
  }
  const models = (raw as { models?: unknown }).models;
  if (typeof models !== 'object' || models === null) return {};
  const out: Record<string, ModelPrice> = {};
  for (const [id, price] of Object.entries(models)) if (isPrice(price)) out[id] = price;
  return out;
}

/**
 * 측정 토큰 × 선언 단가. 단가 선언이 없으면 **`undefined`** 다 — 0 으로 떨어뜨리면
 * "공짜로 돌았다"가 되어 누적 비용이 거짓이 된다.
 */
export function meteredUsd(
  modelId: string,
  usage: TokenCounts | undefined,
  table: Readonly<Record<string, ModelPrice>> = loadPricing(),
): number | undefined {
  const price = table[modelId];
  if (!price || !usage) return undefined;
  const cachedRate = price.cachedInputPerMTok ?? price.inputPerMTok;
  const writeRate = price.cacheWritePerMTok ?? price.inputPerMTok;
  const usd =
    (usage.inputTokens * price.inputPerMTok +
      usage.outputTokens * price.outputPerMTok +
      usage.cachedInputTokens * cachedRate +
      usage.cacheWriteTokens * writeRate) /
    1_000_000;
  return Number(usd.toFixed(6));
}
