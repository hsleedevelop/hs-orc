/**
 * 대화 세션 (SPEC §6.4, D-031). **헤드리스다** — 셸은 이것을 부르고 기록을 그린다.
 * 셸마다 따로 두면 같은 메시지에 셸마다 다르게 답한다 (D-026 전례).
 *
 * 메시지 1건: 기록 → 라우팅(결정론 파이프라인 그대로) → 배정이면 승인 대기(`blocked`),
 * 아니면 지휘자 직접 답. 다음 위임을 **스스로 시작하지 않는다** (D-015).
 * 사람이 부르면 지휘자가 요청을 단계로 나눈 계획을 세우고, 승인하면 단계마다 위임이 차례로 돈다 (D-087).
 */
import type { RowClassifier } from '../adapters/jev.ts';
import type { Engines } from '../data/engines.ts';
import type { Matrix } from '../data/matrix.ts';
import { isApprovalMode, loadLimits, type ApprovalMode, type OrchestratorChoice } from '../data/limits.ts';
import type { AssignmentPlan } from './assign.ts';
import { dirtyWriteRisk, evaluateApproval, evaluateRead, nonGitWriteRefusal, readOnlyWriteRow, scaffoldAsk, type ApprovalCheck, type AskReason } from './approval.ts';
import { loadScaffolders, type Scaffolder, type Scaffolders } from '../data/scaffolders.ts';
import { GIT_INIT_COMMANDS, allowedArgv, commandLine, detectScaffold, folderEntries, runArgv, runSequence, type CommandRunner, type ScaffoldRequest } from './scaffold.ts';
import type { Budget, BudgetMark } from './budget.ts';
import {
  LEGACY_ORCHESTRATOR,
  StepsError,
  buildStepPrompt,
  buildStepsPrompt,
  buildStepsSummaryPrompt,
  buildSummaryPrompt,
  conductorSlot,
  defaultOrchestrator,
  directAnswer,
  nextSuggestion,
  parseSteps,
} from './conductor.ts';
import type { ResolvedSlot } from './assign.ts';
import { topoSort, type GraphNode } from './modes/graph.ts';
import { buildContext, type ContextLimits } from './context.ts';
import { appendDecision } from './decision-log.ts';
import { firstLine, unexecutedLine } from './decide.ts';
import { delegate, type Delegated } from './delegate.ts';
import { estimateUsd, type EngineReport, type SlotExecutor } from './executor.ts';
import type { Journal } from './journal.ts';
import { LadderError, planLadder, requestStage, type EscalationStage } from './ladder.ts';
import { route as routeTask, routeWithFallback } from './pipeline.ts';
import { buildReadPrompt, readerSlot, slotLine } from './reader.ts';
import { readUnclassifiedWithLegacy, recordUnclassified, suggestRows, unclassifiedLogPath } from './unclassified.ts';
import { markStateOrigin } from './project-state.ts';
import {
  appendRecord,
  isSessionRole,
  isSettingRecord,
  readSessionLog,
  sessionName,
  sessionRole,
  transcriptPath,
  type LadderRecord,
  type SessionKind,
  type SessionRole,
  type SessionState,
  type TranscriptEntry,
  type TranscriptRecord,
} from './transcript.ts';

/**
 * 세션 이름 모양 (D-085). 영문자로 시작해 id(`MMDD-HHMM-xxx`, 숫자로 시작)와 겹칠 수 없다 —
 * `hs-orc session send <id|이름>` 이 같은 자리에서 둘을 받는다.
 */
export const SESSION_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/;

export class SessionStateError extends Error {
  override name = 'SessionStateError';
}

export interface SessionDeps {
  readonly matrix: Matrix;
  readonly catalog: Engines;
  readonly kind: SessionKind;
  readonly dir: string;
  readonly id: string;
  /** 이 세션만의 누적 상한이다 (D-032 A2) — 셸이 세션마다 다른 Budget 을 넘긴다. 앱 전체 합은 표시만 한다. */
  readonly budget: Budget;
  readonly journal: Journal;
  /** 직접 답·요약 전용. 지휘자 슬롯이 reviewer 자리라 쓰기는 어차피 붙지 않는다. */
  readonly conduct: SlotExecutor;
  /** 위임 실행기. 쓰기 여부는 승인 때 정해진다 (D-025). */
  readonly executorFor: (write: boolean) => SlotExecutor;
  readonly now?: () => Date;
  /**
   * 주면 "위임할지·어느 행" 을 Jev 가 판정한다 (D-065). 지휘자는 직접 답만 한다 — Jev 가 답했으면 지휘자의 SUGGEST 는 쓰지 않는다.
   * 없으면(끔·테스트) 옛 경로 그대로다: 규칙 → 지휘자 SUGGEST.
   */
  readonly classifier?: RowClassifier;
  /** 없으면 `loadLimits()` 값 (SPEC §6.4.3). */
  readonly context?: ContextLimits;
  /** 기록이 빈 새 세션의 시작 방식 (D-064 결정 8). 없으면 `limits.json` 의 `approvalMode`. 기록에 방식이 있으면 그것이 이긴다. */
  readonly approvalMode?: ApprovalMode;
  /**
   * false 면 이 객체는 세션 방식과 무관하게 위임·읽기 답을 자동으로 시작하지 않는다 — 판정을 manual 로 한다 (D-085 결정 5).
   * `hs-orc session send` 는 `--run` 이 없으면 이것을 끈다. 기록된 방식은 바꾸지 않는다(GUI·chat 에서는 그대로 auto 다). 기본 true.
   */
  readonly autoStart?: boolean;
  /** project 폴더가 git 작업 트리인가 (D-074). 없으면 git 으로 본다 — 조립(`assembleSession`)이 `repoRoot` 로 정해 넘긴다. */
  readonly inGit?: boolean;
  /** 기록이 빈 새 세션의 지휘자 (D-087). 없으면 `limits.json` 의 기본. 기록에 지휘자가 있으면 그것이 이긴다. */
  readonly orchestrator?: OrchestratorChoice;
  /** 쓰기가 본질인 행 (D-086). 없으면 `limits.json` 의 `writeRows`. */
  readonly writeRows?: readonly string[];
  /**
   * 폴더의 미커밋 파일 (D-086 H5) — 조립이 `git status --porcelain` 으로 넘긴다. `null`·예외는 확인 실패라 H5 로 묻는다(fail-closed).
   * 주지 않으면(테스트) 깨끗한 것으로 본다.
   */
  readonly dirtyFiles?: () => readonly string[] | null;
  /**
   * 폴더가 지금 git 작업 트리인가 (D-088). 주면 `inGit` 대신 카드를 세울 때마다 다시 본다 — 스캐폴더·사람이 `git init` 한 뒤
   * 같은 세션의 다음 쓰기 행이 H6 없이 쓰기로 선다(D-073 사실 9 의 해소). 조립이 `repoRoot` 로 넘긴다.
   */
  readonly gitProbe?: () => boolean;
  /** 스캐폴딩 허용 목록 (D-088). 부를 때마다 읽는다 — 실행 직전 재검사가 지금 파일과 대조되게 한다(PR #118 리뷰). 없으면 `data/scaffolders.json`. */
  readonly scaffolders?: () => Scaffolders;
  /** 스캐폴더·git init 실행기 (D-088). 없으면 셸 없는 spawn(`runArgv`). 테스트가 가짜를 넣는다 — 네트워크를 부르지 않는다. */
  readonly runCommand?: CommandRunner;
}

/** `plan.reason` 에 남는 출처 — 행을 고른 것이 지휘자다. `수동 지정` 이면 사람이 고른 것으로 적힌다 (`pipeline.ts` reasonLabel). */
const SUGGESTED_LABEL = '지휘자 제안';

/**
 * 스캐폴더는 위임으로 돌지 않는다 — codex 샌드박스는 네트워크·홈 쓰기를, claude 쓰기 모드는 셸을 막는다 (D-073). 대신 hs-orc 가
 * 빈 폴더에서 허용 목록의 스캐폴더를 직접 실행하는 카드를 세운다 (D-088 — D-074 B1 번복).
 */
export const SCAFFOLD_GUIDE = 'git 아닌 폴더 · 쓰기 위임 — 새 프로젝트면 빈 폴더에서 "next 앱 init 해줘" 처럼 프레임워크를 넣어 보내면 hs-orc 가 스캐폴더를 직접 실행하는 카드가 선다. 기존 파일이면 git init 한 뒤 다시 보낸다 (D-088)';

/** H6 카드를 읽기 전용으로 승인하려 할 때 (D-088). */
export const H6_BLOCKED = 'git 아닌 폴더의 쓰기 행은 읽기 전용으로 승인하지 않는다 (H6, D-088) — 파일을 하나도 못 만든다. 새 프로젝트면 빈 폴더에서 "next 앱 init 해줘" 처럼 보내 스캐폴딩 카드로, 기존 파일이면 git init 한 뒤 다시 보낸다.';

/** 끝난 뒤 기록에 남기는 폴더 맨 위 이름 수. */
const CREATED_SHOWN = 12;

/** 진행 줄 상한 (D-084) — 화면에는 끝부분만 보이므로 오래된 줄부터 버린다. */
const PROGRESS_MAX = 200;
const PROGRESS_LINE_MAX = 2000;

const why = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Pending {
  /** 사용자가 쓴 문장 그대로. 결정 로그에 이것이 남는다. */
  readonly title: string;
  readonly plan: AssignmentPlan;
  readonly reason: string;
  /** 카드가 쓰기 켠 채 섰다 — 쓰기 위임으로 보냈거나 쓰기 행이다 (H2·D-086). 자동 승인은 이 값으로 시작한다. */
  readonly write: boolean;
  /** 이 배정이 설 때 방식·기록·Budget 으로 계산한 승인 판정 (D-064). 이후 방식을 바꿔도 이 카드는 다시 판정하지 않는다 (결정 9). */
  readonly check: ApprovalCheck;
  /** 사용자가 누른 사다리 상향 배정이다 (D-068). 위임은 새 엔진 세션으로 돌고 직전 실패 근거가 프롬프트에 실린다. */
  readonly ladder?: LadderRecord;
  /** 승인한 같은 배정이 예외로 끝나 다시 세운 카드다 (D-081). 이것이 또 던지면 다시 세우지 않는다. */
  readonly retry?: boolean;
  /** git 아닌 폴더의 쓰기 행이다 (H6) — 읽기 전용 승인은 헛실행이라 막는다 (D-088). */
  readonly readOnlyBlocked?: boolean;
}

/** 승인 대기 중인 스캐폴딩 카드 (D-088). 자동 승인 경로가 없다 — `approve()` 만 시작한다. */
interface ScaffoldPending {
  readonly scaffolder: Scaffolder;
}

/** 승인 대기 중인 단계 계획 (D-087). 배정 카드(`Pending`)와 따로 둔다 — 자동 승인·행 바꾸기·사다리가 타지 않는다. */
interface StepsPending {
  readonly title: string;
  readonly nodes: readonly GraphNode[];
  /** 쓰기 행 · git project 폴더라 쓰기로 돌 단계 (D-086). 카드의 쓰기 스위치를 켜면 이 단계들만 쓴다 — 읽기 행 단계는 끝까지 읽기 전용이다. */
  readonly writeSteps: ReadonlySet<string>;
  /** 카드가 물은 조건 — 승인 기록에 코드로 남는다. */
  readonly asked: readonly AskReason[];
  /** git 아닌 폴더의 쓰기 행 단계가 있다 (H6) — 그 단계들이 읽기 전용으로 헛돌아 승인을 막는다 (D-088). */
  readonly readOnlyBlocked: boolean;
}

/** 사다리가 다음에 올릴 단계 (D-068). 화면의 버튼과 chat `/ladder` 가 이것을 본다. */
export interface LadderOffer {
  readonly stage: EscalationStage;
  /** `②effort 상향` */
  readonly label: string;
  /** 행 기본 대비 무엇이 오르나 — 카드에 서는 줄과 같다. */
  readonly changes: readonly string[];
}

/** `approve()`·자동 승인이 같이 타는 시작 경로. `by` 가 기록과 결정 로그 note 에 남는다 (D-064 결정 7). */
type ApprovedBy = 'user' | 'auto';

export class ConversationSession {
  readonly file: string;
  private readonly deps: SessionDeps;
  private turn: number;
  private stateValue: SessionState = 'waiting_input';
  private pending: Pending | null = null;
  private pendingSteps: StepsPending | null = null;
  private pendingScaffold: ScaffoldPending | null = null;
  /** 도는 위임의 취소 신호 (D-066). primary·reviewer·읽기 답(D-083) 실행 동안만 있다 — 지휘자의 요약·직접 답은 취소 대상이 아니다. */
  private delegation: AbortController | null = null;
  /** 도는(또는 마지막으로 돈) 엔진 실행의 진행 줄 (D-084). 기록에 남기지 않는다 — 화면이 "실행 중…" 아래에 보여줄 뿐이다. */
  private progressLog: string[] = [];
  /** 기록은 열 때 한 번 읽고 이후엔 append 와 함께 들고 있는다 — 메시지마다 JSONL 을 다시 읽지 않는다. */
  private readonly log: TranscriptRecord[];
  /** 지금 승인 방식 (D-064). 마지막 `mode` 기록을 재생한다 — 없으면 새 세션은 `limits.json` 기본값, 옛 세션은 `manual`. */
  private modeValue: ApprovalMode;
  /** 지금 지휘자 (D-087). 마지막 `orchestrator` 기록을 재생한다 — 없으면 새 세션은 기본값, 옛 세션은 옛 지휘자(Haiku·low). */
  private orchestratorValue: OrchestratorChoice;
  /** 기록된 지휘자를 지금 카탈로그로 띄울 수 없어 기본 지휘자로 연 사유 (D-087). 셸이 세션을 열 때 알린다. */
  private orchestratorFallback: string | null = null;
  private originMarked = false;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.file = transcriptPath(deps.dir, deps.id);
    // 다시 열면 턴 번호를 이어 간다. 끝에 승인 안 된 배정이 남아 있어도 **되살리지 않는다** —
    // 그 사이 비용·폴더가 바뀌었을 수 있다. 화면은 그 카드를 보여주되 승인 버튼은 없다.
    this.log = readSessionLog(deps.dir, deps.id).records;
    this.turn = this.log.reduce((max, r) => Math.max(max, r.turn), 0);
    const recorded = this.log.findLast((r) => r.kind === 'mode');
    // 첫 메시지 전 세션 — 설정 줄만 있다. 이름(D-085)·역할(D-090, `hs-orc session new`)만 붙인 세션도 새 세션이라 기본값을 받는다.
    // 처음 구현은 지휘자를 `기록 0줄` 로만 갈라, 이름·역할만 붙인 세션을 다시 열면 옛 지휘자(Haiku·low)로 열었다.
    const fresh = this.log.every(isSettingRecord);
    // 방식이 없는 기록은 이 결정 전의 세션이다 — 조용히 자동이 되지 않게 manual 로 연다 (D-064 결정 8). 새 세션만 기본값을 받는다.
    this.modeValue =
      recorded?.kind === 'mode' && isApprovalMode(recorded.mode)
        ? recorded.mode
        : fresh
          ? (deps.approvalMode ?? loadLimits().approvalMode)
          : 'manual';
    const orchestrator = this.log.findLast((r) => r.kind === 'orchestrator');
    this.orchestratorValue =
      orchestrator?.kind === 'orchestrator'
        ? { model: orchestrator.model, effort: orchestrator.effort }
        : fresh
          ? (deps.orchestrator ?? defaultOrchestrator())
          : LEGACY_ORCHESTRATOR;
    // 기록의 모델이 카탈로그에서 빠졌으면(이름 변경·삭제) 세션을 못 여는 대신 기본 지휘자로 열고 그 사실을 남긴다.
    try {
      conductorSlot(deps.catalog, this.orchestratorValue);
    } catch (error) {
      const recorded = `${this.orchestratorValue.model}·${this.orchestratorValue.effort}`;
      this.orchestratorValue = defaultOrchestrator();
      this.orchestratorFallback = `기록된 지휘자 ${recorded} 를 띄울 수 없어 기본 지휘자 ${this.orchestratorValue.model}·${this.orchestratorValue.effort} 로 연다 — ${why(error)}`;
    }
  }

  /** 기록된 지휘자를 쓸 수 없어 기본으로 열었으면 그 안내 한 줄 (D-087). */
  get orchestratorNotice(): string | null {
    return this.orchestratorFallback;
  }

  /** 승인 대기 중인 것이 단계 계획인가 (D-087) — 셸이 묻는 답(y·w·n)을 고른다. */
  get stepsPending(): boolean {
    return this.pendingSteps !== null;
  }

  /** 승인 대기 중인 것이 스캐폴딩 카드인가 (D-088) — 셸이 묻는 답(y·n)을 고르고, `session send --run` 은 승인하지 않는다. */
  get scaffoldPending(): boolean {
    return this.pendingScaffold !== null;
  }

  /**
   * 지금 `git init` + 첫 커밋을 제안하나 (D-088) — 마지막 기록이 git 없이 끝난 스캐폴딩 성공이고 폴더가 아직 git 이 아니거나,
   * 직전 git init 이 끝나지 못했다(커밋 실패·취소 — `git init` 은 이미 됐을 수 있다). 다시 돌려도 `git init` 은 같은 저장소를 다시 잡을 뿐이다.
   */
  get gitInitOffered(): boolean {
    const last = this.lastEvent();
    if (this.stateValue !== 'waiting_input' || this.deps.kind !== 'project' || last?.kind !== 'scaffold-run') return false;
    if (last.step === 'git-init') return last.outcome !== 'ok';
    return last.git === 'offer' && !this.inGit;
  }

  /** 폴더가 git 인가 — 다시 볼 수 있으면 지금 본다(D-088), 아니면 조립 때 값, 모르면 git 으로 본다(D-074). */
  private get inGit(): boolean {
    return this.deps.gitProbe?.() ?? this.deps.inGit ?? true;
  }

  /** 허용 목록 — 부를 때마다 파일을 다시 읽는다. */
  private get scaffolders(): Scaffolders {
    return this.deps.scaffolders?.() ?? loadScaffolders();
  }

  get orchestrator(): OrchestratorChoice {
    return this.orchestratorValue;
  }

  /** 지금 지휘자 슬롯 — 직접 답·요약·단계 계획이 이것으로 돈다. 카탈로그에서 사라진 모델이면 던진다. */
  conductor(): ResolvedSlot {
    return conductorSlot(this.deps.catalog, this.orchestratorValue);
  }

  /**
   * 지휘자 모델·effort 를 바꾼다 (D-087) — `orchestrator` 기록을 남긴다. 도는 호출은 시작한 지휘자로 끝나고 다음 호출부터 적용된다.
   * 엔진·모델·effort 가 지휘자로 쓸 수 없는 조합이면 기록하지 않고 던진다. 같은 값이고 이미 기록돼 있으면 아무것도 하지 않는다.
   */
  setOrchestrator(choice: OrchestratorChoice): TranscriptRecord[] {
    conductorSlot(this.deps.catalog, choice);
    const same = choice.model === this.orchestratorValue.model && choice.effort === this.orchestratorValue.effort;
    if (same && this.log.some((r) => r.kind === 'orchestrator')) return [];
    this.orchestratorValue = { model: choice.model, effort: choice.effort };
    return [this.append({ kind: 'orchestrator', ...this.orchestratorValue })];
  }

  get mode(): ApprovalMode {
    return this.modeValue;
  }

  /** 자동 시작 판정에 쓰는 방식 — `autoStart: false` 면 manual 이다 (D-085 결정 5). */
  private get decisionMode(): ApprovalMode {
    return this.deps.autoStart === false ? 'manual' : this.modeValue;
  }

  /**
   * 승인 방식을 바꾼다 — `mode` 기록을 남긴다 (D-064 결정 8). 이미 선 카드는 자동 승인하지 않는다(결정 9): 다음 배정부터다.
   * 같은 방식이고 이미 기록돼 있으면 아무것도 하지 않는다.
   */
  setMode(mode: ApprovalMode): TranscriptRecord[] {
    if (!isApprovalMode(mode)) throw new SessionStateError(`모르는 승인 방식이다: ${String(mode)}`);
    if (mode === this.modeValue && this.modeRecorded()) return [];
    this.modeValue = mode;
    return [this.append({ kind: 'mode', mode })];
  }

  private modeRecorded(): boolean {
    return this.log.some((r) => r.kind === 'mode');
  }

  /** 첫 메시지 전에 지금 방식·지휘자를 기록으로 굳힌다 — 나중에 기본값이 바뀌어도 이 세션의 방식·지휘자는 변하지 않는다. */
  private recordModeOnce(): void {
    if (!this.modeRecorded()) this.append({ kind: 'mode', mode: this.modeValue });
    if (!this.log.some((r) => r.kind === 'orchestrator')) this.append({ kind: 'orchestrator', ...this.orchestratorValue });
  }

  get state(): SessionState {
    return this.stateValue;
  }
  get kind(): SessionKind {
    return this.deps.kind;
  }
  get dir(): string {
    return this.deps.dir;
  }
  get id(): string {
    return this.deps.id;
  }

  private get contextLimits(): ContextLimits {
    return this.deps.context ?? loadLimits();
  }

  records(): TranscriptRecord[] {
    return [...this.log];
  }

  /** 엔진 진행 줄 (D-084). 위임·읽기 답이 시작할 때 비우고, 끝난 뒤에는 다음 시작까지 남는다. */
  get progress(): readonly string[] {
    return this.progressLog;
  }

  /**
   * 실행기를 감싸 진행 줄을 모은다 (D-084). 슬롯마다 머리줄을 하나 달아 primary·reviewer 를 구분한다.
   * 줄 수·줄 길이를 잘라 둔다 — 화면이 400ms 마다 뷰를 다시 읽는다.
   */
  private tapProgress(execute: SlotExecutor, role: boolean): SlotExecutor {
    this.progressLog = [];
    return (slot, prompt, options) => {
      this.pushProgress(`── ${role ? `${slot.role} ` : ''}${slotLine(slot)}`);
      return execute(slot, prompt, { ...options, onProgress: (line) => this.pushProgress(line) });
    };
  }

  private pushProgress(line: string): void {
    this.progressLog.push(line.length > PROGRESS_LINE_MAX ? `${line.slice(0, PROGRESS_LINE_MAX)}…` : line);
    if (this.progressLog.length > PROGRESS_MAX) this.progressLog.splice(0, this.progressLog.length - PROGRESS_MAX);
  }

  /** 지금 취소할 수 있는 위임이 도는가 — primary·reviewer 실행 중이고 아직 취소를 보내지 않았다 (D-066). */
  get cancellable(): boolean {
    return this.delegation !== null && !this.delegation.signal.aborted;
  }

  /**
   * 도는 위임을 취소한다 (D-066). 엔진 프로세스 그룹을 종료하라고 알리고 **곧바로 돌아온다** — 결과 기록은
   * 돌던 `approve()` 가 끝나며 붙인다(`cancelled`). 세션은 그 뒤 입력 대기다. 취소할 위임이 없으면 false.
   */
  cancel(): boolean {
    if (!this.cancellable) return false;
    this.delegation?.abort();
    return true;
  }

  /**
   * 위임 도중 앱이 끊겼다 — 승인 뒤에 결과도 오류도 없다. 화면은 "결과가 기록되지 않았다" 를 띄운다.
   * 지금 돌고 있는 위임은 끊긴 것이 아니다.
   */
  get interrupted(): boolean {
    if (this.stateValue === 'working') return false;
    const last = this.lastEvent();
    return last?.kind === 'approval' && last.approved;
  }

  /**
   * `write` — 이 메시지를 쓰기 위임으로 보낸다 (H2). 카드가 쓰기 스위치를 켠 채 선다. 자동 승인이 쓰기로 시작하는 것은
   * `auto` 의 쓰기 행 · git 폴더 · 미커밋 변경 없음뿐이다 (D-086) — 나머지 쓰기는 카드에서 묻는다.
   */
  async send(message: string, options: { readonly write?: boolean } = {}): Promise<TranscriptRecord[]> {
    if (this.stateValue !== 'blocked') this.require('waiting_input', '메시지 전송');
    const text = message.trim();
    if (!text) return [];
    const write = options.write === true;
    if (write && this.deps.kind === 'scratch') throw new SessionStateError('스크래치 세션은 쓰기를 켤 수 없다 (SPEC §6.4.1).');
    // 선 카드가 있는 채 새 메시지가 오면 그 배정은 거절로 남기고 새 메시지를 처리한다 (D-064 결정 3).
    // 위임을 시작하지 않는 쪽으로만 기운다 — 사용자가 승인 없이 다음으로 넘어간 것이다.
    const declined = this.stateValue === 'blocked' ? this.reject() : [];
    // require() 를 지난 뒤, 첫 await 전에 바로 working 으로 바꾼다 — 겹쳐 들어온 두 번째 호출이
    // 같은 require() 를 통과해 턴을 두 번 올리는 것을 막는다 (final-review #2).
    this.stateValue = 'working';
    this.turn += 1;
    let user: TranscriptRecord;
    try {
      this.recordModeOnce();
      user = this.append({ kind: 'user', text });
    } catch (error) {
      // 기록 자체가 안 됐다 — 화면에 남길 곳(트랜스크립트)이 없으니 에러 레코드로 삼키지 않고
      // 턴·상태를 되돌려 던진다. GUI 가 이 예외를 보여준다.
      this.turn -= 1;
      this.stateValue = 'waiting_input';
      throw error;
    }
    return [...declined, user, ...(await this.route(text, undefined, undefined, write))];
  }

  /** 제안된 행(또는 사용자가 고른 행)으로 **마지막 메시지**의 배정을 받는다. 새 메시지를 만들지 않는다. */
  async planAs(taskId: string, options: { readonly write?: boolean } = {}): Promise<TranscriptRecord[]> {
    this.require('waiting_input', '행 지정');
    const write = options.write === true;
    if (write && this.deps.kind === 'scratch') throw new SessionStateError('스크래치 세션은 쓰기를 켤 수 없다 (SPEC §6.4.1).');
    const last = this.records().findLast((r) => r.kind === 'user');
    if (last?.kind !== 'user') throw new SessionStateError('배정할 메시지가 없다.');
    // 마지막 기록이 그 행을 제안한 직접 답이면 고른 것은 지휘자다 — 카드 합치기(D-064) 전 기록을 다시 열었을 때의 경로다.
    const tail = this.lastEvent();
    const suggested = tail?.kind === 'direct' && tail.suggest === taskId;
    // send() 와 같은 이유로 첫 await 전에 바로 바꾼다 (final-review #2).
    this.stateValue = 'working';
    this.recordModeOnce();
    return this.route(last.text, taskId, suggested ? SUGGESTED_LABEL : undefined, write);
  }

  /**
   * 선 카드의 행을 바꾼다 — 그 카드를 거절하고 같은 메시지를 고른 행으로 다시 받는다. 원 카드의 쓰기 위임은 이어받는다.
   * GUI 가 거절과 행 지정을 따로 부르면 거절 뒤에 고른 값을 다시 읽다가 되돌아간 옛 행으로 카드를 세운다.
   */
  async replan(taskId: string): Promise<TranscriptRecord[]> {
    this.require('blocked', '행 바꾸기');
    const write = this.pending?.write === true;
    const rejected = this.reject();
    return [...rejected, ...(await this.planAs(taskId, { write }))];
  }

  /**
   * 마지막 기록 — 설정 줄(`SETTING_KINDS` — 이름 · 승인 방식 · 지휘자 · 역할 · 비용)은 대화의 흐름이 아니라 건너뛴다. 끊김·지휘자 제안 판정이
   * 설정을 바꿨다고 바뀌면 안 된다(옛 기록에서 지휘자를 바꾼 뒤 제안 행을 누르면 H1 이 빠지던 것). 비용 줄은 직접 답 **뒤에** 붙으므로
   * 건너뛰지 않으면 옛 기록(제안 직답 + 비용)의 제안 행이 `수동 지정` 으로 선다. 셸의 `lastEvent`(transcript-lines.ts)·목록 상태와 같은 목록이다.
   */
  private lastEvent(): TranscriptRecord | undefined {
    return this.log.findLast((r) => !isSettingRecord(r));
  }

  /**
   * 다른 프로세스가 이 세션의 기록에 덧붙였다 (D-085) — 들고 있는 기록·턴 번호·Budget 이 낡았다. 이대로 쓰면 턴이 겹친다.
   * 셸은 새로 조립하거나(GUI) 다시 열라고 알린다(chat). 엔진이 도는 동안은 우리가 쓰는 중이라 보지 않는다.
   */
  isStale(): boolean {
    return this.stateValue !== 'working' && readSessionLog(this.deps.dir, this.deps.id).records.length !== this.log.length;
  }

  /** 역할 (D-090). 마지막 `role` 기록, 없으면 `worker`. */
  get role(): SessionRole {
    return sessionRole(this.log);
  }

  /**
   * 역할을 바꾼다 (D-090) — `role` 기록을 남긴다. 표시뿐이라 메시지 경로는 그대로다. 프로젝트당 오케스트레이터 0~1 은
   * 모든 세션을 아는 셸이 먼저 본다 — Core 는 스크래치만 막는다(프로젝트가 없다). 같은 역할이고 이미 기록돼 있으면 아무것도 하지 않는다 —
   * 기록이 없는 `worker` 에 `worker` 를 주면 남긴다(`hs-orc session new` 는 이 줄로 세션 파일을 만든다).
   */
  setRole(role: SessionRole): TranscriptRecord[] {
    if (!isSessionRole(role)) throw new SessionStateError(`모르는 역할이다: ${String(role)} — worker · orchestrator`);
    if (role === 'orchestrator' && this.deps.kind === 'scratch') {
      throw new SessionStateError('스크래치 세션은 오케스트레이터로 지정하지 않는다 — 프로젝트가 없다 (D-090).');
    }
    if (role === this.role && this.log.some((r) => r.kind === 'role')) return [];
    return [this.append({ kind: 'role', role })];
  }

  /** 붙인 이름 (D-085). 없으면 undefined. */
  get name(): string | undefined {
    return sessionName(this.log);
  }

  /**
   * 이름을 붙인다 (D-085). 빈 문자열은 지운다. 다른 세션과 겹치는지는 모든 세션을 아는 셸이 먼저 본다 —
   * Core 는 모양만 본다. 입력 대기·승인 대기 어디서든 붙일 수 있다(대화를 진행시키지 않는다).
   */
  rename(name: string): TranscriptRecord[] {
    const next = name.trim();
    if (next && !SESSION_NAME.test(next)) {
      throw new SessionStateError(`이름은 영문자로 시작하고 영문·숫자·. _ - 만 쓴다 (최대 32자): ${next}`);
    }
    if (next === (this.name ?? '')) return [];
    return [this.append({ kind: 'name', name: next })];
  }

  private append(entry: TranscriptEntry): TranscriptRecord {
    const record = { ...entry, v: 1, at: (this.deps.now?.() ?? new Date()).toISOString(), turn: this.turn } as TranscriptRecord;
    // id 로 세션을 찾는 `hs-orc session` 이 이 폴더를 알게 한다 (D-085). 객체마다 한 번 — 이 결정 전 세션도 다음 기록에서 남는다.
    if (!this.originMarked) {
      markStateOrigin(this.deps.dir);
      this.originMarked = true;
    }
    appendRecord(this.file, record);
    this.log.push(record);
    return record;
  }

  private require(state: SessionState, action: string): void {
    if (this.stateValue !== state) {
      throw new SessionStateError(`${action}은(는) ${state} 상태에서만 한다 (지금: ${this.stateValue}).`);
    }
  }

  /**
   * 라우팅이 던지면(routeWithFallback 자체 또는 그 안의 assign() 등) working 을 남기지 않는다 —
   * 에러 기록을 남기고 입력 대기로 돌아간다 (final-review #2). assigned 는 blocked 로,
   * 그 외는 answer() 가 자신의 종료 상태(direct/error → waiting_input)를 책임진다.
   */
  private async route(text: string, taskId?: string, reasonLabel?: string, write = false): Promise<TranscriptRecord[]> {
    const { matrix, catalog, dir } = this.deps;
    try {
      // 새 프로젝트 생성 요청은 분류(Jev·규칙)보다 먼저 본다 (D-088) — 위임 엔진은 스캐폴더를 못 돌린다(D-073). 결정론이고 엔진·Jev 를 부르지 않는다.
      // 행을 사람이 지정한 경로(`planAs`)는 그 지정을 따른다.
      const scaffold = taskId ? null : this.scaffoldRoute(text);
      if (scaffold?.card) return [this.stageScaffold(scaffold.card)];
      const scaffoldWhy = scaffold?.why ?? null;
      // D-033: 지휘자가 대화 맥락으로 직접 답하고 SUGGEST 로 행을 제안한다 — 맥락 없는
      // 폴백의 선택이 대화성 후속을 잘못 위임하는 일이 없다. 규칙이 놓친 메시지는 항상 직접 답으로 간다.
      const { classifier } = this.deps;
      // Jev 로 나가는 맥락은 최소로 자른다 — 외부 전송이다 (D-065). 대화 세션 맥락 상한과 따로 둔다.
      const jevContext = classifier
        ? buildContext(
            this.records(),
            { contextTurns: loadLimits().jevContextTurns, contextChars: loadLimits().jevContextChars },
            { before: this.turn },
          ).text
        : '';
      const routed = await routeWithFallback(matrix, catalog, text, {
        cwd: dir,
        classifyLlm: false,
        ...(classifier ? { jev: classifier, jevContext } : {}),
        ...(taskId ? { taskId } : {}),
        ...(reasonLabel ? { reasonLabel } : {}),
      });
      const notes = routed.fallback ? [routed.fallback.line] : [];
      if (scaffoldWhy) notes.push(`새 프로젝트 요청으로 보였지만 스캐폴딩 카드를 세우지 않았다 — ${scaffoldWhy}`);
      const result = routed.result;
      const general = routed.jev === 'general';
      if (general) notes.push(...this.countGeneral(text));
      if (result.stage !== 'assigned') {
        // GENERAL(코드를 읽어야 답하는 설명·조사)은 방식이 허락하면 읽기 전용 1슬롯이 클릭 없이 답한다 (D-083).
        // 쓰기로 보낸 메시지는 고치는 작업이다 — 읽기 답으로 돌리지 않고 행을 고르게 둔다.
        if (general && !write) {
          const check = this.readCheck();
          if (check.auto) return await this.read(text, notes, 'auto', true);
          notes.push(check.mode === 'manual' ? '코드를 읽고 답하기는 manual 이라 묻는다 — 아래 버튼 · /read' : `코드를 읽고 답하기는 묻는다 — ${check.asks.map((a) => `${a.code} ${a.text}`).join(' · ')}`);
        }
        // Jev 가 답했는데 행을 확정하지 않았으면(NONE·GENERAL·확신도 미만) 지휘자의 SUGGEST 가 그 판정을 뒤집지 못하게 한다.
        // 스캐폴딩 요청이면 지휘자는 행 대신 스캐폴딩 길을 안내한다 (D-088).
        return await this.answer(text, notes, general || routed.jev === 'none' || routed.jev === 'unsure', write, general, scaffoldWhy ? this.scaffoldPrompt(scaffoldWhy) : undefined);
      }
      const card = this.stage(text, result.plan, result.reason, notes, write);
      // 방식이 허락하면 승인 클릭 없이 시작한다 — 이 메시지가 만든 이 배정 1건만이다 (D-064 결정 2). 카드는 위에 그대로 남는다.
      return [card, ...(await this.autoApprove())];
    } catch (error) {
      this.stateValue = 'waiting_input';
      return [this.append({ kind: 'error', text: `라우팅이 끝나지 못했다: ${why(error)}` })];
    }
  }

  /**
   * 배정을 승인 대기로 세우고 `plan` 을 남긴다. 상태를 `blocked` 로 바꾼다.
   * 쓰기 행이면 git project 폴더에서 쓰기를 켠 채 선다 (D-086). 예외 재시도(`retry`)는 그 실행에 켠 값을 그대로 쓴다 —
   * 사람이 승인 때 끈 쓰기를 다시 켜지 않는다.
   */
  private stage(title: string, plan: AssignmentPlan, reason: string, notes: readonly string[], sentWrite = false, ladder?: LadderRecord, retry = false): TranscriptRecord {
    const { primary, reviewer, secondReviewer } = plan.slots;
    const { catalog, budget } = this.deps;
    const inGit = this.inGit;
    const rowWrite = this.deps.kind === 'project' && (this.deps.writeRows ?? loadLimits().writeRows).includes(plan.assignment.id);
    const write = sentWrite || (!retry && rowWrite && inGit);
    const dirty = write && inGit ? this.uncommitted() : [];
    const check = evaluateApproval({ mode: this.decisionMode, plan, reason, write, catalog, budget, records: this.log, inGit, rowWrite, dirty, ...(ladder ? { ladder: true } : {}), ...(retry ? { retry: true } : {}) });
    // manual 은 묻는 이유(`asked`)가 비므로 H4·H5·H6 을 안내 줄로 싣는다 — 어느 방식이든 카드가 같은 줄을 보인다 (D-074·D-086).
    const warnings = check.mode === 'manual'
      ? [nonGitWriteRefusal(catalog, plan, write, inGit), dirtyWriteRisk(write, dirty), readOnlyWriteRow(rowWrite, write, inGit)].flatMap((w) => (w ? [w.text] : []))
      : [];
    const guide = [...warnings, ...this.scaffoldGuide(write || rowWrite, inGit)];
    // H6 은 묻는 데서 그치지 않고 읽기 전용 승인을 막는다 (D-088) — 승인하면 읽기 전용 헛실행이 과금되며 돈다(1005-2233-dc3).
    const readOnlyBlocked = readOnlyWriteRow(rowWrite, write, inGit) !== null;
    this.pending = { title, plan, reason, write, check, ...(ladder ? { ladder } : {}), ...(retry ? { retry } : {}), ...(readOnlyBlocked ? { readOnlyBlocked } : {}) };
    this.stateValue = 'blocked';
    return this.append({
      kind: 'plan',
      taskId: plan.assignment.id,
      title: plan.assignment.task,
      reason,
      primary: `${primary.label}·${primary.effort} → ${primary.engine}/${primary.modelId}`,
      reviewer: `${reviewer.label}·${reviewer.effort} → ${reviewer.engine}/${reviewer.modelId}`,
      ...(secondReviewer ? { reviewer2: `${secondReviewer.label}·${secondReviewer.effort} → ${secondReviewer.engine}/${secondReviewer.modelId}` } : {}),
      estimateUsd: plan.cost.totalUsd,
      notes,
      ...(guide.length > 0 ? { guide } : {}),
      mode: check.mode,
      asked: check.asks,
      ...(write ? { write: true } : {}),
      ...(ladder ? { ladder } : {}),
      ...(retry ? { retry: true as const } : {}),
      ...(readOnlyBlocked ? { readOnlyBlocked: true as const } : {}),
    });
  }

  /**
   * 선 카드가 자동 승인 대상이면 시작한다. 판정은 `stage()` 가 이미 냈다. 카드가 서는 세 경로 중 route 만 부른다 —
   * 지휘자 제안 카드(`suggestedPlan`)는 H1 이라 어떤 방식에서도 사람이 누르고, 다음 제안·사다리·예외 재시도(D-081)는 카드만 세운다.
   */
  private async autoApprove(): Promise<TranscriptRecord[]> {
    if (!this.pending?.check.auto) return [];
    // 판정이 쓰기를 허락했으면(D-086) 그 쓰기로 시작한다 — 빼면 쓰기 행이 읽기 전용으로 헛돈다.
    return this.start({ write: this.pending.write }, 'auto');
  }

  /**
   * Jev GENERAL — 행이 모자라다는 신호다. CLI 와 같은 미분류 로그에 세고, 임계치를 넘은 행 추가 제안을 분류 줄 뒤에 싣는다 (D-082, D-022).
   * NONE(대화성)은 세지 않는다 — 세면 대화가 행 추가 제안으로 둔갑한다. 로그를 못 남긴 것이 답을 잃을 이유는 아니다.
   */
  private countGeneral(text: string): string[] {
    const { dir } = this.deps;
    try {
      recordUnclassified(text, unclassifiedLogPath(dir));
      return suggestRows(readUnclassifiedWithLegacy(dir)).map((s) => s.message);
    } catch (error) {
      return [`미분류 로그를 남기지 못했다: ${why(error)}`];
    }
  }

  /** 미커밋 파일. 확인하지 못했으면 `null` 이다 — 깨끗함으로 읽지 않는다 (D-086 H5 fail-closed). */
  private uncommitted(): readonly string[] | null {
    const probe = this.deps.dirtyFiles;
    if (!probe) return [];
    try {
      return probe();
    } catch {
      return null;
    }
  }

  /** 질문형 경로를 클릭 없이 돌릴지 (D-083). 판정은 `approval.ts` 한 곳이다. */
  private readCheck(): ApprovalCheck {
    const { matrix, catalog, budget } = this.deps;
    const slot = readerSlot(catalog);
    return evaluateRead({ mode: this.decisionMode, slot, catalog, budget, estimateUsd: estimateUsd(matrix, slot) });
  }

  /**
   * **마지막 메시지**를 읽기 전용 1슬롯이 코드를 읽고 답한다 (D-083) — GUI "코드를 읽고 답하기" · chat `/read`. 새 메시지를 만들지 않는다.
   * 사람이 누른 것이라 방식과 무관하게 바로 돈다 — 그 클릭이 승인이다(배정 카드의 승인과 같다). 상한 도달은 막는다 (D-030).
   */
  async readAnswer(): Promise<TranscriptRecord[]> {
    this.require('waiting_input', '읽고 답하기');
    const last = this.records().findLast((r) => r.kind === 'user');
    if (last?.kind !== 'user') throw new SessionStateError('답할 메시지가 없다.');
    // send() 와 같은 이유로 첫 await 전에 바로 바꾼다 (final-review #2).
    this.stateValue = 'working';
    this.recordModeOnce();
    return this.read(last.text, [], 'user');
  }

  /**
   * 질문형 경로 실행 (D-083). 위임이 아니다 — 배정·reviewer·증거·결정 로그 없이 답 하나를 `direct`(`read`)로 남긴다.
   * 읽기 전용은 실행기가 보장한다: 쓰기 꺼진 위임 실행기(`readOnlyArgv`) + reviewer 자리 슬롯(쓰기를 받지 못한다).
   * 위임처럼 취소할 수 있다 (D-066) — 받은 만큼만 과금한다.
   */
  private async read(text: string, notes: readonly string[], by: 'auto' | 'user', general = false): Promise<TranscriptRecord[]> {
    const { matrix, catalog, budget } = this.deps;
    this.stateValue = 'working';
    const mark = budget.mark();
    const controller = new AbortController();
    try {
      if (budget.limitReached()) {
        return [this.append({ kind: 'error', text: `누적 상한에 닿아 읽고 답하기를 시작하지 않는다 (${budget.summary()}).` })];
      }
      const slot = readerSlot(catalog);
      const context = buildContext(this.records(), this.contextLimits, { before: this.turn });
      this.delegation = controller;
      const run = await this.tapProgress(this.deps.executorFor(false), false)(slot, buildReadPrompt(context.text, text), { signal: controller.signal });
      this.delegation = null;
      const charge = budget.charge(`${slot.label}·${slot.effort}`, run.actualUsd, estimateUsd(matrix, slot), run.meteredUsd, slot.plan);
      budget.countTokens(run.usage, run.compactionUncounted);
      if (!run.ok) {
        return [this.append({ kind: 'error', text: run.cancelled ? '읽고 답하기를 취소했다 — 받은 만큼만 과금했다.' : `읽고 답하지 못했다: ${run.text || '엔진이 실패했다'}` })];
      }
      return [this.append({
        kind: 'direct',
        text: run.text.trim(),
        suggest: null,
        cost: `$${charge.usd.toFixed(4)} ${charge.source}`,
        notes,
        ...(general ? { general: true as const } : {}),
        read: { slot: slotLine(slot), by },
        ...(context.cut ? { cut: context.cut } : {}),
        ...(run.cacheWrite ? { cacheWrite: run.cacheWrite } : {}),
      })];
    } catch (error) {
      return [this.append({ kind: 'error', text: `읽고 답하지 못했다: ${why(error)}` })];
    } finally {
      this.delegation = null;
      this.stateValue = 'waiting_input';
      this.recordSpend(mark);
    }
  }

  /**
   * 스캐폴딩 카드를 세울 수 없는 이유 (D-088). null 이면 세운다. 규칙: project 세션 · 허용 목록에서 정확히 하나 · 폴더가 비어 있다
   * (`ignore` 의 이름만 있으면 빈 것). 비어 있지 않으면 세우지 않는다 — 스캐폴더가 덮을 수 있고, 대개 스스로 거절한다.
   */
  private scaffoldBlocker(request: ScaffoldRequest, catalog: Scaffolders, entries: readonly string[] | null): string | null {
    if (this.deps.kind !== 'project') return '스크래치 세션이다 — 스캐폴딩은 비어 있는 project 폴더를 열고 한다';
    if (!request.scaffolder) {
      return request.candidates.length > 1
        ? `여러 스캐폴더가 맞는다 (${request.candidates.map((c) => c.id).join('·')}) — 하나만 넣어 다시 보낸다`
        : `어느 스캐폴더인지 모른다 — 허용 목록(${catalog.scaffolders.map((c) => c.id).join('·')}) 중 하나를 넣어 다시 보낸다`;
    }
    if (entries === null) return '폴더를 읽지 못했다';
    if (entries.length > 0) {
      const shown = entries.slice(0, 3).join(', ');
      return `폴더가 비어 있지 않다 (${entries.length}개: ${shown}${entries.length > 3 ? ' …' : ''}) — 스캐폴더가 덮을 수 있어 빈 폴더에서만 실행한다`;
    }
    return null;
  }

  /**
   * 메시지가 스캐폴딩 경로를 타는가 (D-088). `card` 면 카드를 세운다(빈 project 폴더 · 허용 목록에서 하나). `why` 면 카드는 못 세우지만
   * 분류 줄·지휘자 안내를 스캐폴딩으로 바꾼다 — **새 프로젝트 뜻이 분명하고(`strong`) 프레임워크를 짚었거나 폴더가 빌 때만**이다.
   * 그 밖(기존 프로젝트·스크래치의 "앱을 시작하면…"·"앱 초기화 로직 설명" 같은 일상 문장)은 null — 종전 경로 그대로다 (PR #118 리뷰).
   */
  private scaffoldRoute(text: string): { readonly card?: Scaffolder; readonly why?: string } | null {
    const catalog = this.scaffolders;
    const request = detectScaffold(text, catalog);
    if (!request) return null;
    const entries = this.deps.kind === 'project' ? folderEntries(this.deps.dir, catalog.ignore) : null;
    const why = this.scaffoldBlocker(request, catalog, entries);
    if (why === null && request.scaffolder) return { card: request.scaffolder };
    const empty = entries !== null && entries.length === 0;
    return why !== null && request.strong && (request.candidates.length > 0 || empty) ? { why } : null;
  }

  /** 카드를 못 세운 스캐폴딩 요청에 지휘자가 안내할 재료 (D-088) — 카드가 서는 길, 못 선 이유, 사람이 직접 돌릴 명령. */
  private scaffoldPrompt(why: string): string {
    return [
      'hs-orc 는 비어 있는 project 폴더에서 아래 허용 목록의 스캐폴더를 사람이 카드에서 확인한 뒤 엔진 없이 직접 실행한다. 메시지에 프레임워크 이름을 넣어 보내면(예: "next 앱 init 해줘") 실행 카드가 선다.',
      `지금 카드를 세우지 않은 이유: ${why}`,
      '허용 목록:',
      ...this.scaffolders.scaffolders.map((c) => `- ${c.label}: \`${commandLine(c.argv)}\``),
      '카드를 세울 수 없는 폴더면 사용자가 터미널에서 위 명령을 직접 돌리게 안내한다. 기존 파일이 있는 git 아닌 폴더에서 이어서 위임하려면 git init 이 먼저다.',
    ].join('\n');
  }

  /** 스캐폴딩 카드를 세운다 (D-088). 엔진·Jev 를 부르지 않는다. 어느 방식에서도 자동 승인하지 않는다(H7). */
  private stageScaffold(scaffolder: Scaffolder): TranscriptRecord {
    this.pendingScaffold = { scaffolder };
    this.stateValue = 'blocked';
    return this.append({ kind: 'scaffold', scaffolder: scaffolder.id, label: scaffolder.label, argv: [...scaffolder.argv], asked: [scaffoldAsk()] });
  }

  /**
   * 사람이 확인한 스캐폴딩 카드를 실행한다 (D-088). 실행 직전에 허용 목록·빈 폴더를 다시 본다 — 카드와 승인 사이에 바뀌었을 수 있다.
   * 셸 없이 argv 로, cwd 는 세션 폴더로 고정, 시간 초과·취소(D-066 통로)는 프로세스 그룹째 끝낸다. 엔진 비용이 없어 `spend` 는 없다.
   */
  private async runScaffold(): Promise<TranscriptRecord[]> {
    this.require('blocked', '승인');
    const pending = this.pendingScaffold;
    if (!pending) throw new SessionStateError('승인할 스캐폴딩 카드가 없다.');
    this.pendingScaffold = null;
    const { dir } = this.deps;
    const argv = pending.scaffolder.argv;
    const out = [this.append({ kind: 'approval', approved: true, write: true, by: 'user', mode: this.modeValue, asked: ['H7'] })];
    const refused = (reason: string): TranscriptRecord =>
      this.append({ kind: 'scaffold-run', step: 'scaffold', commands: [argv], outcome: 'refused', exitCode: null, tail: reason, durationMs: 0 });
    this.stateValue = 'working';
    this.progressLog = [];
    const controller = new AbortController();
    this.delegation = controller;
    try {
      // 허용 목록을 지금 다시 읽어 대조한다 — 카드가 선 뒤 파일에서 빠졌거나 파일이 깨졌으면 돌리지 않는다.
      let catalog: Scaffolders;
      try {
        catalog = this.scaffolders;
        allowedArgv(argv, catalog);
      } catch (error) {
        out.push(refused(why(error)));
        return out;
      }
      const entries = folderEntries(dir, catalog.ignore);
      if (entries === null || entries.length > 0) {
        out.push(refused(entries === null ? '폴더를 읽지 못했다 — 실행하지 않았다' : `폴더가 비어 있지 않다 (${entries.slice(0, 3).join(', ')}${entries.length > 3 ? ' …' : ''}) — 덮을 수 있어 실행하지 않았다`));
        return out;
      }
      const before = this.inGit;
      this.pushProgress(`── 스캐폴딩 ${commandLine(argv)}`);
      const run = await (this.deps.runCommand ?? runArgv)(argv, { cwd: dir, timeoutMs: catalog.timeoutMs, signal: controller.signal, onLine: (line) => this.pushProgress(line) });
      this.delegation = null;
      const ok = run.outcome === 'ok';
      const git = ok ? (before ? 'existing' : this.inGit ? 'scaffolder' : 'offer') : undefined;
      const created = folderEntries(dir, catalog.ignore) ?? [];
      out.push(this.append({
        kind: 'scaffold-run',
        step: 'scaffold',
        commands: [argv],
        outcome: run.outcome,
        exitCode: run.exitCode,
        tail: run.tail,
        durationMs: run.durationMs,
        ...(git ? { git } : {}),
        ...(created.length > 0 ? { created: created.slice(0, CREATED_SHOWN) } : {}),
      }));
    } catch (error) {
      out.push(this.append({ kind: 'error', text: `스캐폴딩이 끝나지 못했다: ${why(error)}` }));
    } finally {
      this.delegation = null;
      this.stateValue = 'waiting_input';
    }
    return out;
  }

  /**
   * 스캐폴딩이 git 없이 끝난 뒤 `git init` + 첫 커밋 (D-088). 버튼·`/git-init` 이 승인이다. 사용자의 git 신원으로 커밋한다.
   * 이 뒤로는 같은 세션의 쓰기 행이 git 폴더 규칙(D-086)으로 선다 — 카드가 설 때 폴더를 다시 본다.
   */
  async initGit(): Promise<TranscriptRecord[]> {
    this.require('waiting_input', 'git init');
    if (!this.gitInitOffered) throw new SessionStateError('git init 은 스캐폴딩이 git 없이 끝난 직후(폴더가 아직 git 이 아닐 때)나 직전 git init 이 끝나지 못했을 때만 한다 (D-088).');
    this.stateValue = 'working';
    this.progressLog = [];
    // 스캐폴딩처럼 취소할 수 있다 (D-066 통로) — 커밋 훅·서명 프롬프트가 멈춰도 사람이 끊는다.
    const controller = new AbortController();
    this.delegation = controller;
    try {
      const seq = await runSequence(this.deps.runCommand ?? runArgv, GIT_INIT_COMMANDS, { cwd: this.deps.dir, timeoutMs: 60_000, signal: controller.signal, onLine: (line) => this.pushProgress(line) });
      return [this.append({
        kind: 'scaffold-run',
        step: 'git-init',
        commands: GIT_INIT_COMMANDS.slice(0, seq.ran),
        outcome: seq.last.outcome,
        exitCode: seq.last.exitCode,
        tail: seq.tail,
        durationMs: seq.durationMs,
      })];
    } catch (error) {
      return [this.append({ kind: 'error', text: `git init 이 끝나지 못했다: ${why(error)}` })];
    } finally {
      this.delegation = null;
      this.stateValue = 'waiting_input';
    }
  }

  /** git 아닌 project 폴더의 쓰기 위임이면 스캐폴딩 안내 한 줄 (D-074·D-088). */
  private scaffoldGuide(write: boolean, inGit = this.inGit): string[] {
    return write && this.deps.kind === 'project' && !inGit ? [SCAFFOLD_GUIDE] : [];
  }

  private async answer(text: string, notes: readonly string[], ignoreSuggest = false, write = false, general = false, scaffold?: string): Promise<TranscriptRecord[]> {
    const { matrix, budget, conduct } = this.deps;
    // route() 가 이미 working 으로 바꿔 놓았을 수 있다 — 여기서도 다시 대입해 answer() 를 단독으로
    // 불러도(테스트 등) 같은 보장이 서게 하고, 모든 탈출 경로를 finally 하나로 묶는다 (final-review #2).
    this.stateValue = 'working';
    const mark = budget.mark();
    try {
      if (budget.limitReached()) {
        return [this.append({ kind: 'error', text: `누적 상한에 닿아 직접 답도 시작하지 않는다 (${budget.summary()}).` })];
      }
      const slot = this.conductor();
      const context = buildContext(this.records(), this.contextLimits, { before: this.turn });
      const answer = await directAnswer(conduct, slot, matrix, context.text, text, { unrouted: ignoreSuggest, ...(scaffold !== undefined ? { scaffold } : {}) });
      const charge = budget.charge(`${slot.label}·${slot.effort}`, answer.run.actualUsd, estimateUsd(matrix, slot), answer.run.meteredUsd, slot.plan);
      budget.countTokens(answer.run.usage);
      if (!answer.run.ok) {
        return [this.append({ kind: 'error', text: `직접 답을 받지 못했다: ${answer.run.text || '엔진이 실패했다'}` })];
      }
      const suggest = ignoreSuggest || scaffold !== undefined ? null : answer.suggest;
      const guide = this.scaffoldGuide(write);
      const direct = this.append({
        kind: 'direct',
        text: answer.body,
        suggest,
        cost: `$${charge.usd.toFixed(4)} ${charge.source}`,
        notes,
        ...(guide.length > 0 ? { guide } : {}),
        ...(general ? { general: true as const } : {}),
        ...(context.cut ? { cut: context.cut } : {}),
        ...(answer.run.cacheWrite ? { cacheWrite: answer.run.cacheWrite } : {}),
        by: slotLine(slot),
      });
      return [direct, ...this.suggestedPlan(text, suggest)];
    } catch (error) {
      return [this.append({ kind: 'error', text: `직접 답을 받지 못했다: ${why(error)}` })];
    } finally {
      // 제안 카드가 섰으면 그 승인 대기가 이 호출의 종료 상태다.
      this.stateValue = this.pending ? 'blocked' : 'waiting_input';
      this.recordSpend(mark);
    }
  }

  /**
   * 직접 답이 행을 제안했으면 곧바로 그 행의 배정·비용 카드를 세운다 (D-064 결정 3) — 승인은 그 카드 1회다.
   * `assign()` 은 결정론이고 엔진을 부르지 않는다. 제안이 없거나 매트릭스에 없는 행이면 카드 없이 직접 답만 남는다.
   * 이 카드를 세우지 못하는 것이 직접 답을 잃을 이유는 아니다 — 던지면 알리고 직접 답은 남긴다.
   */
  private suggestedPlan(text: string, suggest: string | null): TranscriptRecord[] {
    if (!suggest) return [];
    const { matrix, catalog } = this.deps;
    try {
      const result = routeTask(matrix, catalog, text, { taskId: suggest, reasonLabel: SUGGESTED_LABEL });
      return result.stage === 'assigned' ? [this.stage(text, result.plan, result.reason, [])] : [];
    } catch (error) {
      return [this.append({ kind: 'error', text: `제안한 ${suggest} 의 배정을 계산하지 못했다: ${why(error)}` })];
    }
  }

  /** 선 카드를 승인한다. 스캐폴딩 카드(D-088)는 `verify`·`write` 를 쓰지 않는다 — 허용 목록 명령을 그대로 돌린다. */
  async approve(options: { readonly verify?: readonly string[]; readonly write?: boolean } = {}): Promise<TranscriptRecord[]> {
    if (this.pendingScaffold) return this.runScaffold();
    return this.pendingSteps ? this.runSteps(options) : this.start(options, 'user');
  }

  private async start(options: { readonly verify?: readonly string[]; readonly write?: boolean }, by: ApprovedBy): Promise<TranscriptRecord[]> {
    this.require('blocked', '승인');
    const pending = this.pending;
    if (!pending) throw new SessionStateError('승인할 배정이 없다.');
    const write = options.write === true;
    if (write && this.deps.kind === 'scratch') {
      throw new SessionStateError('스크래치 세션은 쓰기를 켤 수 없다 (SPEC §6.4.1).');
    }
    // 카드는 그대로 둔다 — 쓰기를 켜거나 거절·새 메시지로 넘어갈 수 있다.
    if (pending.readOnlyBlocked && !write) throw new SessionStateError(H6_BLOCKED);
    const { matrix, dir, budget, journal } = this.deps;
    const out = [this.append({ kind: 'approval', approved: true, write, by, mode: pending.check.mode, asked: pending.check.asks.map((a) => a.code) })];
    this.pending = null;
    // answer()·summarize() 와 같은 규칙이다 — 멈출지 묻는 곳은 전부 limitReached() (D-030).
    if (budget.limitReached()) {
      this.stateValue = 'waiting_input';
      out.push(this.append({ kind: 'error', text: `누적 상한에 닿아 위임을 시작하지 않는다 (${budget.summary()}).` }));
      this.logUnexecuted(pending, 'blocked', by);
      return out;
    }
    this.stateValue = 'working';
    const mark = budget.mark();
    const controller = new AbortController();
    this.delegation = controller;
    // delegate() 가 돌려줬나 — 그 뒤(기록·요약)에서 던진 것은 위임이 끝난 것이라 다시 세우지 않는다 (D-081).
    let returned = false;
    let thrown = false;
    try {
      // 사다리 위임은 잇지 않는다 — 같은 실패를 같은 방식으로 재시도하지 않고, 실패 근거는 프롬프트에 명시해 싣는다 (D-068 결정 9).
      const ref = pending.ladder ? null : this.resumable(pending.plan, write);
      const context = buildContext(this.records(), this.contextLimits, {
        before: this.turn,
        ...(ref ? { after: ref.turn } : {}),
      });
      const head = [context.text && `[최근 대화]\n${context.text}`, pending.ladder && this.failureEvidence(pending.ladder)].filter(Boolean);
      const prompt = head.length > 0 ? `${head.join('\n\n')}\n\n[이번 요청]\n${pending.title}` : pending.title;
      const d = await delegate({
        matrix,
        plan: pending.plan,
        reason: pending.reason,
        title: pending.title,
        prompt,
        verify: options.verify ?? [],
        cwd: dir,
        execute: this.tapProgress(this.deps.executorFor(write), true),
        budget,
        journal,
        note: this.noteOf(pending, by),
        signal: controller.signal,
        ...(ref ? { resumePrimary: ref.id, ...(ref.baseline ? { resumeBaseline: ref.baseline } : {}) } : {}),
      });
      returned = true;
      this.delegation = null; // 이후(기록·요약)는 취소할 위임이 아니다.
      if (d.outcome === 'cancelled') {
        // 사용자가 멈췄다 (D-066). 요약을 부르지 않고(돈을 더 쓰지 않는다) 엔진 세션은 남기지 않는다 — 다음 위임은 새로 띄운다.
        const stage = d.cancelledAt === 'reviewer' ? 'reviewer 실행 중 — primary 는 끝났고 검증은 하지 않았다' : 'primary 실행 중 — reviewer 는 시작하지 않았다';
        out.push(this.append({
          kind: 'result',
          outcome: 'cancelled',
          verdict: 'unknown',
          text: d.text.slice(0, 4000),
          review: '',
          evidence: `취소됨 — ${stage}.${write ? ' 쓰기가 켜져 있었다 — 파일이 일부 바뀌었을 수 있다(git status).' : ''}`,
          decisionId: d.decisionId,
          ...(context.cut ? { cut: context.cut } : {}),
        }));
        return out;
      }
      out.push(
        this.append({
          kind: 'result',
          outcome: d.outcome,
          verdict: d.verdict,
          text: d.text.slice(0, 4000),
          review: d.review ?? '',
          evidence: d.report.summary,
          decisionId: d.decisionId,
          ...(d.primarySession ? { engineSession: d.primarySession } : {}),
          ...(d.compactions ? { compacted: d.compactions } : {}),
          ...(context.cut ? { cut: context.cut } : {}),
        }),
      );
      if (ref && !d.ok) {
        out.push(this.append({
          kind: 'error',
          text: '이어 붙인 엔진 세션이 실패했다 — 새 세션으로 조용히 바꾸지 않는다. 다시 보내면 맥락을 실어 새로 띄운다.',
        }));
      }
      out.push(...(await this.summarize(pending.title, d)));
    } catch (error) {
      out.push(this.append({ kind: 'error', text: `위임이 끝나지 못했다: ${why(error)}` }));
      // 사용자가 취소한 뒤의 예외는 재시도 대상이 아니다 (D-066).
      thrown = !returned && !controller.signal.aborted;
    } finally {
      this.delegation = null;
      this.stateValue = 'waiting_input';
      this.recordSpend(mark);
    }
    if (thrown) out.push(this.restage(pending, write));
    return out;
  }

  /**
   * 승인한 배정이 예외로 끝났다 — 같은 계획(행·슬롯·reason·쓰기·사다리)으로 카드를 다시 세운다 (D-081). **시작하지 않는다** —
   * 어느 방식에서도 A3 로 묻는다. 다시 세운 카드가 또 던지면 세우지 않는다: 같은 실패를 같은 방식으로 2회 연속 재시도하지 않는다 (PLAN 중단 조건).
   * 쓰기는 이번 실행에 켠 값이다 — 사람이 승인 때 켠 것을 다시 끄지 않는다.
   */
  private restage(pending: Pending, write: boolean): TranscriptRecord {
    if (pending.retry) {
      return this.append({ kind: 'error', text: '다시 세운 같은 배정도 예외로 끝났다 — 카드를 또 세우지 않는다. 메시지를 다시 보내거나 행을 다시 지정한다.' });
    }
    return this.stage(pending.title, pending.plan, pending.reason, [], write, pending.ladder, true);
  }

  /**
   * mark 뒤로 쌓인 과금·토큰을 `spend` 한 줄로 남긴다 (D-054). 쌓인 게 없으면 남기지 않는다.
   * 결과·요약 **뒤에** 붙인다 — `interrupted` 는 마지막 줄이 승인인지로 끊김을 판정한다.
   */
  private recordSpend(mark: BudgetMark): void {
    const spend = this.deps.budget.since(mark);
    if (spend.charges.length === 0 && spend.tokens === 0 && spend.unreported === 0) return;
    this.append({ kind: 'spend', ...spend });
  }

  /**
   * 이을 엔진 세션 (SPEC §6.4.3): **가장 최근 위임**이 성공해 엔진 세션을 남겼고, 그 primary 가
   * 이번 primary 와 엔진·모델·effort 가 모두 같을 때만. 최근 위임이 실패했으면 더 앞을 찾지 않는다.
   * 세션 폴더는 이 세션이 늘 같다 (엔진은 다른 cwd 에서도 id 로 잇지만 앞 턴의 경로가 옛 폴더를 가리킨다 — D-031 Q10 후속).
   *
   * 쓰기가 켜져 있고 그 엔진의 resume 경로가 쓰기를 못 받으면(`resume?.write === false`) 잇지 않는다 —
   * `buildInvocation` 이 던지게 두지 않고 여기서 미리 새 실행으로 돌린다(맥락은 그대로 싣는다, final-review #1).
   *
   * 그 실행 중 엔진이 맥락을 압축했으면(`compacted`) 잇지 않는다 — 요약이 세부를 버린다(D-058 자동 압축 실측).
   * 새 실행이면 orc 의 최근 대화가 원문으로 실린다 (D-059).
   */
  private resumable(plan: AssignmentPlan, write: boolean): { id: string; turn: number; baseline?: EngineReport } | null {
    const last = this.records().findLast((r) => r.kind === 'result');
    if (last?.kind !== 'result' || !last.engineSession || last.compacted) return null;
    const p = plan.slots.primary;
    const s = last.engineSession;
    if (s.engine !== p.engine || s.modelId !== p.modelId || s.effort !== p.effort) return null;
    if (write && this.deps.catalog.engines[p.engine].resume?.write === false) return null;
    return { id: s.id, turn: last.turn, ...(s.reported ? { baseline: s.reported } : {}) };
  }

  /** 결정 로그 `note` 끝 — 세션 id·승인자, 사다리 배정이면 어느 결정에서 올랐나 (D-068 결정 11). */
  private noteOf(pending: Pick<Pending, 'ladder'>, by?: ApprovedBy): string {
    return `session ${this.deps.id}${by ? ` · 승인 ${by}` : ''}${pending.ladder ? ` · 사다리 이전 결정 ${pending.ladder.from}` : ''}`;
  }

  /** ① 근거 보강 — 직전 결과의 reviewer 검증·증거를 위임 프롬프트에 싣는다. 사다리 배정은 단계와 무관하게 계속 싣는다(누적). */
  private failureEvidence(ladder: LadderRecord): string {
    const r = this.log.find((x) => x.kind === 'result' && x.decisionId === ladder.from);
    if (r?.kind !== 'result') return '';
    return [
      `[직전 시도 실패 근거 — 사다리 ${ladder.label}]`,
      `직전 결과: ${r.outcome} · reviewer ${r.verdict.toUpperCase()}`,
      `증거: ${r.evidence}`,
      ...(r.review ? [`reviewer 검증: ${r.review.slice(0, 1500)}`] : []),
      '같은 접근을 되풀이하지 말고 위 근거를 해소한다.',
    ].join('\n');
  }

  /**
   * 사다리 상태는 **기록에서 계산한다** (D-068 결정 10) — 마지막 **취소 아닌** 결과가 사다리를 제안하는 것이고 그 뒤에 사용자 메시지가 없으면
   * 상향할 수 있다. 취소(D-066)는 건너뛴다 — 단계를 쓰지 않는다. 직전 배정의 `ladder.done` 이 지나온 단계다.
   */
  private ladderBase(): { readonly from: string; readonly plan: Extract<TranscriptRecord, { kind: 'plan' }>; readonly title: string; readonly done: readonly EscalationStage[] } | null {
    const i = this.log.findLastIndex((r) => r.kind === 'result' && r.outcome !== 'cancelled');
    const result = this.log[i];
    // 단계 결과(D-087)는 사다리를 세우지 않는다 — 앞 기록의 배정 카드가 그 단계의 배정이 아니다.
    if (result?.kind !== 'result' || result.step !== undefined || nextSuggestion(result.outcome, result.verdict) === '') return null;
    if (this.log.slice(i + 1).some((r) => r.kind === 'user')) return null;
    const before = this.log.slice(0, i);
    const plan = before.findLast((r) => r.kind === 'plan');
    const user = before.findLast((r) => r.kind === 'user');
    if (plan?.kind !== 'plan' || user?.kind !== 'user') return null;
    return { from: result.decisionId, plan, title: user.text, done: plan.ladder?.done ?? [] };
  }

  /** 다음에 올릴 수 있는 단계가 있으면 돌려준다. 배정 계산을 못 하면(매트릭스가 바뀜 등) 없는 것으로 본다 — 화면을 깨지 않는다. */
  ladderOffer(): LadderOffer | null {
    const base = this.ladderBase();
    if (!base) return null;
    try {
      const step = this.ladderStep(base);
      return step ? { stage: step.applied.stage, label: step.applied.label, changes: step.applied.changes } : null;
    } catch {
      return null;
    }
  }

  private ladderStep(base: NonNullable<ReturnType<ConversationSession['ladderBase']>>): ReturnType<typeof planLadder> {
    const { matrix, catalog } = this.deps;
    const row = matrix.assignments.find((a) => a.id === base.plan.taskId);
    return row ? planLadder(matrix, catalog, row, base.done) : null;
  }

  /**
   * 사다리를 한 칸 올린 배정 카드를 세운다 (D-068). **카드만 세우고 시작하지 않는다** — 승인은 카드에서 따로고,
   * 어느 방식에서도 A3 로 묻는다(자동 승인 경로를 타지 않는다). 같은 요청(그 결과를 낳은 사용자 메시지)·같은 턴이다.
   * `requested` 를 주면 그 단계가 다음 단계여야 한다 — 순서를 건너뛰는 요청(L5 직행 등)은 던진다.
   */
  escalate(requested?: EscalationStage): TranscriptRecord[] {
    this.require('waiting_input', '사다리 상향');
    const base = this.ladderBase();
    if (!base) throw new SessionStateError('상향할 결과가 없다 — 사다리는 위임이 미검증·실패로 끝난 직후에만 선다 (취소와 새 메시지 뒤에는 없다).');
    if (requested) requestStage(base.done, requested);
    const step = this.ladderStep(base);
    if (!step) throw new LadderError('더 올릴 단계가 없다. 여기서도 안 되면 문제 정의를 다시 본다.');
    const origin = base.plan.ladder?.origin ?? base.plan.reason;
    const ladder: LadderRecord = { ...step.applied, from: base.from, origin };
    return [this.stage(base.title, step.plan, `사다리 ${step.applied.label} · ${origin}`, [], false, ladder)];
  }

  reject(): TranscriptRecord[] {
    this.require('blocked', '거절');
    const pending = this.pending;
    const steps = this.pendingSteps;
    this.pending = null;
    this.pendingSteps = null;
    this.pendingScaffold = null;
    this.stateValue = 'waiting_input';
    const out = [this.append({ kind: 'approval', approved: false, write: false })];
    if (pending) this.logUnexecuted(pending, 'declined');
    if (steps) this.logUnexecutedSteps(steps, 'declined');
    return out;
  }

  /**
   * 제안했지만 실행되지 않은 배정도 결정 로그에 남긴다 (SPEC §8) — 1차 decided 와 2차 declined/blocked 를
   * 같은 id 로. 1차 줄 모양은 위임과 같다 (`firstLine` + 세션 id).
   */
  private logUnexecuted(pending: Pick<Pending, 'title' | 'plan' | 'reason' | 'ladder'>, status: 'declined' | 'blocked', approvedBy?: ApprovedBy, notStarted?: string): void {
    const first = firstLine(this.deps.matrix, pending.plan, pending.title, pending.reason);
    const decision = { ...first, note: `${first.note ?? ''} · ${this.noteOf(pending, approvedBy)}${notStarted ? ` · 미실행 ${notStarted}` : ''}` };
    appendDecision(decision);
    appendDecision(unexecutedLine(decision, status));
  }

  /**
   * 규칙이 대화성 후속을 작업 행으로 잡았을 때(D-038) — 배정을 거절로 남기고 **같은 메시지**를
   * 지휘자 직접 답으로 보낸다. 새 사용자 메시지·새 턴을 만들지 않는다 (`planAs` 와 같은 모양).
   */
  async askConductor(): Promise<TranscriptRecord[]> {
    this.require('blocked', '지휘자에게 묻기');
    const pending = this.pending;
    if (!pending) throw new SessionStateError('물을 메시지가 없다.');
    const rejected = this.reject();
    return [...rejected, ...(await this.answer(pending.title, []))];
  }

  /**
   * **마지막 메시지**를 지휘자가 위임 단계로 나눈 계획으로 세운다 (D-087) — GUI "단계로 나눠 계획" · chat `/steps`. 새 메시지를 만들지 않는다.
   * 지휘자는 행과 순서만 정하고, 단계마다 배정은 매트릭스가 한다(G1). 카드만 세우고 시작하지 않는다 — 어느 방식에서도 사람이 승인한다(H1).
   * 배정 카드가 선 채 부르면 그 배정은 거절로 남기고 같은 메시지로 계획한다.
   */
  async planSteps(): Promise<TranscriptRecord[]> {
    if (this.pendingSteps) throw new SessionStateError('이미 선 단계 계획이 있다 — 먼저 승인하거나 거절한다.');
    const declined = this.stateValue === 'blocked' ? this.reject() : [];
    this.require('waiting_input', '단계 계획');
    const last = this.records().findLast((r) => r.kind === 'user');
    if (last?.kind !== 'user') throw new SessionStateError('나눌 메시지가 없다.');
    const { matrix, catalog, budget, conduct } = this.deps;
    // send() 와 같은 이유로 첫 await 전에 바로 바꾼다 (final-review #2).
    this.stateValue = 'working';
    const mark = budget.mark();
    const out = [...declined];
    try {
      this.recordModeOnce();
      if (budget.limitReached()) {
        out.push(this.append({ kind: 'error', text: `누적 상한에 닿아 단계 계획을 시작하지 않는다 (${budget.summary()}).` }));
        return out;
      }
      const slot = this.conductor();
      const maxSteps = loadLimits().maxNodes;
      const context = buildContext(this.records(), this.contextLimits, { before: this.turn });
      const run = await conduct(slot, buildStepsPrompt(matrix, context.text, last.text, maxSteps));
      const charge = budget.charge(`${slot.label}·${slot.effort}`, run.actualUsd, estimateUsd(matrix, slot), run.meteredUsd, slot.plan);
      budget.countTokens(run.usage, run.compactionUncounted);
      if (!run.ok) {
        out.push(this.append({ kind: 'error', text: `단계 계획을 받지 못했다: ${run.text || '엔진이 실패했다'}` }));
        return out;
      }
      let nodes: GraphNode[];
      try {
        nodes = parseSteps(matrix, catalog, run.text, maxSteps);
      } catch (error) {
        if (!(error instanceof StepsError)) throw error;
        // 계획을 추측해 고치지 않는다 — 무엇이 틀렸는지와 받은 답 앞부분을 보이고 끝낸다.
        out.push(this.append({ kind: 'error', text: `지휘자 계획을 쓸 수 없다: ${error.message} — 받은 답: ${run.text.trim().slice(0, 300)}` }));
        return out;
      }
      // 쓰기 행 규칙은 배정 카드(`stage`)와 같다 (D-086) — git project 폴더의 쓰기 행 단계는 쓰기를 켠 채 선다.
      // 단계 카드는 늘 사람이 승인하므로(H1) H2 는 묻지 않고, H5(미커밋)·H6(git 밖 쓰기 행)은 승인 전에 보인다.
      const inGit = this.inGit;
      const rows = this.deps.kind === 'project' ? (this.deps.writeRows ?? loadLimits().writeRows) : [];
      const rowWrite = (n: GraphNode): boolean => rows.includes(n.plan.assignment.id);
      const writeSteps = new Set(nodes.filter((n) => rowWrite(n) && inGit).map((n) => n.id));
      const write = writeSteps.size > 0;
      const dirty = write ? this.uncommitted() : [];
      const asked = [
        { code: 'H1' as const, text: '단계의 행을 지휘자(모델)가 골랐다' },
        dirtyWriteRisk(write, dirty),
        readOnlyWriteRow(nodes.some(rowWrite), false, inGit),
      ].filter((a): a is AskReason => a !== null);
      const guide = this.scaffoldGuide(nodes.some(rowWrite), inGit);
      const readOnlyBlocked = asked.some((a) => a.code === 'H6');
      const steps = nodes.map((n) => ({
        id: n.id,
        taskId: n.plan.assignment.id,
        task: n.plan.assignment.task,
        prompt: n.prompt,
        dependsOn: [...n.dependsOn],
        primary: slotLine(n.plan.slots.primary),
        reviewer: slotLine(n.plan.slots.reviewer),
        estimateUsd: n.plan.cost.totalUsd,
        ...(writeSteps.has(n.id) ? { write: true as const } : {}),
      }));
      this.pendingSteps = { title: last.text, nodes, writeSteps, asked, readOnlyBlocked };
      out.push(this.append({
        kind: 'steps',
        title: last.text,
        steps,
        estimateUsd: Number(steps.reduce((sum, st) => sum + st.estimateUsd, 0).toFixed(4)),
        by: slotLine(slot),
        cost: `$${charge.usd.toFixed(4)} ${charge.source}`,
        asked,
        ...(write ? { write: true as const } : {}),
        ...(guide.length > 0 ? { guide } : {}),
        ...(readOnlyBlocked ? { readOnlyBlocked: true as const } : {}),
        ...(context.cut ? { cut: context.cut } : {}),
      }));
      return out;
    } catch (error) {
      out.push(this.append({ kind: 'error', text: `단계 계획을 받지 못했다: ${why(error)}` }));
      return out;
    } finally {
      this.stateValue = this.pendingSteps ? 'blocked' : 'waiting_input';
      this.recordSpend(mark);
    }
  }

  /**
   * 승인한 단계 계획을 의존 순서대로 **하나씩** 위임한다 (D-087). 단계마다 두 슬롯·증거·결정 로그 2회는 위임 1건과 같다(`delegate`).
   * 앞 단계가 실패(실행 실패 `wrong`·나쁜 결과 `rework`·취소·reviewer FAIL)하면 그 단계에 의존한 단계는 건너뛴다. `unverified`(검증 명령 없음)는
   * 실패가 아니다 — 읽기 전용 계획은 대개 검증 명령이 없어 이것까지 막으면 둘째 단계가 영영 돌지 않는다. 상한에 닿거나 취소하면 남은 단계를 시작하지 않는다.
   * 병렬로 돌리지 않는다 — 단계의 쓰기 대상을 지휘자가 선언하지 않으므로 `/graph` 규칙대로 순차다.
   */
  private async runSteps(options: { readonly verify?: readonly string[]; readonly write?: boolean }): Promise<TranscriptRecord[]> {
    this.require('blocked', '승인');
    const pending = this.pendingSteps;
    if (!pending) throw new SessionStateError('승인할 단계 계획이 없다.');
    // git 아닌 폴더의 쓰기 행 단계는 쓰기를 받을 수 없어(쓰기 단계는 git 폴더에서만 선다) 헛돈다 (H6, D-088).
    if (pending.readOnlyBlocked) throw new SessionStateError(H6_BLOCKED);
    // 카드의 쓰기 스위치는 "쓰기 행 단계에 쓰기를 준다" 다 (D-086) — 읽기 행 단계는 켜도 읽기 전용이다.
    const write = options.write === true && pending.writeSteps.size > 0;
    if (write && this.deps.kind === 'scratch') throw new SessionStateError('스크래치 세션은 쓰기를 켤 수 없다 (SPEC §6.4.1).');
    const { matrix, dir, budget, journal } = this.deps;
    const out = [this.append({ kind: 'approval', approved: true, write, by: 'user', mode: this.modeValue, asked: pending.asked.map((a) => a.code) })];
    this.pendingSteps = null;
    if (budget.limitReached()) {
      this.stateValue = 'waiting_input';
      out.push(this.append({ kind: 'error', text: `누적 상한에 닿아 단계 계획을 시작하지 않는다 (${budget.summary()}).` }));
      this.logUnexecutedSteps(pending, 'blocked', '누적 상한');
      return out;
    }
    this.stateValue = 'working';
    const mark = budget.mark();
    const controller = new AbortController();
    this.delegation = controller;
    const results: { id: string; outcome: string; verdict: string; evidence: string; text: string }[] = [];
    const outputs = new Map<string, string>();
    const failed = new Set<string>();
    const skipped: string[] = [];
    // 시작한 단계와 시작하지 않은 사유 — 승인했지만 돌지 않은 단계도 결정 로그에 남긴다 (SPEC §8).
    const started = new Set<string>();
    const notStarted = new Map<string, string>();
    const skipRest = (rest: readonly GraphNode[], why: string): void => {
      for (const n of rest) if (!notStarted.has(n.id)) notStarted.set(n.id, why);
      skipped.push(...rest.map((n) => n.id));
    };
    try {
      const order = topoSort(pending.nodes).flat();
      const context = buildContext(this.records(), this.contextLimits, { before: this.turn });
      for (const [i, node] of order.entries()) {
        if (controller.signal.aborted) {
          skipRest(order.slice(i), '사용자가 취소했다');
          break;
        }
        const blockers = node.dependsOn.filter((d) => failed.has(d) || skipped.includes(d));
        if (blockers.length > 0) {
          skipRest([node], `선행 단계 ${blockers.join(', ')} 가 실패하거나 건너뛰었다`);
          continue;
        }
        if (budget.limitReached()) {
          out.push(this.append({ kind: 'error', text: `누적 상한에 닿아 단계 ${node.id} 부터 시작하지 않는다 (${budget.summary()}).` }));
          skipRest(order.slice(i), '누적 상한');
          break;
        }
        started.add(node.id);
        const before = node.dependsOn.map((d) => ({ id: d, text: outputs.get(d) ?? '' }));
        const d = await delegate({
          matrix,
          plan: node.plan,
          reason: `단계 ${node.id} · 지휘자 계획 ${node.plan.assignment.id}`,
          title: `${pending.title} — 단계 ${node.id}`,
          prompt: buildStepPrompt(pending.title, node, before, context.text),
          verify: options.verify ?? [],
          cwd: dir,
          execute: this.tapProgress(this.deps.executorFor(write && pending.writeSteps.has(node.id)), true),
          budget,
          journal,
          note: `session ${this.deps.id} · 승인 user · 단계 계획 ${node.id}`,
          signal: controller.signal,
        });
        const evidence = d.outcome === 'cancelled'
          ? `취소됨 — ${d.cancelledAt === 'reviewer' ? 'reviewer 실행 중 — primary 는 끝났고 검증은 하지 않았다' : 'primary 실행 중 — reviewer 는 시작하지 않았다'}.${write ? ' 쓰기가 켜져 있었다 — 파일이 일부 바뀌었을 수 있다(git status).' : ''}`
          : d.report.summary;
        out.push(this.append({
          kind: 'result',
          outcome: d.outcome,
          verdict: d.outcome === 'cancelled' ? 'unknown' : d.verdict,
          text: d.text.slice(0, 4000),
          review: d.outcome === 'cancelled' ? '' : (d.review ?? ''),
          evidence,
          decisionId: d.decisionId,
          step: node.id,
          ...(d.compactions ? { compacted: d.compactions } : {}),
        }));
        results.push({ id: node.id, outcome: d.outcome, verdict: d.verdict, evidence, text: d.text });
        outputs.set(node.id, d.text);
        if (d.outcome === 'wrong' || d.outcome === 'rework' || d.outcome === 'cancelled' || d.verdict === 'fail') failed.add(node.id);
      }
      this.delegation = null; // 이후(요약)는 취소할 위임이 아니다.
      // 사용자가 멈췄으면 요약을 부르지 않는다 — 돈을 더 쓰지 않는다 (D-066).
      if (results.length > 0 && !controller.signal.aborted) {
        const next = failed.size === 0 && skipped.length === 0
          ? ''
          : `단계 ${order.length} 중 실패 ${failed.size}${skipped.length > 0 ? ` · 건너뜀 ${skipped.join(', ')}` : ''} — 실패한 단계는 그 내용으로 다시 보내 위임하거나 계획을 다시 세운다`;
        out.push(...(await this.summarizeWith(buildStepsSummaryPrompt(pending.title, results, skipped), next)));
      }
    } catch (error) {
      out.push(this.append({ kind: 'error', text: `단계 계획 실행이 끝나지 못했다: ${why(error)}` }));
    } finally {
      this.delegation = null;
      this.stateValue = 'waiting_input';
      this.recordSpend(mark);
    }
    // 시작하지 않은 단계 — 건너뜀·상한·취소, 그리고 앞 단계가 예외로 끝나 남은 단계. 시작한 단계는 delegate 가 이미 두 줄을 남겼다.
    for (const node of pending.nodes) {
      if (!started.has(node.id)) this.logUnexecutedStep(pending, node, 'blocked', notStarted.get(node.id) ?? '앞 단계가 예외로 끝났다');
    }
    return out;
  }

  /** 승인하지 않은 단계 계획도 단계마다 결정 로그에 남긴다 (SPEC §8) — 배정 카드의 거절과 같은 모양이다. */
  private logUnexecutedSteps(steps: StepsPending, status: 'declined' | 'blocked', why?: string): void {
    for (const node of steps.nodes) this.logUnexecutedStep(steps, node, status, why);
  }

  /** 단계 하나의 미실행 1·2차 줄. `why` 는 승인했지만 시작하지 않은 사유다 — note 끝에 붙는다. */
  private logUnexecutedStep(steps: StepsPending, node: GraphNode, status: 'declined' | 'blocked', why?: string): void {
    this.logUnexecuted({ title: `${steps.title} — 단계 ${node.id}`, plan: node.plan, reason: `단계 ${node.id} · 지휘자 계획 ${node.plan.assignment.id}` }, status, why ? 'user' : undefined, why);
  }

  /** 모델은 요약만 한다. 다음 제안은 코드가 계산한다 (SPEC §6.4.4). 요약이 실패해도 제안은 남긴다. */
  private async summarize(title: string, d: Delegated): Promise<TranscriptRecord[]> {
    // 결과가 이미 기록에 붙은 뒤다 — 사다리 상태(다음에 올릴 수 있는 단계)가 이 결과를 본다.
    const next = nextSuggestion(d.outcome, d.verdict, this.ladderOffer());
    return this.summarizeWith(buildSummaryPrompt(title, d), next);
  }

  /** 지휘자 요약 한 건 — 위임 1건과 단계 계획(D-087)이 같이 쓴다. 요약이 실패해도 `next` 는 남긴다. */
  private async summarizeWith(prompt: string, next: string): Promise<TranscriptRecord[]> {
    const { matrix, budget, conduct } = this.deps;
    if (budget.limitReached()) {
      return [
        this.append({ kind: 'error', text: `누적 상한에 닿아 요약을 시작하지 않는다 (${budget.summary()}) — 결과 카드를 본다.` }),
        this.append({ kind: 'summary', text: '', next }),
      ];
    }
    try {
      const slot = this.conductor();
      const run = await conduct(slot, prompt);
      budget.charge(`${slot.label}·${slot.effort}`, run.actualUsd, estimateUsd(matrix, slot), run.meteredUsd, slot.plan);
      budget.countTokens(run.usage);
      if (!run.ok) {
        return [
          this.append({ kind: 'error', text: `요약을 받지 못했다 — 결과 카드를 본다: ${run.text || '엔진이 실패했다'}` }),
          this.append({ kind: 'summary', text: '', next }),
        ];
      }
      return [this.append({ kind: 'summary', text: run.text.trim(), next, by: slotLine(slot) })];
    } catch (error) {
      return [
        this.append({ kind: 'error', text: `요약을 받지 못했다 — 결과 카드를 본다: ${why(error)}` }),
        this.append({ kind: 'summary', text: '', next }),
      ];
    }
  }
}
