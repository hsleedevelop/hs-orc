import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Budget } from '../budget.ts';

/**
 * 비용 출처를 섞어 표시하지 않는다 (SPEC §2.5·§3.5, D-027).
 * `metered` 를 `actual` 이라 부르는 순간 "벤더가 청구한 금액"과 "내가 곱한 값"이 구분되지 않는다.
 */
describe('출처를 섞어 표시하지 않는다', () => {
  it('우선순위는 actual > metered > estimate 다', () => {
    const b = new Budget(100);
    assert.equal(b.charge('a', 1, 9, 5, 'api').source, 'actual');
    assert.equal(b.charge('b', undefined, 9, 5, 'api').source, 'metered');
    assert.equal(b.charge('c', undefined, 9, undefined, 'api').source, 'estimate');
  });

  it('섞이면 무엇이 섞였는지 누적 표시에 드러난다', () => {
    const b = new Budget(100);
    b.charge('a', 1, 9, undefined, 'api');
    b.charge('b', undefined, 9, 5, 'api');
    assert.deepEqual(b.sources, ['actual', 'metered']);
    assert.match(b.summary(), /실측\+토큰×선언단가/);
  });

  it('추정이 하나라도 있으면 그 사실을 숨기지 않는다', () => {
    const b = new Budget(100);
    b.charge('a', undefined, 9, undefined, 'api');
    assert.equal(b.hasEstimates, true);
    assert.match(b.summary(), /추정/);
  });
});

describe('압축 몫을 세지 못한 토큰 보고는 숨기지 않는다 (D-060)', () => {
  const usage = { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0 };

  it('선언된 엔진의 보고만 표시한다 — 토큰은 보고된 만큼만 더한다', () => {
    const b = new Budget(100, 1000);
    b.countTokens(usage);
    assert.doesNotMatch(b.summary(), /압축 토큰/);
    b.countTokens(usage, true);
    assert.equal(b.spentTokens, 22);
    assert.match(b.summary(), /압축 토큰을 보고하지 않는 엔진 1회/);
  });

  it('구간 기록(spend)에 실려 다시 열어도 남는다 — 옛 기록(칸 없음)은 0 이다 (D-054)', () => {
    const b = new Budget(100);
    const mark = b.mark();
    b.countTokens(usage);
    assert.equal(b.since(mark).compactionUncounted, undefined, '0 이면 기록에 쓰지 않는다');
    b.countTokens(usage, true);
    const spend = b.since(mark);
    assert.equal(spend.compactionUncounted, 1);

    const reopened = new Budget(100);
    reopened.absorb({ charges: [], tokens: 5, unreported: 0 });
    reopened.absorb(spend);
    assert.match(reopened.summary(), /압축 토큰을 보고하지 않는 엔진 1회/);
  });
});

describe('토큰 내역에 캐시 읽기를 따로 보인다 — 셈은 그대로다 (D-070, Q21)', () => {
  // Q20 §3 rn_temp 위임 1회: codex 캐시 읽기 943,872 + 그 외.
  const codex = { inputTokens: 53829, outputTokens: 3899, cachedInputTokens: 943872, cacheWriteTokens: 0 };
  const claude = { inputTokens: 40000, outputTokens: 2000, cachedInputTokens: 0, cacheWriteTokens: 16722 };

  it('누계는 네 칸 1:1 그대로, 요약은 캐시 읽기와 그 외를 나눈다', () => {
    const b = new Budget(20, 2000000);
    b.countTokens(codex);
    b.countTokens(claude);
    assert.equal(b.spentTokens, 1060322);
    assert.equal(b.cacheReadTokens, 943872);
    assert.match(b.summary(), /토큰 1060322\/2000000 \(캐시 읽기 943872 · 그 외 116450\)/);
    assert.equal(b.tokensExceeded(), false);
  });

  it('토큰이 없으면 내역을 달지 않는다', () => {
    assert.doesNotMatch(new Budget(20, 2000000).summary(), /캐시 읽기/);
  });

  it('칸을 안 준 보고는 0 으로 읽지 않고 미보고 횟수로 보인다', () => {
    const b = new Budget(20, 2000000);
    b.countTokens(codex);
    b.countTokens({ inputTokens: 100, outputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 0, cachedInputUnreported: true });
    assert.equal(b.spentTokens, 1001705);
    assert.match(b.summary(), /\(캐시 읽기 943872 · 그 외 57833 · 캐시 읽기 미보고 1회\)/);
  });

  it('spend 줄에 실려 다시 열어도 되살아나고, 옛 기록(칸 없음)은 내역 없음이다 (D-054)', () => {
    const b = new Budget(20, 2000000);
    const mark = b.mark();
    b.countTokens(codex);
    b.countTokens({ ...claude, cachedInputUnreported: true });
    const spend = JSON.parse(JSON.stringify(b.since(mark))) as ReturnType<Budget['since']>;
    assert.equal(spend.cacheReadTokens, 943872);
    assert.equal(spend.cacheReadUnreported, 1);

    const reopened = new Budget(20, 2000000);
    reopened.absorb(spend);
    assert.equal(reopened.summary(), b.summary());

    const old = new Budget(20, 2000000);
    old.absorb({ charges: [], tokens: 5000, unreported: 0 });
    assert.match(old.summary(), /토큰 5000\/2000000 \(캐시 읽기 내역 없음\)/);
    old.absorb(spend);
    assert.equal(old.spentTokens, 1065322, '판정 누계는 옛 기록까지 그대로 센다');
    assert.match(old.summary(), /\(캐시 읽기 943872 · 그 외 116450 · 내역 없음 5000 · 캐시 읽기 미보고 1회\)/);
  });

  it('토큰이 0 인 구간은 내역 칸을 쓰지 않는다', () => {
    const b = new Budget(20);
    assert.equal(b.since(b.mark()).cacheReadTokens, undefined);
  });
});
