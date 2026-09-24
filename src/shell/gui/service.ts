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
import type { EvidenceReport, SettledOutcome } from '../../core/evidence.ts';
import { reportError } from '../../core/report.ts';
import { dashboardView, runView, titleInfo, type RunView } from '../tui/model.ts';
import { ConversationSession } from '../../core/session.ts';
import {
  listScratchSessions,
  listSessions,
  prepareSession,
  readTranscript,
  scratchRoot,
  type SessionKind,
  type SessionState,
  type SessionSummary,
  type TranscriptRecord,
} from '../../core/transcript.ts';
import path from 'node:path';
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
  readonly outcome?: SettledOutcome;
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

export interface SessionView {
  readonly id: string;
  readonly kind: SessionKind;
  readonly dir: string;
  readonly state: SessionState;
  readonly records: readonly TranscriptRecord[];
  /** 깨진 줄 수 — 0 이 아니면 화면이 알린다. */
  readonly broken: number;
  readonly budget: string;
  /** 앱 전체 누적 — **표시만 한다, 상한 판정에 쓰지 않는다** (D-032 A2). 상한은 `budget`(세션 단위)이 건다. */
  readonly appBudget: string;
  /** 위임 도중 끊긴 기록이다 — 승인 뒤 결과가 없다. 화면이 배너로 알린다. */
  readonly interrupted: boolean;
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
  /** 레거시: `plan()`·`run()`(CLI 와 같은 1 회성 실행) 전용 Budget. 대화 세션은 각자 자기 것을 쓴다 (D-032 A2). */
  readonly budget: Budget;
  private readonly execute: SlotExecutor | undefined;
  private readonly budgetUsd: number;
  /**
   * 세션별 Budget (D-032 A2). 키는 `${dir}::${id}` — 앱을 끄지 않고 다시 열면 같은 것을 이어 쓴다.
   * **앱을 재시작하면 이 Map 도 비어서 0 부터 다시 잰다** — transcript 는 토큰을 저장하지 않는다,
   * 알려진 한계다.
   */
  private readonly sessionBudgets = new Map<string, Budget>();
  /**
   * 작업 폴더. **`process.cwd()` 를 직접 읽는 곳이 이 클래스에 더 있으면 안 된다** — 화면에서
   * 폴더를 바꿔도 엔진이나 검증 명령이 예전 폴더에서 돌면 그게 가장 위험한 종류의 버그다.
   */
  private workdir: string;
  private session: ConversationSession | null = null;

  constructor(execute?: SlotExecutor, budgetUsd = loadLimits().budgetUsd, cwd = process.cwd()) {
    this.budget = new Budget(budgetUsd, loadLimits().tokenBudget);
    this.budgetUsd = budgetUsd;
    this.execute = execute;
    this.workdir = cwd;
  }

  /** 세션 하나의 Budget 을 얻는다 — 없으면 새로 만들고, 있으면 그대로 재사용한다 (D-032 A2). */
  private sessionBudget(dir: string, id: string): Budget {
    const key = `${dir}::${id}`;
    const existing = this.sessionBudgets.get(key);
    if (existing) return existing;
    const created = new Budget(this.budgetUsd, loadLimits().tokenBudget);
    this.sessionBudgets.set(key, created);
    return created;
  }

  /** 표시용 앱 누적 — 열려본 모든 세션 Budget 과 레거시 `budget` 을 더한다. **상한 판정에 쓰지 않는다** (D-032 A2). */
  private appBudgetSummary(): string {
    const all: readonly Budget[] = [this.budget, ...this.sessionBudgets.values()];
    const spentTokens = all.reduce((sum, b) => sum + b.spentTokens, 0);
    const spentUsd = all.reduce((sum, b) => sum + b.spentUsd, 0);
    return `앱 누적 · 토큰 ${spentTokens} · $${spentUsd.toFixed(4)} 환산 — 표시만, 막지 않는다`;
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
    // 화면의 폴더와 세션의 폴더가 갈리면 안 된다 (D-029) — 다른 폴더의 project 세션은 닫는다.
    if (this.session?.kind === 'project' && !samePath(this.session.dir, this.workdir)) this.session = null;
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
      // 이미 가진 예산을 넘긴다 (D-034) — 분류 폴백 비용도 같은 누적 상한에 합산된다.
      budget: this.budget,
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
      // 이미 가진 예산을 넘긴다 (D-034) — 분류 폴백 비용도 같은 누적 상한에 합산된다.
      budget: this.budget,
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

  conversations(): SessionSummary[] {
    return [...listSessions(this.workdir, 'project'), ...listScratchSessions()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  startConversation(kind: SessionKind): SessionView {
    const { dir, id } = prepareSession(kind, this.workdir);
    return this.attach(kind, dir, id);
  }

  /** project 세션은 그 폴더로 **먼저 옮긴다** — 화면의 폴더가 세션의 폴더다. 스크래치는 스크래치 뿌리 안이어야 한다. */
  openConversation(kind: SessionKind, dir: string, id: string): SessionView {
    if (kind === 'project') {
      this.useProject(dir);
    } else if (path.relative(scratchRoot(), dir).startsWith('..')) {
      throw new Error(`스크래치 뿌리 밖의 폴더다: ${dir}`);
    }
    return this.attach(kind, dir, id);
  }

  conversation(): SessionView {
    const s = this.requireConversation();
    return {
      id: s.id,
      kind: s.kind,
      dir: s.dir,
      state: s.state,
      records: s.records(),
      broken: readTranscript(s.file).broken,
      budget: this.sessionBudget(s.dir, s.id).summary(),
      appBudget: this.appBudgetSummary(),
      interrupted: s.interrupted,
    };
  }

  async converse(text: string): Promise<SessionView> {
    await this.requireConversation().send(text);
    return this.conversation();
  }

  async conversePlanAs(taskId: string): Promise<SessionView> {
    await this.requireConversation().planAs(taskId);
    return this.conversation();
  }

  async converseApprove(payload: { verify: readonly string[]; write: boolean }): Promise<SessionView> {
    await this.requireConversation().approve(payload);
    return this.conversation();
  }

  converseReject(): SessionView {
    this.requireConversation().reject();
    return this.conversation();
  }

  async converseAsk(): Promise<SessionView> {
    await this.requireConversation().askConductor();
    return this.conversation();
  }

  closeConversation(): void {
    this.session = null;
  }

  private requireConversation(): ConversationSession {
    if (!this.session) throw new Error('열린 세션이 없다.');
    return this.session;
  }

  private attach(kind: SessionKind, dir: string, id: string): SessionView {
    const catalog = loadEngines();
    const timeout = loadLimits().runTimeoutMs;
    const nonGit = kind === 'scratch';
    this.session = new ConversationSession({
      matrix: loadMatrix(),
      catalog,
      kind,
      dir,
      id,
      budget: this.sessionBudget(dir, id),
      journal: this.journal,
      // 지휘자(직접 답·요약)만 격리한다 (D-032 B1) — 위임 실행기(executorFor)는 그대로 사용자 설정을 싣는다.
      conduct: this.execute ?? createExecutor(catalog, dir, timeout, { nonGit, isolate: true }),
      executorFor: (write) => this.execute ?? createExecutor(catalog, dir, timeout, { write, nonGit }),
    });
    return this.conversation();
  }
}
