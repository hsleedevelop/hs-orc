/**
 * GUI 메인 프로세스의 **로직** (PLAN S7).
 *
 * Electron 을 import 하지 않는다 — 그래야 S5 시나리오를 창 없이 테스트할 수 있고,
 * `main.ts` 는 IPC 배선만 남는다. Core·adapters·data 는 **손대지 않는다**.
 */
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { loadLimits } from '../../data/limits.ts';
import { route } from '../../core/pipeline.ts';
import { createExecutor, type SlotExecutor } from '../../core/executor.ts';
import { runDuo } from '../../core/duo.ts';
import { Budget } from '../../core/budget.ts';
import { Journal } from '../../core/journal.ts';
import { appendDecision } from '../../core/decision-log.ts';
import { firstLine, secondLine } from '../../core/decide.ts';
import { storeRun } from '../../core/run-store.ts';
import { collect, type Evidence, type EvidenceReport } from '../../core/evidence.ts';
import { changedFiles, runCommand } from '../../core/evidence-gather.ts';
import { reportError } from '../../core/report.ts';
import { dashboardView, runView, titleInfo, type RunView } from '../tui/model.ts';

export interface RunPayload {
  readonly task: string;
  readonly verify: readonly string[];
  /** D-025: primary 슬롯에만 파일 쓰기를 허용한다. */
  readonly write?: boolean;
}

export interface RunOutcome {
  readonly ok: boolean;
  readonly text: string;
  readonly outcome?: 'ok' | 'unverified' | 'wrong';
  readonly report?: EvidenceReport;
  readonly verdict?: 'pass' | 'fail' | 'unknown';
  readonly review?: string;
  readonly budget?: string;
  readonly journal?: string;
  readonly view?: RunView;
}

export class GuiService {
  readonly journal = new Journal();
  readonly budget: Budget;
  private readonly execute: SlotExecutor | undefined;

  constructor(execute?: SlotExecutor, budgetUsd = loadLimits().budgetUsd) {
    this.budget = new Budget(budgetUsd);
    this.execute = execute;
  }

  /** v1 의 뷰모델을 그대로 쓴다 (D-021). 여기 Ink 타입이 새어 있으면 이 파일이 안 컴파일된다. */
  plan(task: string, write = false): RunView {
    return runView(task.trim() ? route(loadMatrix(), loadEngines(), task) : null, task, { write });
  }

  dashboard() {
    return dashboardView(this.journal, this.budget);
  }

  debug() {
    return {
      title: titleInfo('Debug'),
      node: process.version,
      electron: process.versions['electron'] ?? '?',
      pid: process.pid,
      cwd: process.cwd(),
      limits: loadLimits(),
    };
  }

  /** 고의 크래시 — 설정만으로는 리포팅이 살아 있는지 알 수 없다 (hs-engineering). */
  crashTest(): string {
    try {
      throw new Error('의도적 크래시 — 리포팅 경로 자가 검증');
    } catch (error) {
      return reportError('gui/main', 'crash-test', error).display;
    }
  }

  /** S5 시나리오: 분류 → 배정·비용 → (승인) → 실행 → 증거 → 결정 로그 2회. */
  async run(payload: RunPayload): Promise<RunOutcome> {
    const matrix = loadMatrix();
    const catalog = loadEngines();
    const result = route(matrix, catalog, payload.task);
    if (result.stage !== 'assigned')
      return { ok: false, text: '', view: runView(result, payload.task, { write: payload.write === true }) };

    const slot = result.plan.slots.primary;
    const execute =
      this.execute ??
      createExecutor(loadEngines(), process.cwd(), loadLimits().runTimeoutMs, { write: payload.write === true });
    // 1차 결정 로그 — 배정을 확정한 이 시점에 남긴다 (SPEC §8).
    const decision = firstLine(matrix, result.plan, payload.task, result.reason);
    appendDecision(decision);

    // **두 슬롯을 실제로 돌린다** (D-009) — primary 만 돌리면 단일 엔진 선택기다.
    const duo = await runDuo(matrix, result.plan, execute, payload.task, this.budget);
    const run = duo.primary;
    const charge = this.budget.charges.at(-1);

    let stored = '';
    try {
      stored = storeRun(decision.id, this.journal.records.length + 1, slot.label, {
        rawStdout: '',
        rawStderr: '',
        meta: { outcome: run.ok ? 'ok' : 'failed', durationMs: run.durationMs, modelId: slot.modelId, verdict: duo.verdict },
      }).dir;
    } catch (error) {
      // catch 후 무동작 금지.
      process.stderr.write(`${reportError('run-store', 'persist', error).display}\n`);
    }

    const evidence: Evidence[] = [...duo.evidence, ...payload.verify.filter((v) => v.trim()).map((v) => runCommand(v, process.cwd()))];
    if (evidence.length > 0) evidence.push(changedFiles());
    const report = collect(result.plan.assignment, evidence);

    this.journal.append({
      index: this.journal.records.length + 1,
      unit: '실행',
      model: slot.label,
      effort: slot.effort,
      outcome: run.ok ? 'ok' : 'failed',
      evidence: `운영 기준: ${result.plan.assignment.operatingCriterion}`,
      change: run.text.slice(0, 200),
      // 증거가 모였을 때만 채운다. 빈 값은 "통과"가 아니라 "검증 안 함"이다.
      verification: report.satisfied ? report.summary : '',
      ...(charge ? { charge } : {}),
    });

    // 2차 — 같은 id 로 append. 증거가 모였을 때만 ok 다 (SPEC §5).
    const outcome = !run.ok ? 'wrong' : report.satisfied ? 'ok' : 'unverified';
    appendDecision(
      secondLine(decision, outcome, [stored && `원시 로그 ${stored}`, report.summary].filter(Boolean).join(' · ')),
    );

    return {
      ok: run.ok,
      text: run.text,
      outcome,
      report,
      verdict: duo.verdict,
      ...(duo.review ? { review: duo.review.text.slice(0, 2000) } : {}),
      budget: this.budget.summary(),
      journal: this.journal.render(),
    };
  }
}
