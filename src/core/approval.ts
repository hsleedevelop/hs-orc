/**
 * 승인 방식 판정 (D-064). **결정론이다** — 기록·배정·Budget 으로 계산하고 모델에게 묻지 않는다 (G1).
 * 판정은 Core 한 곳에만 두고 셸은 표시만 한다 (D-001·D-056).
 *
 * H — 어느 방식에서도 묻는다(`manual` 은 전부 묻는다). A — `auto-ask` 만 더 묻는다. `auto` 는 H 만 묻는다.
 * **예외: 사다리 상향 배정(D-068)의 A3 는 `auto` 에서도 묻는다** — 같은 요청을 더 무겁게 다시 돌리는 재위임이다.
 * 예상 비용(AA)은 모델 단위라 ③모델·④reviewer 에서만 바뀌고 ②effort 상향은 반영되지 않는다 — 문구가 그렇게 말하지 않는다.
 * 상한 도달은 여기서 묻는 것이 아니라 막는 것이다 (D-030) — 승인 뒤 `approve()` 가 시작하지 않는다.
 */
import type { Engines } from '../data/engines.ts';
import type { ApprovalMode } from '../data/limits.ts';
import type { AssignmentPlan } from './assign.ts';
import type { Budget } from './budget.ts';
import type { TranscriptRecord } from './transcript.ts';

/** A1 기준 (D-064 U3): 오늘 매트릭스에서 Fable+Astra 조합(R05·R08~R11, $10.89)만 넘는다. AA 추정 상수라 "무거운 조합인가" 의 대리 지표다. */
export const A1_COST_USD = 10;
/** A2 금액 (D-064 U4): 청구되는(api) 슬롯이 있고 남은 금액이 예상의 이 배수 미만이다. */
export const A2_REMAINING_FACTOR = 2;
/** A2 토큰 (D-064 U4): 남은 토큰이 `tokenBudget` 의 이 비율 미만이다. 배정별 예상 토큰이 없어 비율로 둔다. */
export const A2_TOKEN_REMAINING_RATIO = 0.2;

export type AskCode = 'H1' | 'H2' | 'H3' | 'H4' | 'A1' | 'A2' | 'A3' | 'A4';

/** 묻는 이유 하나. `text` 는 카드에 이름으로 보인다 — 이유 없이 선 카드는 무엇을 봐야 할지 모른다. */
export interface AskReason {
  readonly code: AskCode;
  readonly text: string;
}

export interface ApprovalCheck {
  /** 기록에 남기는 방식과 걸린 조건. `manual` 은 조건과 무관하게 묻고 `asks` 는 비어 있다. */
  readonly mode: ApprovalMode;
  readonly asks: readonly AskReason[];
  /** 승인 클릭 없이 시작한다 — `manual` 이 아니고 걸린 조건이 없다. */
  readonly auto: boolean;
}

/**
 * H1 — 행을 모델이 골랐다. 확신 있는 Jev 행(`Jev Rxx …`, D-065 결정 10)·규칙 분류(`키워드 …`)·사용자의 행 지정(`수동 지정 …`)은
 * 아니다. **그 밖은 전부 모델 선택으로 본다** — 지휘자 제안·Haiku 분류, 그리고 모르는 출처(안전한 쪽으로 묻는다).
 */
export const isModelPick = (reason: string): boolean => !/^(키워드 |Jev |수동 지정 |사다리 )/.test(reason);

/**
 * H4 — 쓰기 위임인데 폴더가 git 이 아니고, primary 엔진이 git 밖에서 거절하는 엔진이다(D-074 A2). `nonGitArgv` 선언이 곧
 * "git 밖에서는 이 인자가 있어야 돈다" 는 뜻이고, 쓰기에는 그 인자를 붙이지 않는다(D-055 결정 2) — 승인 뒤 모델 호출 전에 거절된다.
 * 승인은 막지 않는다: 거절은 과금이 없고, 사람이 행·쓰기를 바꾸거나 그대로 확인할 수 있다.
 */
export function nonGitWriteRefusal(catalog: Engines, plan: AssignmentPlan, write: boolean, inGit: boolean): AskReason | null {
  const engine = plan.slots.primary.engine;
  if (!write || inGit || catalog.engines[engine].nonGitArgv === undefined) return null;
  return { code: 'H4', text: `git 아닌 폴더 · ${engine} 쓰기 → ${engine} 가 거절한다 (D-055). git init 하거나 쓰기를 끄라` };
}

const isFailure = (r: TranscriptRecord): boolean =>
  r.kind === 'result' && (r.outcome === 'wrong' || r.outcome === 'rework' || r.verdict === 'fail');

export interface ApprovalInput {
  readonly mode: ApprovalMode;
  readonly plan: AssignmentPlan;
  readonly reason: string;
  /** 사용자가 이 메시지를 쓰기 위임으로 보냈다 (`send({ write })`). 승인 클릭 때 켜는 쓰기는 이미 사람이 본 것이다. */
  readonly write: boolean;
  readonly catalog: Engines;
  readonly budget: Budget;
  /** 이 세션의 기록 — 배정을 세우기 **전** 상태다(직전 위임·첫 위임 판정). */
  readonly records: readonly TranscriptRecord[];
  /** 사용자가 누른 사다리 상향 배정이다 (D-068). 행은 이미 승인해 돌린 행이라 H1 이 아니지만, 방식과 무관하게 A3 로 묻는다. */
  readonly ladder?: boolean;
  /** 폴더가 git 작업 트리인가 (D-074). 없으면 git 으로 본다 — 모르는 것을 거절로 예고하지 않는다. */
  readonly inGit?: boolean;
}

export function evaluateApproval(input: ApprovalInput): ApprovalCheck {
  const { mode, plan, reason, write, catalog, budget, records, ladder = false, inGit = true } = input;
  if (mode === 'manual') return { mode, asks: [], auto: false };
  const asks: AskReason[] = [];
  const primary = plan.slots.primary;

  if (isModelPick(reason)) asks.push({ code: 'H1', text: `모델이 고른 행 (${reason})` });
  if (write) asks.push({ code: 'H2', text: '쓰기를 켠 위임' });
  const refusal = nonGitWriteRefusal(catalog, plan, write, inGit);
  if (refusal) asks.push(refusal);
  if (catalog.engines[primary.engine].readOnlyArgv === undefined) {
    asks.push({ code: 'H3', text: `${primary.engine} 는 읽기 전용이 인자로 보장되지 않는다` });
  }

  // 사다리 상향 (D-068) — `auto` 에서도 묻는다. 버튼은 "이 단계를 보겠다", 카드 승인은 "이 비용으로 돌려라" 다 (D-033).
  if (ladder) asks.push({ code: 'A3', text: '사다리 상향 배정 — 같은 요청을 올려 다시 위임한다 (예상 비용은 모델이 바뀔 때만 바뀐다 — effort 상향은 반영되지 않는다)' });

  if (mode === 'auto-ask') {
    const usd = plan.cost.totalUsd;
    if (usd >= A1_COST_USD) asks.push({ code: 'A1', text: `예상 $${usd} ≥ $${A1_COST_USD}` });

    const billed = [plan.slots.primary, plan.slots.reviewer, plan.slots.secondReviewer].some((s) => s?.plan === 'api');
    const tokenLimit = budget.limitTokens;
    if (billed && budget.remainingUsd < A2_REMAINING_FACTOR * usd) {
      asks.push({ code: 'A2', text: `남은 금액 $${budget.remainingUsd} < 예상 $${usd} × ${A2_REMAINING_FACTOR}` });
    } else if (tokenLimit > 0 && tokenLimit - budget.spentTokens < tokenLimit * A2_TOKEN_REMAINING_RATIO) {
      asks.push({ code: 'A2', text: `남은 토큰 ${tokenLimit - budget.spentTokens} < 상한의 ${A2_TOKEN_REMAINING_RATIO * 100}%` });
    }

    // A3 — 직전 위임이 실패했는데 같은 행이거나, 행 기본보다 높은 effort. 취소는 실패가 아니다 (D-066). `unverified` 는 넣지 않는다 (SPEC §8).
    // 사다리 배정은 위의 A3 한 줄이 이 둘을 덮는다 — 이유를 겹쳐 적지 않는다.
    if (!ladder) {
      const lastResult = records.findLastIndex((r) => r.kind === 'result');
      const failed = lastResult >= 0 && isFailure(records[lastResult] as TranscriptRecord);
      const before = lastResult >= 0 ? records.slice(0, lastResult).findLast((r) => r.kind === 'plan') : undefined;
      if (failed && before?.kind === 'plan' && before.taskId === plan.assignment.id) {
        asks.push({ code: 'A3', text: `직전 위임이 실패했는데 같은 행 ${plan.assignment.id}` });
      }
      const base = plan.assignment;
      const raised = (slot: 'primary' | 'reviewer'): boolean => plan.slots[slot].effort !== base[slot].efforts[0];
      if (raised('primary') || raised('reviewer')) asks.push({ code: 'A3', text: '행 기본보다 높은 effort' });
    }

    // A4 — 이 세션에서 승인된 위임이 아직 없다. 폴더 단위는 세션 목록을 훑어야 해 넣지 않는다.
    if (!records.some((r) => r.kind === 'approval' && r.approved)) asks.push({ code: 'A4', text: '이 세션의 첫 위임' });
  }
  return { mode, asks, auto: asks.length === 0 };
}
