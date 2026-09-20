/**
 * 사이클 기록 (PLAN S4 공통 인프라, SPEC §6 말미).
 * 세 방식 모두 사이클/턴/노드마다 **근거·변경·검증 결과**를 남긴다.
 */
import type { Charge } from './budget.ts';

export type CycleOutcome = 'ok' | 'failed' | 'stopped' | 'skipped';

export interface CycleRecord {
  readonly index: number;
  /** pingpong=턴, loop=반복, graph=노드 */
  readonly unit: string;
  readonly model: string;
  readonly effort: string;
  readonly outcome: CycleOutcome;
  /** 무엇을 근거로 했는가 */
  readonly evidence: string;
  /** 무엇이 바뀌었는가 */
  readonly change: string;
  /** 어떻게 검증했는가 — 비어 있으면 "검증 안 함"이지 "통과"가 아니다 */
  readonly verification: string;
  readonly charge?: Charge;
}

export class Journal {
  readonly records: CycleRecord[] = [];

  append(record: CycleRecord): CycleRecord {
    this.records.push(record);
    return record;
  }

  get unverified(): readonly CycleRecord[] {
    return this.records.filter((r) => r.outcome === 'ok' && r.verification.trim() === '');
  }

  render(): string {
    return this.records
      .map((r) => {
        const cost = r.charge ? ` · $${r.charge.usd.toFixed(4)}[${r.charge.source}]` : '';
        return `#${r.index} ${r.unit} ${r.model}·${r.effort} → ${r.outcome}${cost}\n` +
          `   근거 ${r.evidence || '—'}\n   변경 ${r.change || '—'}\n   검증 ${r.verification || '(없음)'}`;
      })
      .join('\n');
  }
}
