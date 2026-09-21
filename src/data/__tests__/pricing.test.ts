import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPricing, meteredUsd, type ModelPrice } from '../pricing.ts';

/**
 * 단가는 **선언이지 추론이 아니다** (D-027). 선언이 없으면 `metered` 가 생기지 않고
 * AA 추정치로 남는다 — 0 으로 떨어뜨리면 "공짜로 돌았다" 가 되어 누적 비용이 거짓이 된다.
 */
const withPricing = (models: Record<string, unknown>): NodeJS.ProcessEnv => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'hs-orc-price-')), 'pricing.json');
  writeFileSync(file, JSON.stringify({ models }), 'utf8');
  return { HS_ORC_PRICING: file };
};

const usage = { inputTokens: 1_000_000, outputTokens: 500_000, cachedInputTokens: 0, cacheWriteTokens: 0 };

describe('단가 선언 (D-027)', () => {
  it('저장소 기본값은 비어 있다 — 단가를 지어내지 않는다', () => {
    assert.deepEqual(loadPricing(), {});
  });

  it('파일이 없거나 깨져도 빈 표다 — 던져서 실행을 죽이지 않는다', () => {
    assert.deepEqual(loadPricing({ HS_ORC_PRICING: '/없는/경로.json' }), {});
  });

  it('필수 항목이 빠진 줄은 무시한다 — 반쪽 단가로 계산하지 않는다', () => {
    const table = loadPricing(withPricing({ ok: { inputPerMTok: 1, outputPerMTok: 2 }, broken: { inputPerMTok: 1 } }));
    assert.deepEqual(Object.keys(table), ['ok']);
  });

  it('측정 토큰 × 선언 단가로 계산한다', () => {
    const table: Record<string, ModelPrice> = { 'gpt-x': { inputPerMTok: 1, outputPerMTok: 4 } };
    // 1M input × $1 + 0.5M output × $4 = 1 + 2 = $3
    assert.equal(meteredUsd('gpt-x', usage, table), 3);
  });

  it('cachedInput 단가를 생략하면 input 단가를 쓴다', () => {
    const table: Record<string, ModelPrice> = { 'gpt-x': { inputPerMTok: 2, outputPerMTok: 0 } };
    const cached = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000_000, cacheWriteTokens: 0 };
    assert.equal(meteredUsd('gpt-x', cached, table), 2);
  });

  it('선언이 없는 모델은 0 이 아니라 undefined 다', () => {
    assert.equal(meteredUsd('없는-모델', usage, {}), undefined);
  });

  it('토큰 보고가 없으면 계산하지 않는다', () => {
    assert.equal(meteredUsd('gpt-x', undefined, { 'gpt-x': { inputPerMTok: 1, outputPerMTok: 1 } }), undefined);
  });
});
