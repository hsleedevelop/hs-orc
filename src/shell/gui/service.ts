/**
 * GUI 메인 프로세스의 **로직** (PLAN S7).
 *
 * Electron 을 import 하지 않는다 — 그래야 S5 시나리오를 창 없이 테스트할 수 있고,
 * `main.ts` 는 IPC 배선만 남는다. Core·adapters·data 는 **손대지 않는다**.
 */
import { loadMatrix, type Slot } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { loadLimits, type ApprovalMode, type OrchestratorChoice } from '../../data/limits.ts';
import { orchestratorOptions, type OrchestratorOption } from '../../core/conductor.ts';
import { slotLine } from '../../core/reader.ts';
import { routeWithFallback } from '../../core/pipeline.ts';
import { createExecutor, type SlotExecutor } from '../../core/executor.ts';
import { Budget } from '../../core/budget.ts';
import { Journal } from '../../core/journal.ts';
import { delegate } from '../../core/delegate.ts';
import type { EvidenceReport, SettledOutcome } from '../../core/evidence.ts';
import { reportError } from '../../core/report.ts';
import { dashboardView, runView, titleInfo, type RunView } from '../view-model.ts';
import type { ConversationSession, LadderOffer } from '../../core/session.ts';
import {
  listScratchSessions,
  listSessions,
  prepareSession,
  readSessionLog,
  scratchRoot,
  sessionRole,
  type SessionKind,
  type SessionRole,
  type SessionState,
  type SessionSummary,
  type TranscriptRecord,
} from '../../core/transcript.ts';
import { existsSync, realpathSync } from 'node:fs';
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
import type { RowClassifier } from '../../adapters/jev.ts';
import { isTerminalId, openTerminal, runInTerminal, terminalCommand, type TerminalId } from './terminal.ts';
import { assembleSession, restoreBudget } from '../conversation.ts';
import { busyMessage, claimSession, foreignHold, lockPath, releaseSession, syncHold, type SessionHold } from '../../core/session-lock.ts';
import { assertNotEnded, readSessionMeta, setArchived, setEnded, withRoleLock } from '../../core/session-meta.ts';
import { assertNameFree, assertOrchestratorFree } from '../session-registry.ts';

export { skipGitCheck } from '../conversation.ts';

/**
 * 스크래치 세션 폴더는 뿌리 **아래** 여야 한다. 뿌리 자체는 다른 스크래치 세션을 다 품고,
 * 뿌리 안의 링크는 밖을 가리킬 수 있어 실제 경로로 비교한다. 없는 폴더는 밖으로 본다.
 */
function insideScratchRoot(dir: string): boolean {
  try {
    const rel = path.relative(realpathSync(scratchRoot()), realpathSync(dir));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

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
  readonly outcome?: SettledOutcome | 'cancelled';
  readonly report?: EvidenceReport;
  readonly verdict?: 'pass' | 'fail' | 'unknown';
  readonly review?: string;
  readonly budget?: string;
  readonly journal?: string;
  readonly view?: RunView;
}

export interface ProjectState {
  /** 엔진·검증 명령·실행 기록의 프로젝트 키(D-071)·git 변경 파일이 **전부 이 폴더 기준**이다. */
  readonly current: ProjectInfo;
  readonly recent: readonly ProjectInfo[];
}

/** 사이드바의 프로젝트/세션 묶음. 프로젝트는 현재 폴더가 먼저, 나머지는 최근 목록 순서다. */
export interface ConversationTree {
  readonly projects: readonly { readonly project: ProjectInfo; readonly sessions: readonly SessionSummary[] }[];
  readonly scratch: readonly SessionSummary[];
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
  /** primary·reviewer 가 도는 중이라 지금 취소할 수 있다 (D-066). 화면의 '취소' 버튼이 이것을 본다. */
  readonly cancellable: boolean;
  /** 도는 엔진 실행의 진행 줄 (D-084) — 중간 답 글·도구 호출. 돌 때만 싣는다. 화면이 "실행 중…" 아래에 끝부분을 보여준다. */
  readonly progress: readonly string[];
  /** 이 세션의 승인 방식 (D-064). 세션 머리의 선택이 이것을 본다. */
  readonly mode: ApprovalMode;
  /** 지금 '사다리 다음 단계로 다시 위임' 을 누를 수 있으면 그 단계 (D-068). 입력 대기 중이고 올릴 단계가 있을 때만 있다. */
  readonly ladder: LadderOffer | null;
  /** 이 세션의 지휘자 (D-087). 세션 머리의 선택이 이것을 본다 — `line` 은 기록·카드와 같은 슬롯 한 줄이다. */
  readonly orchestrator: OrchestratorChoice & { readonly engine: string; readonly line: string };
  /** 승인 대기 중인 것이 단계 계획이다 (D-087) — 카드가 '지휘자에게 묻기'·행 바꾸기 없이 선다. */
  readonly stepsPending: boolean;
  /** 승인 대기 중인 것이 스캐폴딩 카드다 (D-088). */
  readonly scaffoldPending: boolean;
  /** 승인 대기 중인 것이 앱 실행 카드다 (D-091) — 화면은 승인 대신 "터미널에서 실행" 을 보인다. */
  readonly runPending: boolean;
  /** 스캐폴딩이 git 없이 끝나 'git init + 첫 커밋' 을 누를 수 있다 (D-088). */
  readonly gitInitOffered: boolean;
  /** 붙인 이름 (D-085). `hs-orc session send <이름>` 이 이것으로 찾는다. */
  readonly name?: string;
  /** 다른 프로세스(`chat`·`hs-orc session`)가 이 세션을 쥐고 있다 (D-085). 화면은 입력을 막고 도는 중으로 보인다. */
  readonly external: SessionHold | null;
  /** 종료했다 (D-089). 화면은 열람만 하고 입력·조작을 막는다 — 보내도 서비스가 거절한다. */
  readonly ended: boolean;
  /** 보관했다 (D-089). 사이드바 기본 목록에서 숨는다 — 대화는 그대로 된다. */
  readonly archived: boolean;
  /** 역할 (D-090). 기록이 없으면 `worker`. 세션 머리의 칩·지정 버튼이 이것을 본다 — 메시지 경로와는 무관하다. */
  readonly role: SessionRole;
}

/** 사이드바·세션 머리가 종료·보관할 세션을 가리키는 값 (D-089). 목록 한 줄의 그것이다. */
export interface SessionRef {
  readonly kind: SessionKind;
  readonly dir: string;
  readonly id: string;
}

/** id 는 파일 이름이 된다 — 경로 문자가 섞이면 상태 폴더 밖에 쓴다. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

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
   * 앱을 재시작하면 처음 열 때 기록의 `spend` 를 재생해 되살린다 (D-054).
   */
  private readonly sessionBudgets = new Map<string, Budget>();
  /**
   * 작업 폴더. **`process.cwd()` 를 직접 읽는 곳이 이 클래스에 더 있으면 안 된다** — 화면에서
   * 폴더를 바꿔도 엔진이나 검증 명령이 예전 폴더에서 돌면 그게 가장 위험한 종류의 버그다.
   */
  private workdir: string;
  private session: ConversationSession | null = null;
  /**
   * 엔진 호출이 도는 세션 (D-063). 키는 `sessionBudgets` 와 같다. 화면에서 닫아도 실행은 이 객체에서 계속 돈다 —
   * 다시 열면 파일로 새 객체를 만들지 않고 **이것에 붙는다.** 새 객체는 도착할 결과를 모르고(끊김 오탐),
   * 도는 중에도 send 를 받아 같은 파일에 두 객체가 번갈아 쓴다. 호출이 끝나면 뺀다.
   */
  private readonly live = new Map<string, ConversationSession>();
  /** `live` 세션이 돌고 있는 호출. 취소가 이것이 끝나기를 기다렸다가 취소 결과가 담긴 뷰를 돌려준다 (D-066). */
  private readonly liveCalls = new Map<string, Promise<unknown>>();

  /** Jev 분류기 (D-065). 합성 루트(`gui/main.ts`)만 넘긴다 — 기본은 꺼짐이라 테스트는 외부로 나가지 않는다. */
  private readonly jev: RowClassifier | undefined;

  constructor(execute?: SlotExecutor, budgetUsd = loadLimits().budgetUsd, cwd = process.cwd(), jev?: RowClassifier) {
    this.jev = jev;
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
    const created = restoreBudget(dir, id, this.budgetUsd);
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
    if (this.session?.kind === 'project' && !samePath(this.session.dir, this.workdir)) {
      this.leave();
      this.session = null;
    }
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
      ...(this.jev ? { jev: this.jev } : {}),
      ...(options.classifyLlm === undefined ? {} : { classifyLlm: options.classifyLlm }),
      ...(options.taskId ? { taskId: options.taskId } : {}),
    });
    return runView(routed.result, task, { write, ...(routed.fallback ? { notes: [routed.fallback.line] } : {}) });
  }

  /** 분류가 빗나갔을 때 화면에서 고를 업무 행. 매트릭스를 그대로 읽는다 — 목록을 셸에 따로 적지 않는다. `models` 는 기본 effort 기준이라 사다리 상향 전 값이다. */
  tasks(): { id: string; task: string; models: string }[] {
    const slot = (s: Slot): string => `${s.label}·${s.efforts[0] ?? ''}`;
    return loadMatrix().assignments.map((a) => ({ id: a.id, task: a.task, models: `${slot(a.primary)} · ${slot(a.reviewer)}` }));
  }

  /** 지휘자 선택지 (D-087). 카탈로그를 그대로 읽는다 — 목록을 셸에 따로 적지 않는다. */
  orchestrators(): OrchestratorOption[] {
    return orchestratorOptions(loadEngines());
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
      ...(this.jev ? { jev: this.jev } : {}),
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

  /**
   * 현재 폴더와 최근 폴더마다 세션을 묶는다. 같은 폴더가 두 번 나오면 세션이 두 묶음에 겹쳐 보인다 — 실제 경로로 합친다.
   * 순서는 이름순이다 — 최근 목록(MRU)은 클릭마다 바뀌므로 사이드바가 따라 뛰지 않게 쓰지 않는다. 현재 폴더는 강조로만 드러난다.
   */
  conversations(): ConversationTree {
    const { current, recent } = this.projects();
    const projects: ProjectInfo[] = [];
    for (const p of [current, ...recent]) if (!projects.some((q) => samePath(q.dir, p.dir))) projects.push(p);
    projects.sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir));
    return {
      projects: projects.map((project) => ({ project, sessions: listSessions(project.dir, 'project') })),
      scratch: listScratchSessions().sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
    };
  }

  startConversation(kind: SessionKind): SessionView {
    const { dir, id } = prepareSession(kind, this.workdir);
    return this.attach(kind, dir, id);
  }

  /** project 세션은 그 폴더로 **먼저 옮긴다** — 화면의 폴더가 세션의 폴더다. 스크래치는 스크래치 뿌리 안이어야 한다. */
  openConversation(kind: SessionKind, dir: string, id: string): SessionView {
    if (kind === 'project') {
      this.useProject(dir);
    } else if (!insideScratchRoot(dir)) {
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
      // spend 는 Budget 을 되살리는 재료다 — 화면은 마지막 기록으로 버튼을 고르므로 싣지 않는다 (D-054).
      records: s.records().filter((r) => r.kind !== 'spend'),
      broken: readSessionLog(s.dir, s.id).broken,
      budget: this.sessionBudget(s.dir, s.id).summary(),
      appBudget: this.appBudgetSummary(),
      interrupted: s.interrupted,
      cancellable: s.cancellable,
      progress: s.state === 'working' ? [...s.progress] : [],
      mode: s.mode,
      ladder: s.state === 'waiting_input' ? s.ladderOffer() : null,
      orchestrator: (() => {
        // 기록의 모델이 카탈로그에서 빠졌어도 화면은 열린다 — 지휘자를 부르는 호출이 그때 던진다.
        try {
          const slot = s.conductor();
          return { ...s.orchestrator, engine: slot.engine, line: s.orchestratorNotice ? `${slotLine(slot)} · ${s.orchestratorNotice}` : slotLine(slot) };
        } catch (error) {
          return { ...s.orchestrator, engine: '', line: `지휘자를 띄울 수 없다: ${error instanceof Error ? error.message : String(error)}` };
        }
      })(),
      stepsPending: s.stepsPending,
      scaffoldPending: s.scaffoldPending,
      runPending: s.runPending,
      gitInitOffered: s.gitInitOffered,
      ...(s.name ? { name: s.name } : {}),
      external: foreignHold(s.dir, s.id),
      ...(() => {
        const meta = readSessionMeta(s.dir, s.id);
        return { ended: meta.endedAt !== undefined, archived: meta.archivedAt !== undefined };
      })(),
      role: s.role,
    };
  }

  /** `write` — 쓰기 위임으로 보낸다 (H2). 클릭 없이 쓰기로 시작하는 것은 auto 의 쓰기 행 · git 폴더 · 미커밋 없음뿐이다 (D-086). */
  async converse(text: string, write = false): Promise<SessionView> {
    await this.running((s) => s.send(text, { write }));
    return this.conversation();
  }

  async conversePlanAs(taskId: string): Promise<SessionView> {
    await this.running((s) => s.planAs(taskId));
    return this.conversation();
  }

  /** 선 카드의 행을 바꾼다 — 거절과 새 배정이 한 호출이다. 쓰기 위임은 원 카드에서 이어받는다. */
  async converseReplan(taskId: string): Promise<SessionView> {
    await this.running((s) => s.replan(taskId));
    return this.conversation();
  }

  /** 마지막 메시지를 읽기 전용 1슬롯이 코드를 읽고 답한다 (D-083). 엔진을 부르므로 `running` 으로 돈다 — 취소(D-066)가 같은 통로로 붙는다. */
  async converseRead(): Promise<SessionView> {
    await this.running((s) => s.readAnswer());
    return this.conversation();
  }

  async converseApprove(payload: { verify: readonly string[]; write: boolean }): Promise<SessionView> {
    await this.running((s) => s.approve(payload));
    return this.conversation();
  }

  /**
   * 도는 위임을 취소한다 (D-066). 다시 연 화면(D-063)도 같은 `live` 객체에 붙어 있으므로 여기서 멈출 수 있다.
   * 엔진이 내려가고 결과 기록이 붙을 때까지 기다린 뒤 그 뷰를 돌려준다 — 화면이 `working` 인 뷰를 붙잡고 있지 않게.
   * 취소할 위임이 없으면(이미 끝났거나 직접 답 중) 던지지 않고 지금 뷰를 돌려준다 — 버튼과 완료가 겹친 정상 경합이다.
   */
  async converseCancel(): Promise<SessionView> {
    const s = this.requireConversation();
    if (s.cancel()) await this.liveCalls.get(`${s.dir}::${s.id}`)?.catch(() => undefined);
    return this.conversation();
  }

  /**
   * 앱 실행 카드를 고른 터미널 창에서 연다 (D-091) — 이 클릭이 승인(H8)이다. 터미널은 목록의 id 로만 받는다(D-021). 경로·argv 는 화면에서 받지 않고
   * 세션이 카드에서 꺼낸다. `launch` 는 테스트가 실제 터미널을 띄우지 않게 바꿔 끼우는 자리다.
   */
  async converseRun(
    terminal: unknown = 'default',
    launch: (dir: string, argv: readonly string[], terminal: TerminalId) => Promise<string> = (dir, argv, t) => runInTerminal(dir, argv, t),
  ): Promise<SessionView> {
    if (!isTerminalId(terminal)) throw new Error(`모르는 터미널: ${String(terminal)}`);
    await this.running((s) => s.launchRun((dir, argv) => launch(dir, argv, terminal)));
    return this.conversation();
  }

  /** 스캐폴딩 폴더에 git init + 첫 커밋 (D-088). 명령을 돌리므로 `running` 으로 돈다 — 이 클릭이 승인이다. */
  async converseGitInit(): Promise<SessionView> {
    await this.running((s) => s.initGit());
    return this.conversation();
  }

  /** 승인 방식을 바꾼다 (D-064). 엔진을 부르지 않으므로 `live` 에 두지 않는다 — 도는 세션에도 바로 붙는다. */
  converseMode(mode: ApprovalMode): SessionView {
    this.recording((s) => s.setMode(mode));
    return this.conversation();
  }

  /** 지휘자 모델·effort 를 바꾼다 (D-087). 엔진을 부르지 않으므로 `live` 에 두지 않는다 — 도는 호출은 시작한 지휘자로 끝난다. */
  converseOrchestrator(choice: OrchestratorChoice): SessionView {
    this.recording((s) => s.setOrchestrator(choice));
    return this.conversation();
  }

  /** 마지막 메시지를 지휘자가 단계로 나눈 계획으로 세운다 (D-087). 지휘자를 부르므로 `running` 으로 돈다. 시작은 카드의 승인이다. */
  async converseSteps(): Promise<SessionView> {
    await this.running((s) => s.planSteps());
    return this.conversation();
  }

  /** 사다리 다음 단계로 배정 카드를 세운다 (D-068). 엔진을 부르지 않고 시작하지도 않으므로 `live` 에 두지 않는다 — 승인은 카드에서다. */
  converseEscalate(): SessionView {
    this.recording((s) => s.escalate());
    return this.conversation();
  }

  /** 대화를 비운다 (D-092). 기록만 붙이므로 `recording` 이다 — 도는 위임 중에는 Core 가 막고, 선 카드는 거절로 남는다. */
  converseClear(): SessionView {
    this.recording((s) => s.clear());
    return this.conversation();
  }

  converseReject(): SessionView {
    this.recording((s) => s.reject());
    return this.conversation();
  }

  /** 이름을 붙인다 (D-085). 빈 문자열은 지운다. 아는 다른 세션과 겹치면 던진다 — 이름으로 찾을 때 둘이 나오면 안 된다. */
  converseRename(name: string): SessionView {
    const s = this.requireConversation();
    assertNameFree(this.workdir, name.trim(), s);
    this.recording((t) => t.rename(name));
    return this.conversation();
  }

  /**
   * 역할을 바꾼다 (D-090) — 오케스트레이터로 지정하거나 워커로 되돌린다. 표시뿐이라 엔진·메시지 경로는 그대로다.
   * 같은 폴더에 다른 오케스트레이터가 있으면 던진다 — 이름 겹침(`converseRename`)과 같은 자리에서 본다. 스크래치는 Core 가 막는다.
   */
  converseRole(role: SessionRole): SessionView {
    const s = this.requireConversation();
    // 오케스트레이터를 늘리는 쓰기는 폴더의 역할 잠금 안에서 다시 검사하고 쓴다 — 다른 프로세스와 같은 순간 검사를 지나지 않게.
    if (role === 'orchestrator' && s.kind === 'project') {
      withRoleLock(s.dir, () => {
        assertOrchestratorFree(s);
        this.recording((t) => t.setRole(role));
      });
    } else this.recording((t) => t.setRole(role));
    return this.conversation();
  }

  /**
   * 엔진을 부르지 않고 기록만 붙이는 호출 (D-085). 다른 프로세스가 쥐었으면 거절한다 — 그쪽이 같은 파일에 쓰는 중이다.
   * 도는 우리 위임(`live`)에는 그대로 붙는다(방식 변경은 도는 중에도 된다, D-064). 끝나면 카드가 섰는지에 맞춰 점유를 맞춘다.
   * 쓰는 동안 점유를 쥐고, 종료(D-089)는 쥔 **뒤에** 본다 — 검사만 하고 쓰면 그 틈에 다른 GUI 가 종료해도 기록이 붙는다.
   * 도는 위임은 이미 쥐고 있어 다시 쥐지도 놓지도 않는다 — 끝날 때 `running` 이 놓는다.
   */
  private recording(op: (s: ConversationSession) => unknown): void {
    const s = this.requireConversation();
    const key = `${s.dir}::${s.id}`;
    // 다른 곳이 쥐었으면 여기서 던진다(같은 거절 문구) — 그 점유는 건드리지 않는다.
    if (!this.live.has(key)) claimSession(s.dir, s.id, 'working', 'gui');
    try {
      assertNotEnded(s.dir, s.id);
      op(s);
    } finally {
      if (!this.live.has(key)) syncHold(s.dir, s.id, s.state === 'blocked' ? 'blocked' : null, 'gui');
    }
  }

  async converseAsk(): Promise<SessionView> {
    await this.running((s) => s.askConductor());
    return this.conversation();
  }

  /** 엔진을 부를 수 있는 호출은 끝날 때까지 `live` 에 둔다 (D-063). 한 세션에 동시에 하나뿐이다 — 상태 검사가 막는다. */
  private async running(op: (s: ConversationSession) => Promise<unknown>): Promise<void> {
    const s = this.requireConversation();
    const key = `${s.dir}::${s.id}`;
    // 도는 동안 세션을 쥔다 (D-085) — `chat`·`hs-orc session send` 가 같은 기록에 끼어 쓰지 않게. 다른 곳이 쥐었으면 여기서 던진다.
    claimSession(s.dir, s.id, 'working', 'gui');
    // 종료(D-089)는 쥔 뒤에 본다 — 종료는 점유를 쥔 채 표식을 쓴다.
    try {
      assertNotEnded(s.dir, s.id);
    } catch (error) {
      syncHold(s.dir, s.id, s.state === 'blocked' ? 'blocked' : null, 'gui');
      throw error;
    }
    this.live.set(key, s);
    let call: Promise<unknown>;
    try {
      call = op(s);
    } catch (error) {
      this.live.delete(key);
      syncHold(s.dir, s.id, s.state === 'blocked' ? 'blocked' : null, 'gui');
      throw error;
    }
    this.liveCalls.set(key, call);
    try {
      await call;
    } finally {
      if (this.live.get(key) === s) this.live.delete(key);
      if (this.liveCalls.get(key) === call) this.liveCalls.delete(key);
      // 카드가 섰으면 승인 대기로 계속 쥔다 — 다른 곳이 보내면 그 카드가 말없이 사라진다.
      syncHold(s.dir, s.id, s.state === 'blocked' ? 'blocked' : null, 'gui');
    }
  }

  /**
   * 열린 세션의 폴더에서 터미널을 연다. 경로는 화면에서 받지 않는다 — 렌더러가 임의 폴더를 열게 하지 않는다(D-021).
   * 터미널도 목록의 id 로만 받는다. `open` 은 테스트가 실제 터미널을 띄우지 않게 바꿔 끼우는 자리다.
   */
  async openSessionTerminal(
    terminal: unknown = 'default',
    open: (dir: string, terminal: TerminalId) => Promise<void> = (dir, t) => openTerminal(dir, terminalCommand(dir, undefined, undefined, t)),
  ): Promise<string> {
    if (!isTerminalId(terminal)) throw new Error(`모르는 터미널: ${String(terminal)}`);
    const { dir } = this.requireConversation();
    if (!existsSync(dir)) throw new Error(`세션 폴더가 없다: ${dir}`);
    await open(dir, terminal);
    return dir;
  }

  /**
   * 세션을 종료한다 (D-089) — 화면만 닫는 `closeConversation` 과 다르다. 이 앱이 돌리는 위임은 취소(D-066)하고 끝나기를 기다리며,
   * 선 카드는 거절로 닫은 뒤 종료 표식을 쓴다. 기록은 고치지 않는다. 다른 프로세스가 쥐었으면 거절한다 — 그 pid 에 신호를 보내지 않는다(D-085).
   * 지휘자 호출(직접 답·요약·단계 계획)은 취소할 수 없어 거절한다 — 끝난 뒤 다시 누른다. 열린 세션이면 그 뷰를 돌려준다.
   */
  async endSession(ref: SessionRef): Promise<SessionView | null> {
    const { dir, id } = this.target(ref);
    const key = `${dir}::${id}`;
    const other = foreignHold(dir, id);
    if (other) throw new Error(`종료하지 않는다 — ${busyMessage(other, lockPath(dir, id))}`);
    const live = this.live.get(key);
    if (live) {
      if (!live.cancel()) throw new Error('지휘자 호출이 도는 중이라 취소할 수 없다 — 끝난 뒤 종료한다.');
      await this.liveCalls.get(key)?.catch(() => undefined);
    }
    // 쥔 채 카드를 닫고 표식을 쓴다 — `session send`·`chat` 은 쥔 뒤에 종료를 본다. 그 틈에 남이 먼저 쥐었으면 여기서 던진다.
    claimSession(dir, id, 'working', 'gui');
    try {
      const open = this.openSession(dir, id);
      if (open?.state === 'blocked') open.reject();
      setEnded(dir, id, true);
    } finally {
      releaseSession(dir, id);
    }
    return this.openView(dir, id);
  }

  /** 종료를 푼다 (D-089). 표식만 지운다 — 기록은 종료 전 그대로라 이어 쓸 수 있다. */
  reopenSession(ref: SessionRef): SessionView | null {
    const { dir, id, kind } = this.target(ref);
    // 종료한 오케스트레이터는 0~1 에 세지 않는다 (D-090) — 그 사이 새 오케스트레이터가 섰으면 다시 열어 둘이 되지 않게 막는다.
    // 역할 잠금 안에서 검사하고 표식을 지운다 — 다른 프로세스의 지정·만들기와 같은 순간 검사를 지나지 않게.
    if (kind === 'project' && sessionRole(readSessionLog(dir, id).records) === 'orchestrator') {
      withRoleLock(dir, () => {
        assertOrchestratorFree({ dir, id });
        setEnded(dir, id, false);
      });
    } else setEnded(dir, id, false);
    return this.openView(dir, id);
  }

  /** 보관하거나(`on`) 복원한다 (D-089). 숨김일 뿐 기록·대화는 그대로다. 다른 프로세스가 쥔 세션은 보관하지 않는다. */
  archiveSession(ref: SessionRef, on: boolean): SessionView | null {
    const { dir, id } = this.target(ref);
    const other = on ? foreignHold(dir, id) : null;
    if (other) throw new Error(`보관하지 않는다 — ${busyMessage(other, lockPath(dir, id))}`);
    setArchived(dir, id, on);
    return this.openView(dir, id);
  }

  /** 화면이 넘긴 세션을 확인한다 — id 는 파일 이름이 되고, 기록이 있어야 세션이다. 첫 메시지 전 세션은 목록에도 없다. */
  private target(ref: SessionRef): SessionRef {
    if (!SESSION_ID.test(ref.id)) throw new Error(`세션 id 모양이 아니다: ${ref.id}`);
    if (ref.kind === 'scratch' && !insideScratchRoot(ref.dir)) throw new Error(`스크래치 뿌리 밖의 폴더다: ${ref.dir}`);
    if (readSessionLog(ref.dir, ref.id).records.length === 0) {
      throw new Error('첫 메시지 전의 빈 세션이다 — 종료·보관할 기록이 없다. 세션 닫기를 쓴다.');
    }
    return ref;
  }

  private openSession(dir: string, id: string): ConversationSession | null {
    const s = this.session;
    return s && s.id === id && samePath(s.dir, dir) ? s : null;
  }

  private openView(dir: string, id: string): SessionView | null {
    return this.openSession(dir, id) ? this.conversation() : null;
  }

  closeConversation(): void {
    this.leave();
    this.session = null;
  }

  /**
   * 화면에서 내려놓는 세션의 점유를 놓는다 (D-085). 도는 것(`live`)은 그대로 — 끝날 때 `running` 이 놓는다.
   * 선 카드는 메모리에만 있어 다시 열면 되살리지 않으므로(session.ts 생성자) 승인 대기 점유도 여기서 끝난다.
   */
  private leave(): void {
    const s = this.session;
    if (s && !this.live.has(`${s.dir}::${s.id}`)) releaseSession(s.dir, s.id);
  }

  /**
   * 열린 세션. 다른 프로세스가 그 사이 기록을 붙였으면(D-085 — `hs-orc session send` 등) 들고 있던 객체는 턴 번호·Budget 이 낡았다 —
   * 디스크로 새로 조립한다. 도는 중인 우리 세션은 우리가 쓰는 중이라 보지 않는다.
   */
  private requireConversation(): ConversationSession {
    const s = this.session;
    if (!s) throw new Error('열린 세션이 없다.');
    const key = `${s.dir}::${s.id}`;
    if (this.live.has(key) || !s.isStale()) return s;
    this.session = this.assemble(s.kind, s.dir, s.id);
    return this.session;
  }

  private attach(kind: SessionKind, dir: string, id: string): SessionView {
    if (this.session && !(this.session.dir === dir && this.session.id === id)) this.leave();
    this.session = this.live.get(`${dir}::${id}`) ?? this.assemble(kind, dir, id);
    return this.conversation();
  }

  /**
   * 디스크에서 세션을 새로 조립한다. Budget 도 기록에서 다시 되살린다 (D-085) — 닫아 둔 사이 다른 프로세스가 쓴 지출이
   * 캐시에 없다. 우리 지출도 전부 `spend` 기록에 있으므로 다시 되살려도 잃는 것이 없다. 도는 세션(`live`)은 여기 오지 않는다.
   */
  private assemble(kind: SessionKind, dir: string, id: string): ConversationSession {
    this.sessionBudgets.delete(`${dir}::${id}`);
    return assembleSession({
      kind,
      dir,
      id,
      budget: this.sessionBudget(dir, id),
      journal: this.journal,
      ...(this.jev ? { classifier: this.jev } : {}),
      ...(this.execute ? { execute: this.execute } : {}),
      // 터미널 창을 여는 것은 GUI 뿐이다 (D-091) — chat·`session send` 는 실행 카드를 세우지 않는다.
      runCards: true,
    });
  }
}
