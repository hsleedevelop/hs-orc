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
import type { BillingPlan } from '../data/engines.ts';
import { estimateUsd, type EngineReport, type SlotExecutor, type SlotRun, type SlotRunOptions } from './executor.ts';
import type { Budget, Charge } from './budget.ts';
import type { Evidence } from './evidence.ts';

export type Verdict = 'pass' | 'fail' | 'unknown';

export type CancelledAt = 'primary' | 'verify' | 'reviewer';

/** reviewer 한 명의 실행과 그 판정 (D-072). */
export interface ReviewRun {
  /** `Sonnet·high (claude/claude-sonnet-…)` — 증거의 `reviewer` 와 같은 모양이다. */
  readonly reviewer: string;
  readonly run: SlotRun;
  readonly verdict: Verdict;
}

export interface DuoResult {
  readonly primary: SlotRun;
  /**
   * primary 의 과금. `budget.charges.at(-1)` 은 reviewer 가 돌면 reviewer 것이다.
   * 취소돼 측정값이 없으면 Budget 에 넣지 않은 0 자리표시다 (D-066) — 추정치로 채우지 않는다.
   */
  readonly primaryCharge: Charge;
  /**
   * 사용자가 어느 단계에서 멈췄는가 (D-066). 끝까지 갔으면 null. primary 에서 멈추면 reviewer 는 시작하지 않는다.
   * `verify` — primary 뒤 검증 명령 중이다 (D-094). primary 는 끝났고 reviewer 는 시작하지 않았다.
   */
  readonly cancelledAt: CancelledAt | null;
  /** 첫 reviewer 실행. reviewer 를 끄면 `null`. 끈 것과 실패한 것을 구분한다. */
  readonly review: SlotRun | null;
  /** 끝까지 돈 reviewer 마다 한 줄, 돈 순서대로 (D-072). 사다리 ④ 배정이면 둘까지다. 취소된 실행은 넣지 않는다. */
  readonly reviews: readonly ReviewRun[];
  /** reviewer 가 둘이면 AND 다 — 하나라도 FAIL 이면 fail, 하나라도 못 읽었거나 돌지 못했으면 unknown (pass 로 봐주지 않는다). */
  readonly verdict: Verdict;
  /** 증거 수집기에 그대로 넣는다 — R11 의 `독립 리뷰 결과`가 이걸로 채워진다 (SPEC §5). */
  readonly evidence: readonly Evidence[];
}

/**
 * reviewer 프롬프트. **산출물을 다시 만들라고 하지 않는다** — 반례를 먼저 내라고 한다.
 * 매트릭스의 `운영 기준`과 행별 지침을 그대로 판정 기준으로 준다 (D-010).
 */
export function reviewPrompt(plan: AssignmentPlan, task: string, output: string, checks?: string, noTests?: string): string {
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
    // Core 가 실행한 검증 명령의 결과 (D-040). reviewer 는 읽기 전용이라 스스로 돌리지 못한다.
    // 실측 3회 모두 reviewer 가 같은 명령을 Bash 로 다시 돌리려다 권한 거절로 턴·토큰을 썼다 — 결과가 있으면 다시 돌리지 말라고 한다.
    // 결과가 없을 때(once)는 막지 않는다 — codex 읽기 전용 샌드박스는 명령을 돌려 스스로 검증할 수 있다.
    ...(checks
      ? [
          '--- 검증 명령 (Core 실행) ---',
          checks,
          '--- 끝 ---',
          '위 명령은 Core 가 이미 실행했다. 다시 실행하지 말고(권한이 없을 수 있다) 이 결과를 근거로 판정하라.',
          '',
        ]
      : []),
    // 대상에 기존 테스트가 없다고 Core 가 결정론으로 확인했다 (D-093). 못 하는 일을 기준으로 FAIL 하지 않게 하되,
    // primary 가 그 사실과 대체 검증을 밝혔을 때만이다. 테스트가 있으면 이 블록은 오지 않는다.
    ...(noTests
      ? [
          '--- Core 확인 사실 ---',
          `이 프로젝트에는 기존 테스트가 없다 (${noTests}). 운영 기준의 기존 test 실행은 처음부터 할 수 없다.`,
          'primary 가 테스트가 없다는 사실을 밝히고 대체 검증(lint·타입체크·빌드 등)과 그 결과를 보고했으면, test 를 실행하지 않은 것을 이유로 FAIL 하지 마라.',
          '밝히지 않았거나 대체 검증 보고가 없으면 그것은 누락이다. 다른 기준은 그대로 본다.',
          '',
        ]
      : []),
    '다음 순서로 답하라:',
    '1. 누락된 것 / 반례 / 실패 가능성을 먼저 적는다 (없으면 "없음").',
    '2. 마지막 줄에 운영 기준 충족 여부를 PASS 또는 FAIL 한 단어로만 적는다.',
    '"성공했습니다" 같은 산문은 판정이 아니다.',
  ].join('\n');
}

/**
 * Core 가 돌린 검증 명령을 reviewer 의 "검증 명령 (Core 실행)" 절 글로 (D-040). loop·once·세션이 같은 모양을 쓴다 —
 * 명령마다 `$ [phase:]명령` · `exit=N` · 출력 꼬리 1500자.
 */
export function checksText(commands: readonly Extract<Evidence, { kind: 'command' }>[]): string {
  return commands.map((c) => `$ ${c.phase ? `${c.phase}:${c.cmd}` : c.cmd}\nexit=${c.exitCode}\n${c.output.slice(-1500)}`).join('\n\n');
}

/** 기존 테스트가 없을 때 primary 프롬프트 끝에 붙이는 Core 확인 사실 (D-093) — 밝히지 않으면 reviewer 가 누락으로 본다. */
export function primaryNoTestsNote(noTests: string): string {
  return `[Core 확인] 이 프로젝트에는 기존 테스트가 없다 (${noTests}). 결과 보고에 테스트가 없다는 사실을 밝히고, 대신 돌린 검증(lint·타입체크·빌드 등)의 명령과 결과를 적어라.`;
}

/** 읽기 전용 위임이라 검증 명령을 돌리지 않았다는 증거 요약 줄 (D-094, D-040 결정 3) — 원본을 검사한 결과를 증거처럼 쓰지 않는다. */
export const readOnlyVerifyNote = (cmds: readonly string[]): string =>
  `읽기 전용 위임이라 검증 명령 ${cmds.length}개를 실행하지 않았다 — ${cmds.map((c) => `\`${c}\``).join(' · ')}`;

/** 증거 요약에 붙는 같은 사실 (D-093). */
export const noTestsEvidenceNote = (noTests: string): string => `대상에 기존 테스트 없음 — ${noTests}`;

/**
 * 여러 reviewer 판정을 AND 로 합친다 (D-072). FAIL 이 하나라도 있으면 fail, 배정된 reviewer 가 다 돌아 모두 PASS 일 때만 pass,
 * 그 밖(못 읽음·상한으로 시작 못 함)은 unknown 이다.
 */
export function combineVerdicts(verdicts: readonly Verdict[], expected: number): Verdict {
  if (verdicts.includes('fail')) return 'fail';
  return verdicts.length === expected && verdicts.every((v) => v === 'pass') ? 'pass' : 'unknown';
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
  /** primary 가 이어 붙일 엔진 세션 (SPEC §6.4.3). reviewer 에는 절대 가지 않는다. */
  readonly resumePrimary?: string;
  /** 이어 붙일 세션의 직전 원본 보고 (D-057). */
  readonly resumeBaseline?: EngineReport;
  /** 신호가 서면 도는 슬롯을 종료하고 다음 슬롯을 시작하지 않는다 (D-066). */
  readonly signal?: AbortSignal;
  /** 대상에 기존 테스트가 없다는 Core 확인 근거 (D-093, `noTests`). reviewer 프롬프트에 싣는다. */
  readonly noTests?: string;
  /**
   * primary 가 성공한 뒤·reviewer 전에 Core 가 검증 명령을 돌린다 (D-094, D-040 을 once·세션으로). 돌려준 글은 reviewer 의
   * "검증 명령 (Core 실행)" 절이 된다 — 없으면(undefined) 절을 싣지 않는다. reviewer 를 끈 실행(`skipReviewer`)에서도 돈다.
   */
  readonly checks?: (signal?: AbortSignal) => Promise<string | undefined>;
}

export async function runDuo(
  matrix: Matrix,
  plan: AssignmentPlan,
  execute: SlotExecutor,
  task: string,
  budget: Budget,
  options: DuoOptions = {},
): Promise<DuoResult> {
  const { primary: primarySlot, reviewer: reviewerSlot, secondReviewer } = plan.slots;

  const { signal } = options;
  const primaryOptions: SlotRunOptions = {
    ...(options.resumePrimary !== undefined
      ? { resume: options.resumePrimary, ...(options.resumeBaseline ? { baseline: options.resumeBaseline } : {}) }
      : {}),
    ...(signal ? { signal } : {}),
  };
  const primary = await execute(primarySlot, task, Object.keys(primaryOptions).length > 0 ? primaryOptions : undefined);
  // 취소된 실행은 **받은 만큼만** 센다 (D-066) — 측정값이 없으면 추정치로 채우지 않는다. 죽은 실행에 작업당 추정을 물리면 거짓이다.
  const primaryLabel = `${primarySlot.label}·${primarySlot.effort}`;
  const primaryCharge = chargeRun(budget, primaryLabel, primary, estimateUsd(matrix, primarySlot), primarySlot.plan);
  // 금액과 토큰은 **같은 자리**에서 센다. 한쪽만 세면 구독제에서 상한이 통째로 비어 버린다 (D-030).
  budget.countTokens(primary.usage, primary.compactionUncounted);

  // 취소면 reviewer 를 띄우지 않는다 — primary 실행 중이든, primary 가 막 끝난 틈이든 (신호가 이미 섰다).
  // 틈에서 멈췄으면 primary 는 끝까지 갔으니 멈춘 자리는 reviewer 단계다.
  if (primary.cancelled === true || signal?.aborted === true) {
    return { primary, primaryCharge, review: null, reviews: [], verdict: 'unknown', evidence: [], cancelledAt: primary.cancelled === true ? 'primary' : 'reviewer' };
  }

  // 위에서 `signal?.aborted` 를 이미 본 탓에 TS 가 false 로 좁혀 둔다 — 검증 명령·reviewer 실행(await) 뒤에는 다시 읽어야 한다.
  const aborted = (): boolean => signal?.aborted === true;
  // primary 가 실패했으면 검증할 산출물이 없다. 검증 명령도 reviewer 도 돌리지 않는다.
  if (!primary.ok) return { primary, primaryCharge, review: null, reviews: [], verdict: 'unknown', evidence: [], cancelledAt: null };

  // 검증 명령은 reviewer **앞**이다 (D-094) — 뒤에 돌리면 결과가 reviewer 에 닿지 않는다(Q30 사실 1-1).
  const checks = options.checks ? await options.checks(signal) : undefined;
  if (aborted()) {
    return { primary, primaryCharge, review: null, reviews: [], verdict: 'unknown', evidence: [], cancelledAt: options.checks ? 'verify' : 'reviewer' };
  }

  if (options.skipReviewer === true) {
    return { primary, primaryCharge, review: null, reviews: [], verdict: 'unknown', evidence: [], cancelledAt: null };
  }

  // 사다리 ④ 배정이면 reviewer 가 둘이다 (D-072). 둘 다 읽기 전용이고 같은 산출물을 서로의 판정 없이 따로 본다. 이어 붙이지 않는다(resume 없음).
  const reviewerSlots = secondReviewer ? [reviewerSlot, secondReviewer] : [reviewerSlot];
  const prompt = reviewPrompt(plan, task, primary.text, checks, options.noTests);
  const reviews: ReviewRun[] = [];
  let first: SlotRun | null = null;
  for (const slot of reviewerSlots) {
    // 상한을 넘겼으면 (다음) reviewer 를 시작하지 않는다 — 쓴 것은 못 되돌린다. **금액과 토큰 둘 다 본다** (D-030).
    if (budget.limitReached()) break;
    // 두 reviewer 사이에 멈췄다 — 다음 reviewer 를 띄우지 않는다 (D-066).
    if (first !== null && aborted()) {
      return { primary, primaryCharge, review: first, reviews, verdict: 'unknown', evidence: [], cancelledAt: 'reviewer' };
    }
    const run = await execute(slot, prompt, signal ? { signal } : undefined);
    first ??= run;
    chargeRun(budget, `${slot.label}·${slot.effort}`, run, estimateUsd(matrix, slot), slot.plan);
    budget.countTokens(run.usage, run.compactionUncounted);

    // reviewer 실행 중 멈췄다 — primary 는 끝났고 과금됐지만 검증은 없다. 판정을 지어내지 않는다 (D-066).
    if (run.cancelled === true) {
      return { primary, primaryCharge, review: first, reviews, verdict: 'unknown', evidence: [], cancelledAt: 'reviewer' };
    }
    reviews.push({ reviewer: `${slot.label}·${slot.effort} (${slot.engine}/${slot.modelId})`, run, verdict: run.ok ? parseVerdict(run.text) : 'unknown' });
  }

  const verdict = combineVerdicts(reviews.map((r) => r.verdict), reviewerSlots.length);
  // 합친 판정이 unknown 이면 PASS 한 쪽의 증거도 싣지 않는다 — 배정한 검증이 다 서지 않았는데 R11 을 채우면 pass 로 봐주는 것이다.
  const evidence: Evidence[] =
    verdict === 'unknown'
      ? []
      : reviews.flatMap((r): Evidence[] =>
          r.verdict === 'unknown' ? [] : [{ kind: 'review', reviewer: r.reviewer, verdict: r.verdict, text: r.run.text.slice(0, 2000) }]);

  return { primary, primaryCharge, review: first, reviews, verdict, evidence, cancelledAt: null };
}

/** 결과 기록·화면에 싣는 reviewer 검증 글. 하나면 그 글 그대로(옛 모양), 둘이면 reviewer 마다 머리줄을 단다 (D-072). */
export function reviewText(reviews: readonly ReviewRun[], max = 2000): string {
  if (reviews.length <= 1) return reviews[0]?.run.text.slice(0, max) ?? '';
  return reviews.map((r) => `[reviewer ${r.reviewer} → ${r.verdict.toUpperCase()}]\n${r.run.text.slice(0, max)}`).join('\n\n');
}

/**
 * 한 슬롯 실행을 Budget 에 센다. 취소된 실행은 측정값(actual·metered)이 있을 때만 세고, 없으면 세지 않는다 —
 * `Budget.charge` 의 마지막 수단(작업당 추정)은 끝까지 돈 실행의 값이다 (D-066). 안 센 자리는 Budget 에 안 들어간 0 을 돌려준다.
 */
function chargeRun(budget: Budget, label: string, run: SlotRun, estimate: number, plan: BillingPlan): Charge {
  if (run.cancelled === true && run.actualUsd === undefined && run.meteredUsd === undefined) {
    return { label, usd: 0, source: 'actual', plan };
  }
  return budget.charge(label, run.actualUsd, estimate, run.meteredUsd, plan);
}
