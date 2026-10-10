/**
 * 위임 1건 실행 (SPEC §4 의 5~7단계). **배정이 끝난 뒤의 모든 것**이다:
 * 결정 로그 1차 → 두 슬롯 → 원시 로그 → 증거 → journal → 결정 로그 2차.
 *
 * 원래 `GuiService.run` 안(셸)에 있었다. 대화 세션(Core)이 같은 일을 해야 해서 내려왔다 —
 * 두 곳에 두면 증거·로그 규칙이 갈린다.
 */
import type { Matrix } from '../data/matrix.ts';
import type { AssignmentPlan } from './assign.ts';
import type { Budget } from './budget.ts';
import { appendDecision } from './decision-log.ts';
import { cancelledLine, firstLine, secondLine } from './decide.ts';
import { checksText, noTestsEvidenceNote, primaryNoTestsNote, readOnlyVerifyNote, reviewText, runDuo, type CancelledAt, type ReviewRun, type Verdict } from './duo.ts';
import { EXISTING_TEST_ROWS, collect, outcomeOf, type Evidence, type EvidenceReport, type SettledOutcome } from './evidence.ts';
import { changedFiles, noTests, runCommand, snapshotTests, testChanges, type CommandEvidence } from './evidence-gather.ts';
import { declaredTests } from '../data/verify.ts';
import type { EngineReport, SlotExecutor } from './executor.ts';
import type { Journal } from './journal.ts';
import { reportError } from './report.ts';
import { verifyConfigPath } from './project-state.ts';
import { runStoreRoot, storeRun } from './run-store.ts';
import type { EngineSessionRef } from './transcript.ts';
import type { EngineCompaction } from '../adapters/types.ts';

export interface DelegateInput {
  readonly matrix: Matrix;
  readonly plan: AssignmentPlan;
  readonly reason: string;
  /** 결정 로그에 남는 작업 문장 — 사용자가 쓴 그대로다. */
  readonly title: string;
  /** 엔진에 보내는 프롬프트. 대화 세션은 맥락을 붙여 넘긴다 (SPEC §6.4.3). */
  readonly prompt: string;
  readonly verify: readonly string[];
  /** 쓰기 위임인가. 읽기 전용이면 `verify` 를 돌리지 않는다 — primary 의 변경이 작업 트리에 없어 원본을 검사하게 된다 (D-094, D-040 결정 3). */
  readonly write: boolean;
  readonly cwd: string;
  readonly execute: SlotExecutor;
  readonly budget: Budget;
  readonly journal: Journal;
  /** 결정 로그 1차 `note` 끝에 붙인다 — 세션 id 로 대화 기록과 잇는다 (SPEC §8). */
  readonly note?: string;
  /** primary 가 이어 붙일 엔진 세션 (SPEC §6.4.3). reviewer 에는 절대 가지 않는다. */
  readonly resumePrimary?: string;
  /** 이어 붙일 세션의 직전 원본 보고 (D-057). */
  readonly resumeBaseline?: EngineReport;
  /** 신호가 서면 도는 엔진 슬롯을 종료하고 위임을 `cancelled` 로 끝낸다 (D-066). */
  readonly signal?: AbortSignal;
}

export interface Delegated {
  readonly ok: boolean;
  readonly text: string;
  /** `cancelled` — 사용자가 실행 중에 멈췄다 (D-066). 실패도 성공도 아니다: 증거를 모으지 않고, 엔진 세션을 남기지 않는다. */
  readonly outcome: SettledOutcome | 'cancelled';
  /** `outcome` 이 `cancelled` 일 때 어느 단계에서 멈췄는가. `verify` 는 primary 뒤 검증 명령 중이다 (D-094). */
  readonly cancelledAt?: CancelledAt;
  readonly report: EvidenceReport;
  readonly verdict: Verdict;
  /** reviewer 검증 글. reviewer 가 둘이면(D-072) reviewer 마다 머리줄을 단 한 글이다 — 기록 모양은 그대로다. */
  readonly review?: string;
  /** reviewer 마다의 판정과 글 (D-072). 요약이 FAIL 한 쪽의 사유를 고르는 데 쓴다 (D-093) — 기록에는 싣지 않는다. */
  readonly reviews?: readonly ReviewRun[];
  readonly decisionId: string;
  readonly primarySession?: EngineSessionRef;
  /** primary 실행 중 엔진이 한 압축 (D-058). */
  readonly compactions?: readonly EngineCompaction[];
}

export async function delegate(input: DelegateInput): Promise<Delegated> {
  const { matrix, plan, budget, journal } = input;
  const slot = plan.slots.primary;
  // 1차 결정 로그 — 배정을 확정한 이 시점에 남긴다 (SPEC §8).
  const first = firstLine(matrix, plan, input.title, input.reason);
  const decision = input.note ? { ...first, note: `${first.note ?? ''} · ${input.note}` } : first;
  appendDecision(decision);

  // 기존 테스트의 작업 전 내용 — 약해졌는지는 primary 뒤에 본다 (D-047). 선언이 없으면 보지 않는다.
  const testGlobs = declaredTests(verifyConfigPath(input.cwd));
  const testsBefore = testGlobs.length > 0 ? snapshotTests(testGlobs, input.cwd) : undefined;
  // 기존 테스트를 전제하는 행인데 대상에 테스트가 없다 (D-093) — primary 가 밝히게 하고 reviewer·증거에 싣는다. 작업 **전**에 본다.
  const missingTests = EXISTING_TEST_ROWS.has(plan.assignment.id) ? noTests(input.cwd) : null;
  const prompt = missingTests ? `${input.prompt}\n\n${primaryNoTestsNote(missingTests)}` : input.prompt;

  // 검증 명령은 primary 뒤·reviewer 앞에 Core 가 돌리고 결과를 reviewer 에 싣는다 (D-094). 읽기 전용이면 돌리지 않는다.
  const verifyCmds = input.verify.filter((v) => v.trim());
  const ran: CommandEvidence[] = [];
  const checks = input.write && verifyCmds.length > 0
    ? async (signal?: AbortSignal): Promise<string> => {
        for (const cmd of verifyCmds) {
          const r = await runCommand(cmd, input.cwd, signal ? { signal } : {});
          if (r.cancelled) break;
          ran.push(r.evidence);
        }
        return checksText(ran);
      }
    : undefined;

  // **두 슬롯을 실제로 돌린다** (D-009) — primary 만 돌리면 단일 엔진 선택기다. 사다리 ④ 배정은 reviewer 가 둘이다 (D-072).
  let duo;
  try {
    duo = await runDuo(matrix, plan, input.execute, prompt, budget,
      {
        ...(input.resumePrimary !== undefined
          ? { resumePrimary: input.resumePrimary, ...(input.resumeBaseline ? { resumeBaseline: input.resumeBaseline } : {}) }
          : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(missingTests ? { noTests: missingTests } : {}),
        ...(checks ? { checks } : {}),
      });
  } catch (error) {
    // 1차 줄을 pending 으로 버려두지 않는다 — 실행을 시작했고 끝나지 못했다.
    appendDecision(secondLine(decision, 'wrong', `실행 중 예외: ${error instanceof Error ? error.message : String(error)}`));
    throw error;
  }
  const run = duo.primary;
  // journal 줄은 primary 실행이다 — 과금도 primary 것을 싣는다.
  const charge = duo.primaryCharge;

  let stored = '';
  try {
    stored = storeRun(decision.id, journal.records.length + 1, slot.label, {
      rawStdout: run.rawStdout,
      rawStderr: run.rawStderr,
      meta: {
        outcome: duo.cancelledAt ? 'cancelled' : run.ok ? 'ok' : 'failed', durationMs: run.durationMs, modelId: slot.modelId, verdict: duo.verdict,
        ...(run.cacheWrite ? { cacheWrite: run.cacheWrite } : {}),
      },
    }, runStoreRoot(input.cwd)).dir;
  } catch (error) {
    // catch 후 무동작 금지.
    process.stderr.write(`${reportError('run-store', 'persist', error).display}\n`);
  }

  // 사용자가 멈췄다 (D-066). 증거·journal 에 넣지 않는다 — 잘린 실행은 결과가 아니다. 2차 줄은 `cancelled` 로 닫고,
  // 엔진 세션은 넘기지 않는다(강제 종료로 끊긴 세션은 이을 수 없다). 원시 로그는 위에서 남겼다.
  if (duo.cancelledAt) {
    appendDecision(cancelledLine(decision, duo.cancelledAt));
    return {
      ok: false,
      text: run.text,
      outcome: 'cancelled',
      cancelledAt: duo.cancelledAt,
      report: collect(plan.assignment, []),
      verdict: 'unknown',
      decisionId: decision.id,
    };
  }

  const evidence: Evidence[] = [...duo.evidence, ...ran];
  if (evidence.length > 0) evidence.push(changedFiles(input.cwd));
  if (testsBefore) evidence.push(testChanges(testsBefore, testGlobs, input.cwd));
  const notes = [
    ...(missingTests ? [noTestsEvidenceNote(missingTests)] : []),
    ...(!input.write && verifyCmds.length > 0 ? [readOnlyVerifyNote(verifyCmds)] : []),
  ];
  const report = collect(plan.assignment, evidence, notes);

  journal.append({
    index: journal.records.length + 1,
    unit: '실행',
    model: slot.label,
    effort: slot.effort,
    outcome: run.ok ? 'ok' : 'failed',
    evidence: `운영 기준: ${plan.assignment.operatingCriterion}`,
    change: run.text.slice(0, 200),
    // 증거가 모였거나 나쁜 결과를 말할 때만 채운다. 빈 값은 "통과"가 아니라 "검증 안 함"이다.
    verification: report.satisfied || report.contradictions.length > 0 ? report.summary : '',
    charge,
  });

  // 2차 — 같은 id 로 append. 증거가 모이고 나쁜 결과가 없을 때만 ok 다 (SPEC §5, D-043).
  const outcome = outcomeOf(run.ok, report);
  appendDecision(secondLine(decision, outcome, [stored && `원시 로그 ${stored}`, report.summary].filter(Boolean).join(' · ')));

  return {
    ok: run.ok,
    text: run.text,
    outcome,
    report,
    verdict: duo.verdict,
    ...(duo.reviews.length > 0 ? { review: reviewText(duo.reviews), reviews: duo.reviews } : {}),
    decisionId: decision.id,
    ...(run.compactions ? { compactions: run.compactions } : {}),
    // 성공한 primary 만 이을 수 있다 — 실패한 세션을 다음에 이으면 실패를 물려받는다.
    ...(run.ok && run.sessionId
      ? { primarySession: { engine: slot.engine, modelId: slot.modelId, effort: slot.effort, id: run.sessionId, ...(run.reported ? { reported: run.reported } : {}) } }
      : {}),
  };
}
