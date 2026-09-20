/**
 * 두 슬롯 실행 (D-009, PRD G3).
 *
 * 매트릭스 11행은 전부 `primary + independent reviewer` 쌍이다. 배정만 두 슬롯으로 하고
 * 실행은 primary 만 하면 **이 제품은 단일 엔진 선택기로 축소된다** — S3 가 최대 위험으로
 * 적어 둔 바로 그것이다. 여기가 기본 경로에서 두 슬롯을 실현하는 자리다.
 *
 * reviewer 는 **독립 검증자**다: 같은 작업을 다시 하는 것이 아니라 primary 산출물의
 * 누락·반례·리스크를 찾고 `운영 기준` 충족 여부를 판정한다.
 */
import type { Matrix } from '../data/matrix.ts';
import type { AssignmentPlan } from './assign.ts';
import { estimateUsd, type SlotExecutor, type SlotRun } from './executor.ts';
import type { Budget } from './budget.ts';
import type { Evidence } from './evidence.ts';

export type Verdict = 'pass' | 'fail' | 'unknown';

export interface DuoResult {
  readonly primary: SlotRun;
  /** reviewer 를 끄면 `null`. 끈 것과 실패한 것을 구분한다. */
  readonly review: SlotRun | null;
  readonly verdict: Verdict;
  /** 증거 수집기에 그대로 넣는다 — R11 의 `독립 리뷰 결과`가 이걸로 채워진다 (SPEC §5). */
  readonly evidence: readonly Evidence[];
}

/**
 * reviewer 프롬프트. **산출물을 다시 만들라고 하지 않는다** — 반례를 먼저 내라고 한다.
 * 매트릭스의 `운영 기준`과 행별 지침을 그대로 판정 기준으로 준다 (D-010).
 */
export function reviewPrompt(plan: AssignmentPlan, task: string, output: string): string {
  return [
    '너는 독립 검증자다. 이 작업을 다시 수행하지 말고 아래 산출물을 검증하라.',
    '',
    `작업: ${task}`,
    `운영 기준(완료의 정의): ${plan.assignment.operatingCriterion}`,
    `검토 지침: ${plan.assignment.detail}`,
    '',
    '--- primary 산출물 ---',
    output.slice(0, 8000),
    '--- 끝 ---',
    '',
    '다음 순서로 답하라:',
    '1. 누락된 것 / 반례 / 실패 가능성을 먼저 적는다 (없으면 "없음").',
    '2. 마지막 줄에 운영 기준 충족 여부를 PASS 또는 FAIL 한 단어로만 적는다.',
    '"성공했습니다" 같은 산문은 판정이 아니다.',
  ].join('\n');
}

/** 마지막 줄의 PASS/FAIL 만 본다. 못 읽으면 `unknown` 이다 — pass 로 봐주지 않는다. */
export function parseVerdict(text: string): Verdict {
  const lines = text.trim().split('\n');
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 3; i -= 1) {
    const line = (lines[i] ?? '').trim().toUpperCase();
    if (/\bPASS\b/.test(line) && !/\bFAIL\b/.test(line)) return 'pass';
    if (/\bFAIL\b/.test(line)) return 'fail';
  }
  return 'unknown';
}

export interface DuoOptions {
  /** reviewer 를 끈다. 기본은 **켜짐** — 비용은 승인 게이트에서 이미 두 슬롯으로 보여줬다. */
  readonly skipReviewer?: boolean;
}

export async function runDuo(
  matrix: Matrix,
  plan: AssignmentPlan,
  execute: SlotExecutor,
  task: string,
  budget: Budget,
  options: DuoOptions = {},
): Promise<DuoResult> {
  const { primary: primarySlot, reviewer: reviewerSlot } = plan.slots;

  const primary = await execute(primarySlot, task);
  budget.charge(`${primarySlot.label}·${primarySlot.effort}`, primary.actualUsd, estimateUsd(matrix, primarySlot));

  if (options.skipReviewer === true || !primary.ok) {
    // primary 가 실패했으면 검증할 산출물이 없다. reviewer 를 돌려 돈만 쓰지 않는다.
    return { primary, review: null, verdict: 'unknown', evidence: [] };
  }

  // 상한을 넘겼으면 reviewer 를 시작하지 않는다 — 쓴 돈은 못 되돌린다.
  if (budget.exceeded()) return { primary, review: null, verdict: 'unknown', evidence: [] };

  const review = await execute(reviewerSlot, reviewPrompt(plan, task, primary.text));
  budget.charge(`${reviewerSlot.label}·${reviewerSlot.effort}`, review.actualUsd, estimateUsd(matrix, reviewerSlot));

  const verdict = review.ok ? parseVerdict(review.text) : 'unknown';
  const evidence: Evidence[] =
    verdict === 'unknown'
      ? []
      : [
          {
            kind: 'review',
            reviewer: `${reviewerSlot.label}·${reviewerSlot.effort} (${reviewerSlot.engine}/${reviewerSlot.modelId})`,
            verdict,
            text: review.text.slice(0, 2000),
          },
        ];

  return { primary, review, verdict, evidence };
}
