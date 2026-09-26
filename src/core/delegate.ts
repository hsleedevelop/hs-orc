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
import { firstLine, secondLine } from './decide.ts';
import { runDuo, type Verdict } from './duo.ts';
import { collect, outcomeOf, type Evidence, type EvidenceReport, type SettledOutcome } from './evidence.ts';
import { changedFiles, runCommand, snapshotTests, testChanges } from './evidence-gather.ts';
import { declaredTests } from '../data/verify.ts';
import type { EngineReport, SlotExecutor } from './executor.ts';
import type { Journal } from './journal.ts';
import { reportError } from './report.ts';
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
}

export interface Delegated {
  readonly ok: boolean;
  readonly text: string;
  readonly outcome: SettledOutcome;
  readonly report: EvidenceReport;
  readonly verdict: Verdict;
  readonly review?: string;
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
  const testGlobs = declaredTests();
  const testsBefore = testGlobs.length > 0 ? snapshotTests(testGlobs, input.cwd) : undefined;

  // **두 슬롯을 실제로 돌린다** (D-009) — primary 만 돌리면 단일 엔진 선택기다.
  let duo;
  try {
    duo = await runDuo(matrix, plan, input.execute, input.prompt, budget,
      input.resumePrimary !== undefined
        ? { resumePrimary: input.resumePrimary, ...(input.resumeBaseline ? { resumeBaseline: input.resumeBaseline } : {}) }
        : {});
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
      meta: { outcome: run.ok ? 'ok' : 'failed', durationMs: run.durationMs, modelId: slot.modelId, verdict: duo.verdict },
    }, runStoreRoot(input.cwd)).dir;
  } catch (error) {
    // catch 후 무동작 금지.
    process.stderr.write(`${reportError('run-store', 'persist', error).display}\n`);
  }

  const evidence: Evidence[] = [...duo.evidence, ...input.verify.filter((v) => v.trim()).map((v) => runCommand(v, input.cwd))];
  if (evidence.length > 0) evidence.push(changedFiles(input.cwd));
  if (testsBefore) evidence.push(testChanges(testsBefore, testGlobs, input.cwd));
  const report = collect(plan.assignment, evidence);

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
    ...(duo.review ? { review: duo.review.text.slice(0, 2000) } : {}),
    decisionId: decision.id,
    ...(run.compactions ? { compactions: run.compactions } : {}),
    // 성공한 primary 만 이을 수 있다 — 실패한 세션을 다음에 이으면 실패를 물려받는다.
    ...(run.ok && run.sessionId
      ? { primarySession: { engine: slot.engine, modelId: slot.modelId, effort: slot.effort, id: run.sessionId, ...(run.reported ? { reported: run.reported } : {}) } }
      : {}),
  };
}
