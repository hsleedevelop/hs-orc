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
import type { AssignmentPlan } from './assign.ts';
import type { Budget, BudgetMark } from './budget.ts';
import { buildSummaryPrompt, conductorSlot, directAnswer, nextSuggestion } from './conductor.ts';
import { buildContext, type ContextLimits } from './context.ts';
import { appendDecision } from './decision-log.ts';
import { firstLine, unexecutedLine } from './decide.ts';
import { delegate, type Delegated } from './delegate.ts';
import { estimateUsd, type EngineReport, type SlotExecutor } from './executor.ts';
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
  /** 이 세션만의 누적 상한이다 (D-032 A2) — 셸이 세션마다 다른 Budget 을 넘긴다. 앱 전체 합은 표시만 한다. */
  readonly budget: Budget;
  readonly journal: Journal;
  /** 직접 답·요약 전용. 지휘자 슬롯이 reviewer 자리라 쓰기는 어차피 붙지 않는다. */
  readonly conduct: SlotExecutor;
  /** 위임 실행기. 쓰기 여부는 승인 때 정해진다 (D-025). */
  readonly executorFor: (write: boolean) => SlotExecutor;
  readonly now?: () => Date;
  /** 없으면 `loadLimits()` 값 (SPEC §6.4.3). */
  readonly context?: ContextLimits;
}

const why = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Pending {
  /** 사용자가 쓴 문장 그대로. 결정 로그에 이것이 남는다. */
  readonly title: string;
  readonly plan: AssignmentPlan;
  readonly reason: string;
}

export class ConversationSession {
  readonly file: string;
  private readonly deps: SessionDeps;
  private turn: number;
  private stateValue: SessionState = 'waiting_input';
  private pending: Pending | null = null;
  /** 기록은 열 때 한 번 읽고 이후엔 append 와 함께 들고 있는다 — 메시지마다 JSONL 을 다시 읽지 않는다. */
  private readonly log: TranscriptRecord[];

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.file = transcriptPath(deps.dir, deps.id);
    // 다시 열면 턴 번호를 이어 간다. 끝에 승인 안 된 배정이 남아 있어도 **되살리지 않는다** —
    // 그 사이 비용·폴더가 바뀌었을 수 있다. 화면은 그 카드를 보여주되 승인 버튼은 없다.
    this.log = readTranscript(this.file).records;
    this.turn = this.log.reduce((max, r) => Math.max(max, r.turn), 0);
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

  /**
   * 위임 도중 앱이 끊겼다 — 승인 뒤에 결과도 오류도 없다. 화면은 "결과가 기록되지 않았다" 를 띄운다.
   * 지금 돌고 있는 위임은 끊긴 것이 아니다.
   */
  get interrupted(): boolean {
    if (this.stateValue === 'working') return false;
    const last = this.log.at(-1);
    return last?.kind === 'approval' && last.approved;
  }

  async send(message: string): Promise<TranscriptRecord[]> {
    this.require('waiting_input', '메시지 전송');
    const text = message.trim();
    if (!text) return [];
    // require() 를 지난 뒤, 첫 await 전에 바로 working 으로 바꾼다 — 겹쳐 들어온 두 번째 호출이
    // 같은 require() 를 통과해 턴을 두 번 올리는 것을 막는다 (final-review #2).
    this.stateValue = 'working';
    this.turn += 1;
    let user: TranscriptRecord;
    try {
      user = this.append({ kind: 'user', text });
    } catch (error) {
      // 기록 자체가 안 됐다 — 화면에 남길 곳(트랜스크립트)이 없으니 에러 레코드로 삼키지 않고
      // 턴·상태를 되돌려 던진다. GUI 가 이 예외를 보여준다.
      this.turn -= 1;
      this.stateValue = 'waiting_input';
      throw error;
    }
    return [user, ...(await this.route(text))];
  }

  /** 제안된 행(또는 사용자가 고른 행)으로 **마지막 메시지**의 배정을 받는다. 새 메시지를 만들지 않는다. */
  async planAs(taskId: string): Promise<TranscriptRecord[]> {
    this.require('waiting_input', '행 지정');
    const last = this.records().findLast((r) => r.kind === 'user');
    if (last?.kind !== 'user') throw new SessionStateError('배정할 메시지가 없다.');
    // send() 와 같은 이유로 첫 await 전에 바로 바꾼다 (final-review #2).
    this.stateValue = 'working';
    return this.route(last.text, taskId);
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
  private async route(text: string, taskId?: string): Promise<TranscriptRecord[]> {
    const { matrix, catalog, dir } = this.deps;
    try {
      // D-033: 지휘자가 대화 맥락으로 직접 답하고 SUGGEST 로 행을 제안한다 — 맥락 없는
      // 폴백의 선택이 대화성 후속을 잘못 위임하는 일이 없다. 규칙이 놓친 메시지는 항상 직접 답으로 간다.
      const routed = await routeWithFallback(matrix, catalog, text, {
        cwd: dir,
        classifyLlm: false,
        ...(taskId ? { taskId } : {}),
      });
      const notes = routed.fallback ? [routed.fallback.line] : [];
      const result = routed.result;
      if (result.stage !== 'assigned') return this.answer(text, notes);

      const { plan } = result;
      const { primary, reviewer } = plan.slots;
      this.pending = { title: text, plan, reason: result.reason };
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
    } catch (error) {
      this.stateValue = 'waiting_input';
      return [this.append({ kind: 'error', text: `라우팅이 끝나지 못했다: ${why(error)}` })];
    }
  }

  private async answer(text: string, notes: readonly string[]): Promise<TranscriptRecord[]> {
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
      const answer = await directAnswer(conduct, slot, matrix, context.text, text);
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
          ...(context.cut ? { cut: context.cut } : {}),
        }),
      ];
    } catch (error) {
      return [this.append({ kind: 'error', text: `직접 답을 받지 못했다: ${why(error)}` })];
    } finally {
      this.stateValue = 'waiting_input';
      this.recordSpend(mark);
    }
  }

  async approve(options: { readonly verify?: readonly string[]; readonly write?: boolean } = {}): Promise<TranscriptRecord[]> {
    this.require('blocked', '승인');
    const pending = this.pending;
    if (!pending) throw new SessionStateError('승인할 배정이 없다.');
    const write = options.write === true;
    if (write && this.deps.kind === 'scratch') {
      throw new SessionStateError('스크래치 세션은 쓰기를 켤 수 없다 (SPEC §6.4.1).');
    }
    const { matrix, dir, budget, journal } = this.deps;
    const out = [this.append({ kind: 'approval', approved: true, write })];
    this.pending = null;
    // answer()·summarize() 와 같은 규칙이다 — 멈출지 묻는 곳은 전부 limitReached() (D-030).
    if (budget.limitReached()) {
      this.stateValue = 'waiting_input';
      out.push(this.append({ kind: 'error', text: `누적 상한에 닿아 위임을 시작하지 않는다 (${budget.summary()}).` }));
      this.logUnexecuted(pending, 'blocked');
      return out;
    }
    this.stateValue = 'working';
    const mark = budget.mark();
    try {
      const ref = this.resumable(pending.plan, write);
      const context = buildContext(this.records(), this.contextLimits, {
        before: this.turn,
        ...(ref ? { after: ref.turn } : {}),
      });
      const prompt = context.text ? `[최근 대화]\n${context.text}\n\n[이번 요청]\n${pending.title}` : pending.title;
      const d = await delegate({
        matrix,
        plan: pending.plan,
        reason: pending.reason,
        title: pending.title,
        prompt,
        verify: options.verify ?? [],
        cwd: dir,
        execute: this.deps.executorFor(write),
        budget,
        journal,
        note: `session ${this.deps.id}`,
        ...(ref ? { resumePrimary: ref.id, ...(ref.baseline ? { resumeBaseline: ref.baseline } : {}) } : {}),
      });
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
    } finally {
      this.stateValue = 'waiting_input';
      this.recordSpend(mark);
    }
    return out;
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
   */
  private resumable(plan: AssignmentPlan, write: boolean): { id: string; turn: number; baseline?: EngineReport } | null {
    const last = this.records().findLast((r) => r.kind === 'result');
    if (last?.kind !== 'result' || !last.engineSession) return null;
    const p = plan.slots.primary;
    const s = last.engineSession;
    if (s.engine !== p.engine || s.modelId !== p.modelId || s.effort !== p.effort) return null;
    if (write && this.deps.catalog.engines[p.engine].resume?.write === false) return null;
    return { id: s.id, turn: last.turn, ...(s.reported ? { baseline: s.reported } : {}) };
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
  private logUnexecuted(pending: Pending, status: 'declined' | 'blocked'): void {
    const first = firstLine(this.deps.matrix, pending.plan, pending.title, pending.reason);
    const decision = { ...first, note: `${first.note ?? ''} · session ${this.deps.id}` };
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
    const next = nextSuggestion(d.outcome, d.verdict);
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
