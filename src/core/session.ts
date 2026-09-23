/**
 * 대화 세션 (SPEC §6.4, D-031). **헤드리스다** — 셸은 이것을 부르고 기록을 그린다.
 * 셸마다 따로 두면 같은 메시지에 셸마다 다르게 답한다 (D-026 전례).
 *
 * 메시지 1건: 기록 → 라우팅(결정론 파이프라인 그대로) → 배정이면 승인 대기(`blocked`),
 * 아니면 지휘자 직접 답. 다음 위임을 **스스로 시작하지 않는다** (D-015).
 */
import type { Engines } from '../data/engines.ts';
import type { Matrix } from '../data/matrix.ts';
import { loadLimits } from '../data/limits.ts';
import type { Budget } from './budget.ts';
import { conductorSlot, directAnswer } from './conductor.ts';
import { buildContext, lastSummary, type ContextLimits } from './context.ts';
import { estimateUsd, type SlotExecutor } from './executor.ts';
import type { Journal } from './journal.ts';
import { routeWithFallback } from './pipeline.ts';
import {
  appendRecord,
  readTranscript,
  transcriptPath,
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
  /** 세션을 여러 개 열어도 누적 상한은 하나다 (D-030) — 셸이 같은 Budget 을 넘긴다. */
  readonly budget: Budget;
  readonly journal: Journal;
  /** 직접 답·요약 전용. 지휘자 슬롯이 reviewer 자리라 쓰기는 어차피 붙지 않는다. */
  readonly conduct: SlotExecutor;
  /** 위임 실행기. 쓰기 여부는 승인 때 정해진다 (D-025). */
  readonly executorFor: (write: boolean) => SlotExecutor;
  /** D-026: 끄면 유료 분류 폴백이 없다. 테스트는 끈다. */
  readonly classifyLlm?: boolean;
  readonly now?: () => Date;
  /** 없으면 `loadLimits()` 값 (SPEC §6.4.3). */
  readonly context?: ContextLimits;
}

const why = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class ConversationSession {
  readonly file: string;
  private readonly deps: SessionDeps;
  private turn: number;
  private stateValue: SessionState = 'waiting_input';

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.file = transcriptPath(deps.dir, deps.id);
    // 다시 열면 턴 번호를 이어 간다. 끝에 승인 안 된 배정이 남아 있어도 **되살리지 않는다** —
    // 그 사이 비용·폴더가 바뀌었을 수 있다. 화면은 그 카드를 보여주되 승인 버튼은 없다.
    this.turn = readTranscript(this.file).records.reduce((max, r) => Math.max(max, r.turn), 0);
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
    return readTranscript(this.file).records;
  }

  async send(message: string): Promise<TranscriptRecord[]> {
    this.require('waiting_input', '메시지 전송');
    const text = message.trim();
    if (!text) return [];
    this.turn += 1;
    const user = this.append({ kind: 'user', text });
    return [user, ...(await this.route(text))];
  }

  /** 제안된 행(또는 사용자가 고른 행)으로 **마지막 메시지**의 배정을 받는다. 새 메시지를 만들지 않는다. */
  async planAs(taskId: string): Promise<TranscriptRecord[]> {
    this.require('waiting_input', '행 지정');
    const last = this.records().findLast((r) => r.kind === 'user');
    if (last?.kind !== 'user') throw new SessionStateError('배정할 메시지가 없다.');
    return this.route(last.text, taskId);
  }

  private append(entry: TranscriptEntry): TranscriptRecord {
    const record = { ...entry, v: 1, at: (this.deps.now?.() ?? new Date()).toISOString(), turn: this.turn } as TranscriptRecord;
    appendRecord(this.file, record);
    return record;
  }

  private require(state: SessionState, action: string): void {
    if (this.stateValue !== state) {
      throw new SessionStateError(`${action}은(는) ${state} 상태에서만 한다 (지금: ${this.stateValue}).`);
    }
  }

  private async route(text: string, taskId?: string): Promise<TranscriptRecord[]> {
    const { matrix, catalog, dir } = this.deps;
    const hint = taskId ? null : lastSummary(this.records());
    const routed = await routeWithFallback(matrix, catalog, text, {
      cwd: dir,
      ...(this.deps.classifyLlm === undefined ? {} : { classifyLlm: this.deps.classifyLlm }),
      ...(taskId ? { taskId } : {}),
      ...(hint ? { hint } : {}),
    });
    const notes = routed.fallback ? [routed.fallback.line] : [];
    const result = routed.result;
    if (result.stage !== 'assigned') return this.answer(text, notes);

    const { plan } = result;
    const { primary, reviewer } = plan.slots;
    this.stateValue = 'blocked';
    return [
      this.append({
        kind: 'plan',
        taskId: plan.assignment.id,
        title: plan.assignment.task,
        reason: result.reason,
        primary: `${primary.label}·${primary.effort} → ${primary.engine}/${primary.modelId}`,
        reviewer: `${reviewer.label}·${reviewer.effort} → ${reviewer.engine}/${reviewer.modelId}`,
        estimateUsd: plan.cost.totalUsd,
        notes,
      }),
    ];
  }

  private async answer(text: string, notes: readonly string[]): Promise<TranscriptRecord[]> {
    const { matrix, catalog, budget, conduct } = this.deps;
    if (budget.limitReached()) {
      return [this.append({ kind: 'error', text: `누적 상한에 닿아 직접 답도 시작하지 않는다 (${budget.summary()}).` })];
    }
    const slot = conductorSlot(catalog);
    this.stateValue = 'working';
    try {
      const context = buildContext(this.records(), this.contextLimits, { before: this.turn });
      const answer = await directAnswer(conduct, slot, matrix, context, text);
      const charge = budget.charge(`${slot.label}·${slot.effort}`, answer.run.actualUsd, estimateUsd(matrix, slot), answer.run.meteredUsd, slot.plan);
      budget.countTokens(answer.run.usage);
      if (!answer.run.ok) {
        return [this.append({ kind: 'error', text: `직접 답을 받지 못했다: ${answer.run.text || '엔진이 실패했다'}` })];
      }
      return [
        this.append({
          kind: 'direct',
          text: answer.body,
          suggest: answer.suggest,
          cost: `$${charge.usd.toFixed(4)} ${charge.source}`,
          notes,
        }),
      ];
    } catch (error) {
      return [this.append({ kind: 'error', text: `직접 답을 받지 못했다: ${why(error)}` })];
    } finally {
      this.stateValue = 'waiting_input';
    }
  }
}
