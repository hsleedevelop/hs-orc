/**
 * GUI 메인 프로세스의 **로직** (PLAN S7).
 *
 * Electron 을 import 하지 않는다 — 그래야 S5 시나리오를 창 없이 테스트할 수 있고,
 * `main.ts` 는 IPC 배선만 남는다. Core·adapters·data 는 **손대지 않는다**.
 */
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { loadLimits } from '../../data/limits.ts';
import { routeWithFallback } from '../../core/pipeline.ts';
import { createExecutor, type SlotExecutor } from '../../core/executor.ts';
import { runDuo } from '../../core/duo.ts';
import { Budget } from '../../core/budget.ts';
import { Journal } from '../../core/journal.ts';
import { appendDecision } from '../../core/decision-log.ts';
import { firstLine, secondLine } from '../../core/decide.ts';
import { runStoreRoot, storeRun } from '../../core/run-store.ts';
import { collect, type Evidence, type EvidenceReport } from '../../core/evidence.ts';
import { changedFiles, runCommand } from '../../core/evidence-gather.ts';
import { reportError } from '../../core/report.ts';
import { dashboardView, runView, titleInfo, type RunView } from '../tui/model.ts';
import {
  describeProject,
  forgetProject,
  loadProjects,
  rememberProject,
  validateProject,
  type ProjectInfo,
} from './projects.ts';
import {
  createWorktree,
  listWorktrees,
  mainWorktree,
  removeWorktree,
  samePath,
  type WorktreeInfo,
} from './worktree.ts';

export interface PlanOptions {
  /** D-025: primary 슬롯에만 파일 쓰기를 허용한다. */
  readonly write?: boolean;
  /** D-026: 규칙이 빗나갔을 때 LLM 분류 폴백. 기본 켜짐. 끄면 유료 호출이 아예 없다. */
  readonly classifyLlm?: boolean;
}

export interface RunPayload extends PlanOptions {
  readonly task: string;
  readonly verify: readonly string[];
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

export interface ProjectState {
  /** 엔진·검증 명령·`.hs-orc/runs`·git 변경 파일이 **전부 이 폴더 기준**이다. */
  readonly current: ProjectInfo;
  readonly recent: readonly ProjectInfo[];
}

export interface WorktreeState {
  /** **본체** 작업 트리. git 저장소가 아니면 null — 화면은 "저장소가 아니다"를 그대로 보여준다. */
  readonly repo: string | null;
  readonly items: readonly WorktreeInfo[];
  /** 지금 작업 폴더가 이 목록의 어느 것인가. 어느 것도 아니면 빈 문자열이다. */
  readonly current: string;
}

export class GuiService {
  readonly journal = new Journal();
  readonly budget: Budget;
  private readonly execute: SlotExecutor | undefined;
  /**
   * 작업 폴더. **`process.cwd()` 를 직접 읽는 곳이 이 클래스에 더 있으면 안 된다** — 화면에서
   * 폴더를 바꿔도 엔진이나 검증 명령이 예전 폴더에서 돌면 그게 가장 위험한 종류의 버그다.
   */
  private workdir: string;

  constructor(execute?: SlotExecutor, budgetUsd = loadLimits().budgetUsd, cwd = process.cwd()) {
    this.budget = new Budget(budgetUsd);
    this.execute = execute;
    this.workdir = cwd;
  }

  get cwd(): string {
    return this.workdir;
  }

  /** 현재 폴더 + 최근 목록. 최근 목록을 못 읽어도 현재 폴더는 늘 나온다. */
  projects(): ProjectState {
    return {
      current: describeProject(this.workdir),
      recent: loadProjects().map((d) => describeProject(d)),
    };
  }

  /**
   * 폴더를 바꾼다. **검증이 먼저다** — 폴더가 아니면 바꾸지 않고 던진다.
   * 누적 비용(`budget`)과 journal 은 **초기화하지 않는다**: 이 세션에서 쓴 돈은 폴더를 옮겨도 쓴 돈이다.
   */
  useProject(dir: string): ProjectState {
    this.workdir = validateProject(dir);
    try {
      rememberProject(this.workdir);
    } catch (error) {
      // 최근 목록 저장 실패가 폴더 전환을 막지는 않는다. 다만 조용히 넘어가지도 않는다.
      process.stderr.write(`${reportError('gui/projects', 'remember', error).display}\n`);
    }
    return this.projects();
  }

  /**
   * v1 의 뷰모델을 그대로 쓴다 (D-021). 여기 Ink 타입이 새어 있으면 이 파일이 안 컴파일된다.
   * **async 인 이유는 LLM 분류 폴백이다** (D-026) — CLI 에만 있으면 같은 입력이 셸마다 달라진다.
   */
  async plan(task: string, options: PlanOptions = {}): Promise<RunView> {
    const write = options.write === true;
    if (!task.trim()) return runView(null, task, { write });
    const routed = await routeWithFallback(loadMatrix(), loadEngines(), task, {
      // 분류기도 이 폴더에서 돈다 (D-029) — 분류만 옛 폴더에 남으면 화면과 실행이 갈린다.
      cwd: this.workdir,
      ...(options.classifyLlm === undefined ? {} : { classifyLlm: options.classifyLlm }),
    });
    return runView(routed.result, task, { write, ...(routed.fallback ? { notes: [routed.fallback.line] } : {}) });
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
      cwd: this.workdir,
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

  /** 현재 폴더가 속한 저장소의 워크트리 목록. */
  worktrees(): WorktreeState {
    const items = listWorktrees(this.workdir);
    const mine = items.find((w) => samePath(w.dir, this.workdir));
    return { repo: mainWorktree(this.workdir), items, current: mine?.dir ?? '' };
  }

  /**
   * 워크트리를 만들고 **그 안으로 들어간다.** 만들기만 하고 현재 폴더를 그대로 두면
   * 쓰기를 가두려던 목적이 그대로 새 나간다.
   */
  createWorktree(name: string, from?: string): ProjectState {
    const made = createWorktree(this.workdir, name, from === undefined ? {} : { from });
    return this.useProject(made.dir);
  }

  /**
   * 워크트리를 지운다. **파괴적이라 화면에서 한 번 더 확인받은 뒤에만 부른다.**
   * 지금 그 안에 있으면 **먼저 본체로 나온다** — 발밑을 지울 수는 없다.
   */
  removeWorktree(dir: string): { project: ProjectState; worktrees: WorktreeState; note: string } {
    if (samePath(dir, this.workdir)) {
      const main = mainWorktree(this.workdir);
      if (main === null) throw new Error(`git 저장소가 아니다: ${this.workdir}`);
      this.useProject(main);
    }
    const result = removeWorktree(this.workdir, dir);
    // 지운 폴더가 최근 목록에 "(없음)" 으로 남지 않게 한다.
    try {
      forgetProject(result.dir);
    } catch (error) {
      process.stderr.write(`${reportError('gui/projects', 'forget', error).display}\n`);
    }
    return { project: this.projects(), worktrees: this.worktrees(), note: result.note };
  }

  /** S5 시나리오: 분류 → 배정·비용 → (승인) → 실행 → 증거 → 결정 로그 2회. */
  async run(payload: RunPayload): Promise<RunOutcome> {
    const matrix = loadMatrix();
    const catalog = loadEngines();
    const routed = await routeWithFallback(matrix, catalog, payload.task, {
      cwd: this.workdir,
      ...(payload.classifyLlm === undefined ? {} : { classifyLlm: payload.classifyLlm }),
    });
    const result = routed.result;
    const notes = routed.fallback ? { notes: [routed.fallback.line] } : {};
    if (result.stage !== 'assigned')
      return { ok: false, text: '', view: runView(result, payload.task, { write: payload.write === true, ...notes }) };

    const slot = result.plan.slots.primary;
    const execute =
      this.execute ??
      createExecutor(loadEngines(), this.workdir, loadLimits().runTimeoutMs, { write: payload.write === true });
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
      }, runStoreRoot(this.workdir)).dir;
    } catch (error) {
      // catch 후 무동작 금지.
      process.stderr.write(`${reportError('run-store', 'persist', error).display}\n`);
    }

    const evidence: Evidence[] = [...duo.evidence, ...payload.verify.filter((v) => v.trim()).map((v) => runCommand(v, this.workdir))];
    if (evidence.length > 0) evidence.push(changedFiles(this.workdir));
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
