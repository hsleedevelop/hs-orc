/**
 * 누적 비용 추적과 상한 (D-017).
 *
 * 비용에는 세 출처가 있고 **섞어 표시하지 않는다** (SPEC §2.5 근거 등급과 같은 이유):
 *  - `actual`   — 엔진이 돌려준 값. 지금은 claude 만 `total_cost_usd` 를 준다.
 *  - `metered`  — 엔진이 보고한 **측정 토큰** × `data/pricing.json` 의 **선언 단가** (D-027).
 *                 벤더가 청구한 금액이 아니다. 단가 선언이 없으면 이 출처는 안 생긴다.
 *  - `estimate` — 매트릭스의 AA 벤치마크 작업당 비용. 위 둘이 없을 때의 마지막 수단이다.
 *
 * **등급과 직교하는 축이 하나 더 있다: 요금제** (D-030). 세 등급은 "값이 어디서 왔나" 를 구분하지만
 * "이 값이 청구되나" 는 구분하지 않는다. 구독제로 CLI 를 쓰면 `actual`(total_cost_usd) 조차
 * 청구되지 않는다 — API 로 썼다면 들었을 환산액이다. 그래서 **상한은 청구되는 금액에만 건다.**
 * 구독제에서 실제로 희소한 자원은 돈이 아니라 사용량 한도이고, 그쪽은 토큰 예산이 맡는다.
 */
import type { BillingPlan } from '../data/engines.ts';
import type { TokenCounts } from '../data/pricing.ts';

export type CostSource = 'actual' | 'metered' | 'estimate';

export interface Charge {
  readonly label: string;
  readonly usd: number;
  readonly source: CostSource;
  /** 이 금액이 실제로 청구되는가 (D-030). `subscription` 이면 환산액이다. */
  readonly plan: BillingPlan;
}

export interface BudgetMark {
  readonly charges: number;
  readonly tokens: number;
  readonly unreported: number;
}

/** 한 구간에 쌓인 과금·토큰. 대화 기록의 `spend` 줄이 이것이다 (D-054). */
export interface Spend {
  readonly charges: readonly Charge[];
  readonly tokens: number;
  readonly unreported: number;
}

export class TokenBudgetExceeded extends Error {
  override name = 'TokenBudgetExceeded';
  readonly spentTokens: number;
  readonly limitTokens: number;

  constructor(spentTokens: number, limitTokens: number) {
    super(`누적 토큰 상한 초과: ${spentTokens} / ${limitTokens} — 다음 사이클을 시작하지 않는다.`);
    this.spentTokens = spentTokens;
    this.limitTokens = limitTokens;
  }
}

export class BudgetExceeded extends Error {
  override name = 'BudgetExceeded';
  readonly spentUsd: number;
  readonly limitUsd: number;

  constructor(spentUsd: number, limitUsd: number) {
    super(`누적 비용 상한 초과: $${spentUsd.toFixed(4)} / $${limitUsd} — 다음 사이클을 시작하지 않는다.`);
    this.spentUsd = spentUsd;
    this.limitUsd = limitUsd;
  }
}

export class Budget {
  readonly charges: Charge[] = [];
  readonly limitUsd: number;
  /** 0 이면 토큰 상한을 걸지 않는다 — 선언하지 않은 상태와 같다. */
  readonly limitTokens: number;
  private tokens = 0;
  /** 엔진이 토큰을 보고하지 않은 사이클 수. **상한이 그만큼 못 본 것**이라 숨기지 않는다. */
  private unreported = 0;

  constructor(limitUsd: number, limitTokens = 0) {
    this.limitUsd = limitUsd;
    this.limitTokens = limitTokens;
  }

  /** 지금까지의 위치. `since()` 에 넘기면 그 뒤에 쌓인 것만 돌려준다 (D-054). */
  mark(): BudgetMark {
    return { charges: this.charges.length, tokens: this.tokens, unreported: this.unreported };
  }

  since(mark: BudgetMark): Spend {
    return {
      charges: this.charges.slice(mark.charges),
      tokens: this.tokens - mark.tokens,
      unreported: this.unreported - mark.unreported,
    };
  }

  /** 기록해 둔 증분을 되살린다 — 앱을 다시 켜고 세션을 열 때 (D-054). 상한 판정도 그대로 따라온다. */
  absorb(spend: Spend): void {
    this.charges.push(...spend.charges);
    this.tokens += spend.tokens;
    this.unreported += spend.unreported;
  }

  get spentTokens(): number {
    return this.tokens;
  }

  get unreportedCycles(): number {
    return this.unreported;
  }

  /**
   * 엔진이 보고한 토큰을 더한다 (D-030). `undefined` 면 **0 으로 채우지 않고** 못 본 것으로 센다 —
   * 0 으로 떨어뜨리면 "공짜로 돌았다" 가 되어 상한이 통째로 거짓이 된다.
   */
  countTokens(usage: TokenCounts | undefined): void {
    if (usage === undefined) {
      this.unreported += 1;
      return;
    }
    this.tokens += usage.inputTokens + usage.outputTokens + usage.cachedInputTokens + usage.cacheWriteTokens;
  }

  tokensExceeded(): boolean {
    return this.limitTokens > 0 && this.tokens >= this.limitTokens;
  }

  /**
   * **두 상한 중 하나라도** 닿았는가. 실행을 멈출지 묻는 곳은 전부 이것을 쓴다 —
   * `exceeded()`(금액)만 보면 구독제에서 아무것도 막지 못한다 (D-030).
   */
  limitReached(): boolean {
    return this.exceeded() || this.tokensExceeded();
  }

  /** 환산액까지 포함한 전체. **표시용이다** — 상한 판정에 쓰지 않는다. */
  get spentUsd(): number {
    return Number(this.charges.reduce((sum, c) => sum + c.usd, 0).toFixed(6));
  }

  /** **실제로 청구되는** 금액만 (D-030). 상한은 이 값에 걸린다. */
  get billedUsd(): number {
    return Number(
      this.charges.filter((c) => c.plan === 'api').reduce((sum, c) => sum + c.usd, 0).toFixed(6),
    );
  }

  /** 구독제 슬롯의 환산액. 청구되지 않지만 **배정 간 상대 비교**에는 그대로 쓸모 있다. */
  get convertedUsd(): number {
    return Number((this.spentUsd - this.billedUsd).toFixed(6));
  }

  /**
   * 우선순위는 **actual > metered > estimate** 다 (인자 순서가 아니라 이 순서다).
   * 어느 출처를 썼는지 반드시 기록한다 — 섞인 것을 하나로 뭉치면 누적 표시가 거짓이 된다.
   */
  charge(
    label: string,
    actualUsd: number | undefined,
    estimateUsd: number,
    meteredUsd: number | undefined,
    plan: BillingPlan,
  ): Charge {
    const charge: Charge =
      actualUsd !== undefined
        ? { label, usd: actualUsd, source: 'actual', plan }
        : meteredUsd !== undefined
          ? { label, usd: meteredUsd, source: 'metered', plan }
          : { label, usd: estimateUsd, source: 'estimate', plan };
    this.charges.push(charge);
    return charge;
  }

  get remainingUsd(): number {
    return Number((this.limitUsd - this.billedUsd).toFixed(6));
  }

  /** **청구되는 금액** 기준이다. 구독제만 쓰면 이 상한은 걸리지 않는다 — 그쪽은 토큰 예산이 막는다. */
  exceeded(): boolean {
    return this.billedUsd >= this.limitUsd;
  }

  /**
   * 다음 사이클을 **시작하기 전에** 부른다. 이미 쓴 것은 되돌릴 수 없으므로 사전 점검이다.
   * 두 상한 중 **하나라도** 넘으면 멈춘다 — 구독제에서는 토큰 쪽만 살아 있다.
   */
  assertCanContinue(): void {
    if (this.exceeded()) throw new BudgetExceeded(this.billedUsd, this.limitUsd);
    if (this.tokensExceeded()) throw new TokenBudgetExceeded(this.tokens, this.limitTokens);
  }

  /** 추정치가 섞였는지 — UI 는 이 값을 숨기지 않는다. */
  get hasEstimates(): boolean {
    return this.charges.some((c) => c.source === 'estimate');
  }

  /** 섞인 출처를 **actual > metered > estimate** 순으로. 하나뿐이면 길이 1 이다. */
  get sources(): readonly CostSource[] {
    const order: CostSource[] = ['actual', 'metered', 'estimate'];
    return order.filter((s) => this.charges.some((c) => c.source === s));
  }

  /** 청구되는 슬롯이 하나도 없는가 — 전부 구독제면 금액은 **환산액일 뿐이다**. */
  get allConverted(): boolean {
    return this.charges.length > 0 && this.charges.every((c) => c.plan === 'subscription');
  }

  summary(): string {
    const LABEL: Record<CostSource, string> = { actual: '실측', metered: '토큰×선언단가', estimate: '추정' };
    const kinds = this.sources;
    // 출처가 하나뿐이면 굳이 적지 않는다. 섞였을 때 **무엇이 섞였는지**가 중요하다.
    const mixed = kinds.length > 1 ? ` (${kinds.map((k) => LABEL[k]).join('+')})` : this.hasEstimates ? ' (추정 포함)' : '';
    // 구독제 금액에 "/ $20" 을 붙이면 그 상한이 이 숫자를 막는다는 거짓말이 된다.
    const tokens = this.limitTokens > 0 ? ` · 토큰 ${this.tokens}/${this.limitTokens}` : ` · 토큰 ${this.tokens}`;
    const blind = this.unreported > 0 ? ` (토큰 미보고 ${this.unreported}회 — 상한이 그만큼 못 본다)` : '';
    if (this.allConverted)
      return `$${this.spentUsd.toFixed(4)} API 환산${mixed} · 구독제라 청구되지 않는다${tokens}${blind}`;
    const converted = this.convertedUsd > 0 ? ` + $${this.convertedUsd.toFixed(4)} API 환산` : '';
    return `$${this.billedUsd.toFixed(4)} / $${this.limitUsd}${converted}${mixed}${tokens}${blind}`;
  }
}
