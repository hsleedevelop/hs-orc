import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  /**
   * 원래 이 자리는 "저장소 기본값은 비어 있다" 였다. 그 불변식이 지키려던 것은
   * **제품이 단가를 지어내지 않는다** 였지, 표가 영원히 비어 있어야 한다는 게 아니다.
   * 2026-09-22 에 사람이 1차 자료(OpenAI 공식 가격표)로 codex 4행을 선언했으므로,
   * 지금 유효한 규칙 두 가지로 바꿔 고정한다.
   */
  it('claude 모델은 선언하지 않는다 — CLI 가 total_cost_usd 를 주므로 이미 actual 이다', () => {
    const declared = Object.keys(loadPricing());
    assert.deepEqual(declared.filter((id) => id.startsWith('claude-')), [],
      '단가를 적는 순간 actual 보다 신뢰도 낮은 값이 그 자리를 차지할 수 있다');
    assert.ok(declared.length > 0, '선언이 하나도 없으면 codex·cursor 는 계속 estimate 로만 누적된다');
  });

  it('선언된 단가에는 출처가 붙어 있다 — 수기 파일이라 이것만이 근거다', () => {
    const raw = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'data', 'pricing.json'), 'utf8')) as {
      $evidence?: { source?: string; collectedAt?: string };
      models: Record<string, unknown>;
    };
    assert.match(raw.$evidence?.source ?? '', /^https:\/\//, '출처 URL 이 없으면 이 숫자는 추측과 구별되지 않는다');
    assert.match(raw.$evidence?.collectedAt ?? '', /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Object.keys(raw.models).length > 0);
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
