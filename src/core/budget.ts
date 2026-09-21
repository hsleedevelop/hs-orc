/**
 * 누적 비용 추적과 상한 (D-017).
 *
 * 비용에는 세 출처가 있고 **섞어 표시하지 않는다** (SPEC §2.5 근거 등급과 같은 이유):
 *  - `actual`   — 엔진이 돌려준 값. 지금은 claude 만 `total_cost_usd` 를 준다.
 *  - `metered`  — 엔진이 보고한 **측정 토큰** × `data/pricing.json` 의 **선언 단가** (D-027).
 *                 벤더가 청구한 금액이 아니다. 단가 선언이 없으면 이 출처는 안 생긴다.
 *  - `estimate` — 매트릭스의 AA 벤치마크 작업당 비용. 위 둘이 없을 때의 마지막 수단이다.
 */
export type CostSource = 'actual' | 'metered' | 'estimate';

export interface Charge {
  readonly label: string;
  readonly usd: number;
  readonly source: CostSource;
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

  constructor(limitUsd: number) {
    this.limitUsd = limitUsd;
  }

  get spentUsd(): number {
    return Number(this.charges.reduce((sum, c) => sum + c.usd, 0).toFixed(6));
  }

  /**
   * 우선순위는 **actual > metered > estimate** 다 (인자 순서가 아니라 이 순서다).
   * 어느 출처를 썼는지 반드시 기록한다 — 섞인 것을 하나로 뭉치면 누적 표시가 거짓이 된다.
   */
  charge(label: string, actualUsd: number | undefined, estimateUsd: number, meteredUsd?: number): Charge {
    const charge: Charge =
      actualUsd !== undefined
        ? { label, usd: actualUsd, source: 'actual' }
        : meteredUsd !== undefined
          ? { label, usd: meteredUsd, source: 'metered' }
          : { label, usd: estimateUsd, source: 'estimate' };
    this.charges.push(charge);
    return charge;
  }

  get remainingUsd(): number {
    return Number((this.limitUsd - this.spentUsd).toFixed(6));
  }

  exceeded(): boolean {
    return this.spentUsd >= this.limitUsd;
  }

  /** 다음 사이클을 **시작하기 전에** 부른다. 이미 쓴 돈은 되돌릴 수 없으므로 사전 점검이다. */
  assertCanContinue(): void {
    if (this.exceeded()) throw new BudgetExceeded(this.spentUsd, this.limitUsd);
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

  summary(): string {
    const LABEL: Record<CostSource, string> = { actual: '실측', metered: '토큰×선언단가', estimate: '추정' };
    const kinds = this.sources;
    // 출처가 하나뿐이면 굳이 적지 않는다. 섞였을 때 **무엇이 섞였는지**가 중요하다.
    const mixed = kinds.length > 1 ? ` (${kinds.map((k) => LABEL[k]).join('+')})` : this.hasEstimates ? ' (추정 포함)' : '';
    return `$${this.spentUsd.toFixed(4)} / $${this.limitUsd}${mixed}`;
  }
}
