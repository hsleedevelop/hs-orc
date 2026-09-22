/**
 * Assigner — 두 슬롯 배정 (SPEC §4-3, D-009).
 *
 * `INV-1: vendor(primary) ≠ vendor(reviewer)` 를 **타입 수준에서** 강제한다.
 * `CrossVendorPair` 는 이 파일의 검사된 팩토리로만 만들어지므로, 구조가 맞아도
 * 검사를 거치지 않은 객체는 배정으로 통하지 않는다.
 */
import type { Assignment, Economics, Effort, Matrix, ModelKey, Slot } from '../data/matrix.ts';
import type { BillingPlan, EngineName, Engines } from '../data/engines.ts';
import { createAdapter } from '../adapters/engine.ts';

declare const crossVendorBrand: unique symbol;

export type SlotRole = 'primary' | 'reviewer';

export interface ResolvedSlot {
  readonly model: ModelKey;
  readonly label: string;
  readonly effort: Effort;
  readonly engine: EngineName;
  readonly modelId: string;
  /** 쓰기 권한 판정의 근거다 (D-025). reviewer 는 이 값 때문에 절대 쓰기를 못 받는다. */
  readonly role: SlotRole;
  /** 이 슬롯의 비용이 **청구되는가** (D-030). 슬롯이 들고 다녀야 Budget 이 카탈로그를 몰라도 된다. */
  readonly plan: BillingPlan;
}

export interface CrossVendorPair {
  readonly primary: ResolvedSlot;
  readonly reviewer: ResolvedSlot;
  readonly [crossVendorBrand]: true;
}

export class AssignError extends Error {
  override name = 'AssignError';
}

/** 비용은 **벤치마크 측정치이며 실제 지출이 아니다** (SPEC §2.3·§2.5). 등급을 값과 함께 운반한다. */
export interface CostEstimate {
  readonly primaryUsd: number;
  readonly reviewerUsd: number;
  readonly totalUsd: number;
  readonly grade: 'independent';
  readonly note: string;
}

export interface AssignmentPlan {
  readonly assignment: Assignment;
  readonly slots: CrossVendorPair;
  readonly cost: CostEstimate;
}

function resolveSlot(catalog: Engines, slot: Slot, effort: Effort, role: SlotRole): ResolvedSlot {
  const engine = catalog.models[slot.model].defaultEngine;
  // supports() 가 유일한 가용성 판정이다 — 여기서 대체 모델을 고르지 않는다 (D-004).
  if (!createAdapter(engine, catalog).supports(slot.model, effort)) {
    throw new AssignError(`${engine} 는 ${slot.model}/${effort} 를 지원하지 않는다. 대체 모델로 바꾸지 않는다.`);
  }
  const modelId = catalog.models[slot.model].availability[engine]?.id;
  if (!modelId) throw new AssignError(`${engine}/${slot.model} 의 모델 id 가 비어 있다 — engines.json 이 깨졌다.`);
  return { model: slot.model, label: slot.label, effort, engine, modelId, role, plan: catalog.engines[engine].plan };
}

/** INV-1 을 통과한 쌍만 반환한다. 위반이면 던진다 — 조용히 한쪽을 바꾸지 않는다. */
export function crossVendorPair(matrix: Matrix, primary: ResolvedSlot, reviewer: ResolvedSlot): CrossVendorPair {
  const vendorOf = (model: ModelKey): string => {
    for (const [vendor, models] of Object.entries(matrix.tiers)) if (models.includes(model)) return vendor;
    throw new AssignError(`모델 계층에 없는 모델: ${model}`);
  };
  if (vendorOf(primary.model) === vendorOf(reviewer.model)) {
    throw new AssignError(
      `INV-1 위반: primary(${primary.model})와 reviewer(${reviewer.model})의 벤더가 같다. 독립 검증이 성립하지 않는다.`,
    );
  }
  return { primary, reviewer } as CrossVendorPair;
}

const costOf = (economics: readonly Economics[], model: ModelKey): number => {
  const row = economics.find((e) => e.model === model);
  if (!row) throw new AssignError(`비용 표에 없는 모델: ${model}`);
  return row.taskCostUsd;
};

export interface AssignOptions {
  readonly primaryEffort?: Effort;
  readonly reviewerEffort?: Effort;
}

export function assign(
  matrix: Matrix,
  catalog: Engines,
  assignment: Assignment,
  options: AssignOptions = {},
): AssignmentPlan {
  const pick = (slot: Slot, override?: Effort): Effort => {
    const effort = override ?? slot.efforts[0];
    if (effort === undefined) throw new AssignError(`${assignment.id} 의 ${slot.label} effort 가 비어 있다.`);
    return effort;
  };

  const primary = resolveSlot(catalog, assignment.primary, pick(assignment.primary, options.primaryEffort), 'primary');
  const reviewer = resolveSlot(catalog, assignment.reviewer, pick(assignment.reviewer, options.reviewerEffort), 'reviewer');
  const slots = crossVendorPair(matrix, primary, reviewer);

  const primaryUsd = costOf(matrix.economics, primary.model);
  const reviewerUsd = costOf(matrix.economics, reviewer.model);

  return {
    assignment,
    slots,
    cost: {
      primaryUsd,
      reviewerUsd,
      totalUsd: Number((primaryUsd + reviewerUsd).toFixed(4)),
      grade: 'independent',
      note: 'Artificial Analysis max-effort 벤치마크 작업당 비용. 실제 지출이 아니다.',
    },
  };
}
