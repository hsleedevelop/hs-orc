/**
 * 대화 세션 (SPEC §6.4, D-031). **헤드리스다** — 셸은 이것을 부르고 기록을 그린다.
 * 셸마다 따로 두면 같은 메시지에 셸마다 다르게 답한다 (D-026 전례).
 *
 * 메시지 1건: 기록 → 라우팅(결정론 파이프라인 그대로) → 배정이면 승인 대기(`blocked`),
 * 아니면 지휘자 직접 답. 다음 위임을 **스스로 시작하지 않는다** (D-015).
 */
import type { RowClassifier } from '../adapters/jev.ts';
import type { Engines } from '../data/engines.ts';
import type { Matrix } from '../data/matrix.ts';
import { isApprovalMode, loadLimits, type ApprovalMode } from '../data/limits.ts';
import type { AssignmentPlan } from './assign.ts';
import { dirtyWriteRisk, evaluateApproval, evaluateRead, nonGitWriteRefusal, readOnlyWriteRow, type ApprovalCheck } from './approval.ts';
import type { Budget, BudgetMark } from './budget.ts';
import { buildSummaryPrompt, conductorSlot, directAnswer, nextSuggestion } from './conductor.ts';
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
import {
  appendRecord,
  readSessionLog,
  transcriptPath,
  type LadderRecord,
  type SessionKind,
  type SessionState,
  type TranscriptEntry,
  type TranscriptRecord,
} from './transcript.ts';

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
  /** project 폴더가 git 작업 트리인가 (D-074). 없으면 git 으로 본다 — 조립(`assembleSession`)이 `repoRoot` 로 정해 넘긴다. */
  readonly inGit?: boolean;
  /** 쓰기가 본질인 행 (D-086). 없으면 `limits.json` 의 `writeRows`. */
  readonly writeRows?: readonly string[];
  /** 폴더의 미커밋 파일 (D-086 H5) — 조립이 `git status --porcelain` 으로 넘긴다. 없으면 깨끗한 것으로 본다. */
  readonly dirtyFiles?: () => readonly string[];
}

/** `plan.reason` 에 남는 출처 — 행을 고른 것이 지휘자다. `수동 지정` 이면 사람이 고른 것으로 적힌다 (`pipeline.ts` reasonLabel). */
const SUGGESTED_LABEL = '지휘자 제안';

/** 스캐폴더는 위임하지 않고 사람이 먼저 돌린다 (D-074 B1) — codex 샌드박스는 네트워크·홈 쓰기를, claude 쓰기 모드는 셸을 막는다 (D-073). */
export const SCAFFOLD_GUIDE = 'git 아닌 폴더 · 쓰기 위임 — 스캐폴더(예: `npx create-expo-app@latest .`)는 먼저 직접 돌리고 그 뒤 위임하라 (D-074)';

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
  /** 도는 위임의 취소 신호 (D-066). primary·reviewer·읽기 답(D-083) 실행 동안만 있다 — 지휘자의 요약·직접 답은 취소 대상이 아니다. */
  private delegation: AbortController | null = null;
  /** 도는(또는 마지막으로 돈) 엔진 실행의 진행 줄 (D-084). 기록에 남기지 않는다 — 화면이 "실행 중…" 아래에 보여줄 뿐이다. */
  private progressLog: string[] = [];
  /** 기록은 열 때 한 번 읽고 이후엔 append 와 함께 들고 있는다 — 메시지마다 JSONL 을 다시 읽지 않는다. */
  private readonly log: TranscriptRecord[];
  /** 지금 승인 방식 (D-064). 마지막 `mode` 기록을 재생한다 — 없으면 새 세션은 `limits.json` 기본값, 옛 세션은 `manual`. */
  private modeValue: ApprovalMode;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.file = transcriptPath(deps.dir, deps.id);
    // 다시 열면 턴 번호를 이어 간다. 끝에 승인 안 된 배정이 남아 있어도 **되살리지 않는다** —
    // 그 사이 비용·폴더가 바뀌었을 수 있다. 화면은 그 카드를 보여주되 승인 버튼은 없다.
    this.log = readSessionLog(deps.dir, deps.id).records;
    this.turn = this.log.reduce((max, r) => Math.max(max, r.turn), 0);
    const recorded = this.log.findLast((r) => r.kind === 'mode');
    // 방식이 없는 기록은 이 결정 전의 세션이다 — 조용히 자동이 되지 않게 manual 로 연다 (D-064 결정 8). 빈 기록만 기본값을 받는다.
    this.modeValue =
      recorded?.kind === 'mode' && isApprovalMode(recorded.mode)
        ? recorded.mode
        : this.log.length === 0
          ? (deps.approvalMode ?? loadLimits().approvalMode)
          : 'manual';
  }

  get mode(): ApprovalMode {
    return this.modeValue;
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

  /** 첫 메시지 전에 지금 방식을 기록으로 굳힌다 — 나중에 기본값이 바뀌어도 이 세션의 방식은 변하지 않는다. */
  private recordModeOnce(): void {
    if (!this.modeRecorded()) this.append({ kind: 'mode', mode: this.modeValue });
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
    const push = (line: string): void => {
      this.progressLog.push(line.length > PROGRESS_LINE_MAX ? `${line.slice(0, PROGRESS_LINE_MAX)}…` : line);
      if (this.progressLog.length > PROGRESS_MAX) this.progressLog.splice(0, this.progressLog.length - PROGRESS_MAX);
    };
    return (slot, prompt, options) => {
      push(`── ${role ? `${slot.role} ` : ''}${slotLine(slot)}`);
      return execute(slot, prompt, { ...options, onProgress: push });
    };
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
    const last = this.log.at(-1);
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
    const tail = this.log.at(-1);
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

  private append(entry: TranscriptEntry): TranscriptRecord {
    const record = { ...entry, v: 1, at: (this.deps.now?.() ?? new Date()).toISOString(), turn: this.turn } as TranscriptRecord;
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
        return await this.answer(text, notes, general || routed.jev === 'none' || routed.jev === 'unsure', write, general);
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
    const inGit = this.deps.inGit ?? true;
    const rowWrite = this.deps.kind === 'project' && (this.deps.writeRows ?? loadLimits().writeRows).includes(plan.assignment.id);
    const write = sentWrite || (!retry && rowWrite && inGit);
    const dirty = write && inGit ? (this.deps.dirtyFiles?.() ?? []) : [];
    const check = evaluateApproval({ mode: this.modeValue, plan, reason, write, catalog, budget, records: this.log, inGit, rowWrite, dirty, ...(ladder ? { ladder: true } : {}), ...(retry ? { retry: true } : {}) });
    // manual 은 묻는 이유(`asked`)가 비므로 H4·H5·H6 을 안내 줄로 싣는다 — 어느 방식이든 카드가 같은 줄을 보인다 (D-074·D-086).
    const warnings = check.mode === 'manual'
      ? [nonGitWriteRefusal(catalog, plan, write, inGit), dirtyWriteRisk(write, dirty), readOnlyWriteRow(rowWrite, write, inGit)].flatMap((w) => (w ? [w.text] : []))
      : [];
    const guide = [...warnings, ...this.scaffoldGuide(write || rowWrite)];
    this.pending = { title, plan, reason, write, check, ...(ladder ? { ladder } : {}), ...(retry ? { retry } : {}) };
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

  /** 질문형 경로를 클릭 없이 돌릴지 (D-083). 판정은 `approval.ts` 한 곳이다. */
  private readCheck(): ApprovalCheck {
    const { matrix, catalog, budget } = this.deps;
    const slot = readerSlot(catalog);
    return evaluateRead({ mode: this.modeValue, slot, catalog, budget, estimateUsd: estimateUsd(matrix, slot) });
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

  /** git 아닌 project 폴더의 쓰기 위임이면 스캐폴더 안내 한 줄 (D-074 B1). */
  private scaffoldGuide(write: boolean): string[] {
    return write && this.deps.kind === 'project' && this.deps.inGit === false ? [SCAFFOLD_GUIDE] : [];
  }

  private async answer(text: string, notes: readonly string[], ignoreSuggest = false, write = false, general = false): Promise<TranscriptRecord[]> {
    const { matrix, catalog, budget, conduct } = this.deps;
    // route() 가 이미 working 으로 바꿔 놓았을 수 있다 — 여기서도 다시 대입해 answer() 를 단독으로
    // 불러도(테스트 등) 같은 보장이 서게 하고, 모든 탈출 경로를 finally 하나로 묶는다 (final-review #2).
    this.stateValue = 'working';
    const mark = budget.mark();
    try {
      if (budget.limitReached()) {
        return [this.append({ kind: 'error', text: `누적 상한에 닿아 직접 답도 시작하지 않는다 (${budget.summary()}).` })];
      }
      const slot = conductorSlot(catalog);
      const context = buildContext(this.records(), this.contextLimits, { before: this.turn });
      const answer = await directAnswer(conduct, slot, matrix, context.text, text, { unrouted: ignoreSuggest });
      const charge = budget.charge(`${slot.label}·${slot.effort}`, answer.run.actualUsd, estimateUsd(matrix, slot), answer.run.meteredUsd, slot.plan);
      budget.countTokens(answer.run.usage);
      if (!answer.run.ok) {
        return [this.append({ kind: 'error', text: `직접 답을 받지 못했다: ${answer.run.text || '엔진이 실패했다'}` })];
      }
      const suggest = ignoreSuggest ? null : answer.suggest;
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

  async approve(options: { readonly verify?: readonly string[]; readonly write?: boolean } = {}): Promise<TranscriptRecord[]> {
    return this.start(options, 'user');
  }

  private async start(options: { readonly verify?: readonly string[]; readonly write?: boolean }, by: ApprovedBy): Promise<TranscriptRecord[]> {
    this.require('blocked', '승인');
    const pending = this.pending;
    if (!pending) throw new SessionStateError('승인할 배정이 없다.');
    const write = options.write === true;
    if (write && this.deps.kind === 'scratch') {
      throw new SessionStateError('스크래치 세션은 쓰기를 켤 수 없다 (SPEC §6.4.1).');
    }
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
  private noteOf(pending: Pending, by?: ApprovedBy): string {
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
    if (result?.kind !== 'result' || nextSuggestion(result.outcome, result.verdict) === '') return null;
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
    this.pending = null;
    this.stateValue = 'waiting_input';
    const out = [this.append({ kind: 'approval', approved: false, write: false })];
    if (pending) this.logUnexecuted(pending, 'declined');
    return out;
  }

  /**
   * 제안했지만 실행되지 않은 배정도 결정 로그에 남긴다 (SPEC §8) — 1차 decided 와 2차 declined/blocked 를
   * 같은 id 로. 1차 줄 모양은 위임과 같다 (`firstLine` + 세션 id).
   */
  private logUnexecuted(pending: Pending, status: 'declined' | 'blocked', approvedBy?: ApprovedBy): void {
    const first = firstLine(this.deps.matrix, pending.plan, pending.title, pending.reason);
    const decision = { ...first, note: `${first.note ?? ''} · ${this.noteOf(pending, approvedBy)}` };
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

  /** 모델은 요약만 한다. 다음 제안은 코드가 계산한다 (SPEC §6.4.4). 요약이 실패해도 제안은 남긴다. */
  private async summarize(title: string, d: Delegated): Promise<TranscriptRecord[]> {
    // 결과가 이미 기록에 붙은 뒤다 — 사다리 상태(다음에 올릴 수 있는 단계)가 이 결과를 본다.
    const next = nextSuggestion(d.outcome, d.verdict, this.ladderOffer());
    const { matrix, catalog, budget, conduct } = this.deps;
    if (budget.limitReached()) {
      return [
        this.append({ kind: 'error', text: `누적 상한에 닿아 요약을 시작하지 않는다 (${budget.summary()}) — 결과 카드를 본다.` }),
        this.append({ kind: 'summary', text: '', next }),
      ];
    }
    const slot = conductorSlot(catalog);
    try {
      const run = await conduct(slot, buildSummaryPrompt(title, d));
      budget.charge(`${slot.label}·${slot.effort}`, run.actualUsd, estimateUsd(matrix, slot), run.meteredUsd, slot.plan);
      budget.countTokens(run.usage);
      if (!run.ok) {
        return [
          this.append({ kind: 'error', text: `요약을 받지 못했다 — 결과 카드를 본다: ${run.text || '엔진이 실패했다'}` }),
          this.append({ kind: 'summary', text: '', next }),
        ];
      }
      return [this.append({ kind: 'summary', text: run.text.trim(), next })];
    } catch (error) {
      return [
        this.append({ kind: 'error', text: `요약을 받지 못했다 — 결과 카드를 본다: ${why(error)}` }),
        this.append({ kind: 'summary', text: '', next }),
      ];
    }
  }
}
