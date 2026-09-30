/**
 * 상향 사다리 (SPEC §2.4).
 *
 * 상향 순서: **① 코드·로그·재현 조건 보강 → ② effort 상향 → ③ 모델 상향 → ④ reviewer 추가.**
 * 이 순서를 건너뛰고 L5로 점프하는 경로를 만들지 않는다.
 */
import { createAdapter } from '../adapters/engine.ts';
import type { Engines } from '../data/engines.ts';
import { EFFORTS, type Assignment, type Effort, type LadderStep, type Matrix, type ModelKey, type Vendor } from '../data/matrix.ts';
import { assign, type AssignmentPlan } from './assign.ts';

export const ESCALATION_ORDER = ['evidence', 'effort', 'model', 'reviewer'] as const;
export type EscalationStage = (typeof ESCALATION_ORDER)[number];

export const STAGE_LABEL: Readonly<Record<EscalationStage, string>> = {
  evidence: '코드·로그·재현 조건 보강',
  effort: 'effort 상향',
  model: '모델 상향',
  reviewer: 'reviewer 추가',
};

const STAGE_NO: Readonly<Record<EscalationStage, string>> = { evidence: '①', effort: '②', model: '③', reviewer: '④' };

/** 카드·결정 로그에 찍는 단계 이름 — `②effort 상향`. 매트릭스 `ladder` 의 L1~L5(모델 쌍 표)와 섞이지 않게 번호로 쓴다 (D-068). */
export const stageName = (stage: EscalationStage): string => `${STAGE_NO[stage]}${STAGE_LABEL[stage]}`;

export class LadderError extends Error {
  override name = 'LadderError';
}

/** 이미 마친 단계들. 다음에 허용되는 단계는 정확히 하나다. */
export function nextStage(done: readonly EscalationStage[]): EscalationStage | null {
  return ESCALATION_ORDER.find((stage) => !done.includes(stage)) ?? null;
}

/** 순서를 건너뛰면 던진다 — "일단 Fable로 올려보자"가 이 함수를 통과하면 안 된다. */
export function requestStage(done: readonly EscalationStage[], requested: EscalationStage): EscalationStage[] {
  const expected = nextStage(done);
  if (expected === null) throw new LadderError('더 올릴 단계가 없다. 여기서도 안 되면 문제 정의를 다시 본다.');
  if (requested !== expected) {
    throw new LadderError(
      `상향 순서를 건너뛸 수 없다. 다음은 "${STAGE_LABEL[expected]}"(${expected})인데 "${requested}"를 요청했다.`,
    );
  }
  return [...done, requested];
}

export function ladderLevels(matrix: Matrix): readonly string[] {
  return matrix.ladder.map((s) => s.level);
}

/** 사다리 레벨 이동. 인접한 다음 칸으로만 간다 — L1→L5 직행 경로는 없다. */
export function climb(matrix: Matrix, from: string): LadderStep {
  const levels = matrix.ladder;
  const index = levels.findIndex((s) => s.level === from);
  if (index === -1) throw new LadderError(`그런 사다리 레벨이 없다: ${from} (${ladderLevels(matrix).join(' → ')})`);
  const next = levels[index + 1];
  if (!next) throw new LadderError(`${from} 이 최상단이다. 더 올라갈 칸이 없다.`);
  return next;
}

export function jumpTo(matrix: Matrix, from: string, to: string): LadderStep {
  const next = climb(matrix, from);
  if (next.level !== to) {
    throw new LadderError(`${from} → ${to} 직행 경로는 없다. 다음 칸은 ${next.level} 이다 (한 칸씩 올라간다).`);
  }
  return next;
}

/** 배정에 적용된 사다리 (D-068). `plan` 기록에 그대로 남는다 — 사다리 상태는 기록에서 계산한다. */
export interface LadderApplied {
  readonly stage: EscalationStage;
  readonly label: string;
  /** 지금 단계까지 지나온 단계(올릴 곳이 없어 건너뛴 것 포함). 다음 상향은 이것 뒤에서 시작한다. */
  readonly done: readonly EscalationStage[];
  /** 행 기본 대비 무엇이 올랐나 — 단계마다 한 줄, 건너뛴 단계는 이유와 함께. 카드가 그대로 보인다. */
  readonly changes: readonly string[];
}

export interface LadderPlan {
  readonly plan: AssignmentPlan;
  readonly applied: LadderApplied;
}

interface Rung {
  readonly model: ModelKey;
  readonly effort: Effort;
}
interface Rungs {
  readonly primary: Rung;
  readonly reviewer: Rung;
}
type StageResult = { readonly rungs: Rungs; readonly change: string; readonly applied: boolean };

const modelLabel = (model: ModelKey): string => model.charAt(0).toUpperCase() + model.slice(1);

const vendorOf = (matrix: Matrix, model: ModelKey): Vendor => {
  const found = (Object.keys(matrix.tiers) as Vendor[]).find((v) => matrix.tiers[v].includes(model));
  if (!found) throw new LadderError(`모델 계층에 없는 모델: ${model}`);
  return found;
};

/** 자기 벤더 계층에서 한 칸 위. 최상위면 null — 벤더를 넘지 않는다(INV-1 이 유지된다). */
const modelAbove = (matrix: Matrix, model: ModelKey): ModelKey | null => {
  const tier = matrix.tiers[vendorOf(matrix, model)];
  return tier[tier.indexOf(model) + 1] ?? null;
};

/** `resolveSlot` 과 같은 판정이다 — 지원하지 않는 조합은 만들지 않는다 (대체 모델로 바꾸지 않는다, D-004). */
const supported = (catalog: Engines, model: ModelKey, effort: Effort): boolean =>
  createAdapter(catalog.models[model].defaultEngine, catalog).supports(model, effort);

function applyStage(matrix: Matrix, catalog: Engines, rungs: Rungs, stage: EscalationStage): StageResult {
  const name = stageName(stage);
  const skip = (why: string): StageResult => ({ rungs, change: `${name} — 건너뜀: ${why}`, applied: false });
  const { primary, reviewer } = rungs;
  switch (stage) {
    case 'evidence':
      return { rungs, change: `${name} — 직전 실패의 reviewer 검증·증거를 프롬프트에 싣는다 (모델·effort 그대로)`, applied: true };
    case 'effort': {
      const next = EFFORTS.slice(EFFORTS.indexOf(primary.effort) + 1).find((e) => supported(catalog, primary.model, e));
      if (!next) return skip(`primary ${modelLabel(primary.model)} ${primary.effort} 는 더 올릴 effort 가 없다`);
      return { rungs: { ...rungs, primary: { ...primary, effort: next } }, change: `${name} — primary ${modelLabel(primary.model)} ${primary.effort} → ${next}`, applied: true };
    }
    case 'model': {
      const next = modelAbove(matrix, primary.model);
      if (!next) return skip(`primary ${modelLabel(primary.model)} 는 ${vendorOf(matrix, primary.model)} 계층의 최상위다`);
      if (!supported(catalog, next, primary.effort)) return skip(`${modelLabel(next)} 는 ${primary.effort} 를 지원하지 않는다`);
      return { rungs: { ...rungs, primary: { ...primary, model: next } }, change: `${name} — primary ${modelLabel(primary.model)} → ${modelLabel(next)} (${primary.effort})`, applied: true };
    }
    case 'reviewer': {
      const next = modelAbove(matrix, reviewer.model);
      if (!next) return skip(`reviewer ${modelLabel(reviewer.model)} 는 ${vendorOf(matrix, reviewer.model)} 계층의 최상위다`);
      if (!supported(catalog, next, reviewer.effort)) return skip(`${modelLabel(next)} 는 ${reviewer.effort} 를 지원하지 않는다`);
      // 제품이 primary+reviewer 두 슬롯 고정이라 슬롯을 더하지 않고 기존 reviewer 를 올린다 (D-068 결정 2).
      return { rungs: { ...rungs, reviewer: { ...reviewer, model: next } }, change: `${name} — reviewer ${modelLabel(reviewer.model)} → ${modelLabel(next)} (${reviewer.effort}, 교차 벤더 유지 · 슬롯을 더하지 않고 기존 reviewer 를 올린다)`, applied: true };
    }
  }
}

/**
 * `done` 뒤의 다음 단계를 행 기본 배정(`base`)에 적용한다 (D-068). **결정론이고 엔진을 부르지 않는다.**
 * 올릴 곳이 없는 단계는 건너뛰고(순서를 바꾸지 않는다) 그 다음 단계를 적용한다. 남은 단계가 모두 올릴 곳이 없으면 null.
 * 배정은 `assign()` 을 거친다 — INV-1 검사와 비용 재산정이 그대로 걸린다. 모델·reviewer 는 자기 벤더 안에서 한 칸만 오른다.
 */
export function planLadder(matrix: Matrix, catalog: Engines, base: Assignment, done: readonly EscalationStage[]): LadderPlan | null {
  const changes: string[] = [];
  let rungs: Rungs = {
    primary: { model: base.primary.model, effort: base.primary.efforts[0] as Effort },
    reviewer: { model: base.reviewer.model, effort: base.reviewer.efforts[0] as Effort },
  };
  for (const stage of done) {
    const r = applyStage(matrix, catalog, rungs, stage);
    rungs = r.rungs;
    changes.push(r.change);
  }
  let passed = [...done];
  for (let stage = nextStage(passed); stage !== null; stage = nextStage(passed)) {
    const r = applyStage(matrix, catalog, rungs, stage);
    passed = [...passed, stage];
    changes.push(r.change);
    if (!r.applied) continue;
    const slot = (old: Assignment['primary'], rung: Rung) => ({ ...old, model: rung.model, vendor: vendorOf(matrix, rung.model), label: modelLabel(rung.model) });
    const raised: Assignment = { ...base, primary: slot(base.primary, r.rungs.primary), reviewer: slot(base.reviewer, r.rungs.reviewer) };
    const plan = assign(matrix, catalog, raised, { primaryEffort: r.rungs.primary.effort, reviewerEffort: r.rungs.reviewer.effort });
    return { plan, applied: { stage, label: stageName(stage), done: passed, changes } };
  }
  return null;
}
