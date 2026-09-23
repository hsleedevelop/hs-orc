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
import { Budget } from '../../core/budget.ts';
import { Journal } from '../../core/journal.ts';
import { delegate } from '../../core/delegate.ts';
import type { EvidenceReport } from '../../core/evidence.ts';
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
  /**
   * 사용자가 고른 업무 행 (CLI `--task` 와 같다). 분류를 건너뛴다.
   * **plan 과 run 에 같은 값이 가야 한다** — run 이 다시 분류하면 승인한 배정과 다른 행이 돈다.
   */
  readonly taskId?: string;
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
    this.budget = new Budget(budgetUsd, loadLimits().tokenBudget);
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
      ...(options.taskId ? { taskId: options.taskId } : {}),
    });
    return runView(routed.result, task, { write, ...(routed.fallback ? { notes: [routed.fallback.line] } : {}) });
  }

  /** 분류가 빗나갔을 때 화면에서 고를 업무 행. 매트릭스를 그대로 읽는다 — 목록을 셸에 따로 적지 않는다. */
  tasks(): { id: string; task: string }[] {
    return loadMatrix().assignments.map((a) => ({ id: a.id, task: a.task }));
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
      ...(payload.taskId ? { taskId: payload.taskId } : {}),
    });
    const result = routed.result;
    const notes = routed.fallback ? { notes: [routed.fallback.line] } : {};
    if (result.stage !== 'assigned')
      return { ok: false, text: '', view: runView(result, payload.task, { write: payload.write === true, ...notes }) };

    const execute =
      this.execute ??
      createExecutor(loadEngines(), this.workdir, loadLimits().runTimeoutMs, { write: payload.write === true });
    const d = await delegate({
      matrix,
      plan: result.plan,
      reason: result.reason,
      title: payload.task,
      prompt: payload.task,
      verify: payload.verify,
      cwd: this.workdir,
      execute,
      budget: this.budget,
      journal: this.journal,
    });
    return {
      ok: d.ok,
      text: d.text,
      outcome: d.outcome,
      report: d.report,
      verdict: d.verdict,
      ...(d.review ? { review: d.review } : {}),
      budget: this.budget.summary(),
      journal: this.journal.render(),
    };
  }
}
