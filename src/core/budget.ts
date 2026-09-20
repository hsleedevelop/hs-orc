/**
 * 누적 비용 추적과 상한 (D-017).
 *
 * 비용에는 두 출처가 있고 **섞어 표시하지 않는다** (SPEC §2.5 근거 등급과 같은 이유):
 *  - `actual`   — 엔진이 돌려준 값. 지금은 claude 만 `total_cost_usd` 를 준다.
 *  - `estimate` — 매트릭스의 AA 벤치마크 작업당 비용. codex·cursor 는 이쪽뿐이다.
 */
export type CostSource = 'actual' | 'estimate';

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

  /** 실측값이 있으면 그것을, 없으면 추정치를 쓴다. 어느 쪽인지 반드시 기록한다. */
  charge(label: string, actualUsd: number | undefined, estimateUsd: number): Charge {
    const charge: Charge =
      actualUsd !== undefined
        ? { label, usd: actualUsd, source: 'actual' }
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

  summary(): string {
    const mixed = this.hasEstimates ? ' (추정 포함)' : '';
    return `$${this.spentUsd.toFixed(4)} / $${this.limitUsd}${mixed}`;
  }
}
