/**
 * 사다리 적용 경로 (D-068). 실행기·분류는 전부 가짜다 — 엔진도 Jev 도 부르지 않는다(분류기를 주입하지 않는다 = `HS_ORC_JEV=off` 와 같다).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMatrix, type ModelKey } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import type { ApprovalMode } from '../../data/limits.ts';
import { isModelPick } from '../approval.ts';
import { Budget } from '../budget.ts';
import { readDecisions } from '../decision-log.ts';
import type { SlotExecutor, SlotRun, SlotRunOptions } from '../executor.ts';
import { Journal } from '../journal.ts';
import { ESCALATION_ORDER, LadderError, planLadder, type EscalationStage } from '../ladder.ts';
import { ConversationSession, SessionStateError } from '../session.ts';

const isolate = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-ladder-log-'));
  process.env['HS_ORC_DECISION_LOG'] = path.join(dir, 'log.jsonl');
  process.env['HS_ORC_RUN_STORE'] = path.join(dir, 'runs');
};

const matrix = loadMatrix();
const catalog = loadEngines();
const row = (id: string) => matrix.assignments.find((a) => a.id === id)!;
const done = (text: string, extra: Partial<SlotRun> = {}): SlotRun => ({ ok: true, text, rawStdout: '', rawStderr: '', durationMs: 1, ...extra });
const killed = (): SlotRun => ({ ok: false, cancelled: true, text: '', rawStdout: '', rawStderr: '', durationMs: 1 });
const tick = () => new Promise<void>((r) => setImmediate(r));
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i += 1) await tick();
  assert.ok(cond(), '조건이 오지 않았다');
};

/** primary 는 매번 엔진 세션 id 를 남기고(resume 대조용), reviewer 는 PASS. `hang` 이면 primary 가 취소 신호까지 멈춘다. */
const fake = () => {
  const calls: { role: string; model: string; effort: string; prompt: string; options: SlotRunOptions | undefined }[] = [];
  let hang = false;
  const exec: SlotExecutor = (slot, prompt, options) => {
    calls.push({ role: slot.role, model: slot.model, effort: slot.effort, prompt, options });
    if (slot.role === 'primary' && hang) {
      return new Promise<SlotRun>((resolve) => options?.signal?.addEventListener('abort', () => resolve(killed()), { once: true }));
    }
    return Promise.resolve(slot.role === 'reviewer' ? done('PASS') : done(`ran:${slot.model}`, { sessionId: `eng-${calls.length}` }));
  };
  return { exec, calls, primaries: () => calls.filter((c) => c.role === 'primary'), hangNext: () => { hang = true; } };
};

const conduct: SlotExecutor = (_slot, prompt) => Promise.resolve(done(prompt.startsWith('아래 위임 결과') ? '요약 한 줄' : '직접 답\nSUGGEST: NONE'));

const make = (mode: ApprovalMode = 'manual', dir = mkdtempSync(path.join(os.tmpdir(), 'hs-ladder-'))) => {
  const x = fake();
  const open = () =>
    new ConversationSession({
      matrix, catalog, kind: 'project', dir, id: '0930-1300-lll', budget: new Budget(50, 5_000_000), journal: new Journal(),
      conduct, executorFor: () => x.exec, approvalMode: mode,
    });
  return { ...x, dir, open, session: open() };
};
const REQUEST = '이 타입 에러 고쳐줘'; // 규칙 분류가 R01 로 잡는다
const lastPlan = (s: ConversationSession) => {
  const p = s.records().findLast((r) => r.kind === 'plan');
  assert.equal(p?.kind, 'plan');
  return p?.kind === 'plan' ? p : (undefined as never);
};

describe('사다리 — 단계 적용 (결정론)', () => {
  it('R01 을 ①근거 보강 → ②effort → ③모델 → ④reviewer 순으로 한 칸씩 올리고 비용을 다시 잰다', () => {
    const base = row('R01'); // Luna medium / Haiku low, $0.39
    const steps: EscalationStage[] = [];
    const seen: string[] = [];
    let cost: number[] = [];
    for (let s = planLadder(matrix, catalog, base, []); s; s = planLadder(matrix, catalog, base, s.applied.done)) {
      steps.push(s.applied.stage);
      const { primary, reviewer } = s.plan.slots;
      seen.push(`${primary.model}/${primary.effort}+${reviewer.model}/${reviewer.effort}`);
      cost = [...cost, s.plan.cost.totalUsd];
    }
    assert.deepEqual(steps, [...ESCALATION_ORDER]);
    assert.deepEqual(seen, ['luna/medium+haiku/low', 'luna/high+haiku/low', 'terra/high+haiku/low', 'terra/high+sonnet/low']);
    assert.deepEqual(cost, [0.39, 0.39, 1.61, 6.49], '모델이 오른 단계부터 economics 로 다시 계산한다');
  });

  it('L5(Astra·Fable) 로 직행하는 경로가 없다 — 어느 행·어느 단계든 모델은 자기 벤더에서 한 칸만 오르고 INV-1 이 유지된다', () => {
    const rank = (model: ModelKey): number => Math.max(...Object.values(matrix.tiers).map((t) => t.indexOf(model)));
    const vendor = (model: ModelKey) => (matrix.tiers.openai.includes(model) ? 'openai' : 'anthropic');
    for (const base of matrix.assignments) {
      for (let s = planLadder(matrix, catalog, base, []); s; s = planLadder(matrix, catalog, base, s.applied.done)) {
        const { primary, reviewer } = s.plan.slots;
        assert.notEqual(vendor(primary.model), vendor(reviewer.model), `${base.id} ${s.applied.label} INV-1`);
        assert.ok(rank(primary.model) <= rank(base.primary.model) + 1, `${base.id} primary 는 한 칸까지`);
        assert.ok(rank(reviewer.model) <= rank(base.reviewer.model) + 1, `${base.id} reviewer 는 한 칸까지`);
      }
    }
  });

  it('올릴 곳이 없는 단계는 이유와 함께 건너뛰고, 남은 단계가 모두 그러면 끝난다 (R11 Astra max·Fable max)', () => {
    const first = planLadder(matrix, catalog, row('R11'), []);
    assert.equal(first?.applied.stage, 'evidence');
    assert.equal(planLadder(matrix, catalog, row('R11'), first?.applied.done ?? []), null);
    // R07(Astra xhigh · Opus xhigh): ② 는 max 로 오르고 ③ 은 Astra 가 최상위라 건너뛰며 ④ 가 적용된다 — 이유가 카드 줄에 남는다.
    const r07 = planLadder(matrix, catalog, row('R07'), ['evidence', 'effort']);
    assert.equal(r07?.applied.stage, 'reviewer');
    assert.deepEqual(r07?.applied.done, ['evidence', 'effort', 'model', 'reviewer']);
    assert.match(r07?.applied.changes[2] ?? '', /③모델 상향 — 건너뜀: primary Astra 는 openai 계층의 최상위다/);
    assert.equal(r07?.plan.slots.reviewer.model, 'fable');
    assert.equal(r07?.plan.slots.primary.effort, 'max');
  });

  it('순서를 건너뛰는 요청은 던진다 (L5 직행 불가)', async () => {
    isolate();
    const { session } = make();
    await session.send(REQUEST);
    await session.approve();
    assert.throws(() => session.escalate('reviewer'), LadderError);
    assert.throws(() => session.escalate('model'), /상향 순서를 건너뛸 수 없다/);
    assert.equal(session.state, 'waiting_input', '던진 요청이 카드를 세우지 않는다');
  });
});

describe('사다리 — 세션 (D-068)', () => {
  it('위임이 끝난 뒤에만 오른다 — 결과 전·블록 중·새 메시지 뒤에는 없다', async () => {
    isolate();
    const { session } = make();
    assert.throws(() => session.escalate(), SessionStateError);
    await session.send(REQUEST);
    assert.equal(session.ladderOffer(), null, '승인 대기 중인 카드는 사다리가 아니다');
    assert.throws(() => session.escalate(), /waiting_input 상태에서만/);
    await session.approve();
    assert.equal(session.ladderOffer()?.stage, 'evidence');
    await session.send('다른 얘기 하자');
    assert.equal(session.ladderOffer(), null, '새 요청이 이전 사다리를 끝낸다');
  });

  it('누르면 같은 요청으로 상향 카드 1장만 선다 — 시작하지 않고 카드에 올라간 것이 적힌다', async () => {
    isolate();
    const { session, primaries } = make();
    await session.send(REQUEST);
    await session.approve();
    const before = primaries().length;
    const out = session.escalate();
    assert.deepEqual(out.map((r) => r.kind), ['plan']);
    assert.equal(session.state, 'blocked');
    assert.equal(primaries().length, before, '버튼은 카드만 세운다');
    const plan = lastPlan(session);
    assert.equal(plan.taskId, 'R01');
    assert.match(plan.reason, /^사다리 ①코드·로그·재현 조건 보강 · 키워드 /);
    assert.equal(plan.ladder?.stage, 'evidence');
    assert.match(plan.ladder?.changes[0] ?? '', /실패의 reviewer 검증·증거/);
  });

  it('네 단계를 차례로 승인하면 카드의 effort·모델·reviewer·비용이 그 순서로 오르고, 끝에서는 더 못 올린다', async () => {
    isolate();
    const { session } = make();
    await session.send(REQUEST);
    await session.approve();
    const seen: string[] = [];
    for (const stage of ESCALATION_ORDER) {
      session.escalate();
      const p = lastPlan(session);
      assert.equal(p.ladder?.stage, stage);
      seen.push(`${p.primary.split(' →')[0]} | ${p.reviewer.split(' →')[0]} | $${p.estimateUsd}`);
      await session.approve();
    }
    assert.deepEqual(seen, ['Luna·medium | Haiku·low | $0.39', 'Luna·high | Haiku·low | $0.39', 'Terra·high | Haiku·low | $1.61', 'Terra·high | Sonnet·low | $6.49']);
    assert.equal(session.ladderOffer(), null);
    assert.throws(() => session.escalate(), /더 올릴 단계가 없다/);
    const summary = session.records().findLast((r) => r.kind === 'summary');
    assert.match(summary?.kind === 'summary' ? summary.next : '', /더 올릴 곳이 없다/);
  });

  it('마지막 카드의 changes 는 지나온 단계를 누적해 보인다', async () => {
    isolate();
    const { session } = make();
    await session.send(REQUEST);
    await session.approve();
    for (let i = 0; i < 3; i += 1) { session.escalate(); await session.approve(); }
    session.escalate();
    const changes = lastPlan(session).ladder?.changes ?? [];
    assert.equal(changes.length, 4);
    assert.match(changes[1] ?? '', /②effort 상향 — primary Luna medium → high/);
    assert.match(changes[2] ?? '', /③모델 상향 — primary Luna → Terra \(high\)/);
    assert.match(changes[3] ?? '', /④reviewer 추가 — reviewer Haiku → Sonnet/);
  });

  it('위임은 새 엔진 세션이고 직전 실패 근거가 프롬프트에 실린다 — 일반 위임은 그대로 잇는다 (D-059)', async () => {
    isolate();
    const { session, primaries } = make();
    await session.send(REQUEST);
    await session.approve();
    session.escalate();
    await session.approve();
    const ladderRun = primaries().at(-1);
    assert.equal(ladderRun?.options?.resume, undefined, '같은 primary 인 ① 도 잇지 않는다');
    assert.match(ladderRun?.prompt ?? '', /\[직전 시도 실패 근거 — 사다리 ①코드·로그·재현 조건 보강\]/);
    assert.match(ladderRun?.prompt ?? '', /직전 결과: unverified · reviewer PASS/);
    assert.match(ladderRun?.prompt ?? '', /\[이번 요청\]\n이 타입 에러 고쳐줘/);
    // 대조: 사다리가 아닌 다음 위임은 같은 primary 면 잇는다 — 위 단언이 공허하지 않다.
    await session.send(REQUEST);
    await session.approve();
    assert.ok(primaries().at(-1)?.options?.resume, '사다리가 아닌 위임은 엔진 세션을 잇는다');
  });

  it('결정 로그 1차 trigger 에 사다리 단계가, note 에 이전 결정이 남는다 — tier 는 올린 뒤 값이다', async () => {
    isolate();
    const { session } = make();
    await session.send(REQUEST);
    await session.approve();
    const firstId = session.records().findLast((r) => r.kind === 'result');
    session.escalate();
    await session.approve();
    session.escalate();
    await session.approve();
    const rows = readDecisions().filter((d) => d.status === 'decided');
    const ladderRows = rows.filter((d) => d.trigger.includes('사다리'));
    assert.equal(ladderRows.length, 2);
    assert.match(ladderRows[0]?.trigger ?? '', /^매트릭스 R01 · 사다리 ①코드·로그·재현 조건 보강 · 키워드 /);
    assert.match(ladderRows[1]?.trigger ?? '', /사다리 ②effort 상향 · 키워드 /, '원 근거는 한 번만 붙는다');
    assert.equal(ladderRows[1]?.tier, 'luna/high');
    assert.match(ladderRows[0]?.note ?? '', new RegExp(`사다리 이전 결정 ${firstId?.kind === 'result' ? firstId.decisionId : ''}`));
    assert.equal(rows.find((d) => !d.trigger.includes('사다리'))?.trigger.startsWith('매트릭스 R01 · 키워드'), true);
  });
});

describe('사다리 — 승인 방식과 A3 (D-064 ↔ D-068)', () => {
  const codes = (s: ConversationSession) => (lastPlan(s).asked ?? []).map((a) => a.code);

  it('auto 에서도 사다리 배정은 A3 로 묻는다 — 자동 시작하지 않는다 (같은 행·H1 중복 없음)', async () => {
    isolate();
    const { session, primaries } = make('auto');
    const first = await session.send(REQUEST);
    assert.ok(first.some((r) => r.kind === 'approval'), '대조: 사다리가 아닌 배정은 auto 에서 묻지 않는다');
    const ran = primaries().length;
    session.escalate();
    assert.equal(session.state, 'blocked');
    assert.deepEqual(codes(session), ['A3']);
    assert.match(lastPlan(session).asked?.[0]?.text ?? '', /사다리 상향/);
    assert.equal(primaries().length, ran, '자동 승인 경로를 타지 않는다');
    await session.approve();
    const approval = session.records().findLast((r) => r.kind === 'approval');
    assert.ok(approval?.kind === 'approval' && approval.by === 'user' && approval.mode === 'auto' && approval.asked?.join() === 'A3');
  });

  it('auto-ask 에서는 A3 한 줄이다(직전 실패·높은 effort 이유가 겹치지 않는다). manual 은 전부 묻는다', async () => {
    isolate();
    const a = make('auto-ask');
    await a.session.send(REQUEST); // 첫 위임이라 A4 로 묻는다
    await a.session.approve();
    a.session.escalate();
    await a.session.approve();
    a.session.escalate(); // ② effort — "행 기본보다 높은 effort" 이유도 같이 걸릴 자리
    assert.deepEqual(codes(a.session), ['A3']);

    const m = make('manual');
    await m.session.send(REQUEST);
    await m.session.approve();
    m.session.escalate();
    assert.deepEqual(codes(m.session), [], 'manual 은 조건과 무관하게 묻는다 — 이유 칸이 비어 있다');
    assert.equal(m.session.state, 'blocked');
  });

  it('사다리 출처는 H1(모델이 고른 행)이 아니다 — 행은 이미 승인해 돌린 행이다', () => {
    assert.equal(isModelPick('사다리 ②effort 상향 · 지휘자 제안 R02'), false);
    assert.equal(isModelPick('지휘자 제안 R02'), true);
  });
});

describe('사다리 — 취소·재열기 (D-066·D-063)', () => {
  it('사다리 위임을 취소해도 단계는 소모되지 않는다 — 같은 단계가 다시 선다', async () => {
    isolate();
    const x = make();
    await x.session.send(REQUEST);
    await x.session.approve();
    x.session.escalate();
    x.hangNext();
    const running = x.session.approve();
    await until(() => x.session.cancellable);
    x.session.cancel();
    await running;
    const result = x.session.records().findLast((r) => r.kind === 'result');
    assert.ok(result?.kind === 'result' && result.outcome === 'cancelled');
    assert.equal(x.session.ladderOffer()?.stage, 'evidence', '취소는 실패가 아니고 단계를 쓰지 않는다');
    x.session.escalate();
    assert.equal(lastPlan(x.session).ladder?.stage, 'evidence');
  });

  it('다시 열어도 사다리 상태가 기록에서 그대로 계산된다 — 승인 전에 끊긴 카드는 같은 단계를 다시 세운다', async () => {
    isolate();
    const x = make();
    await x.session.send(REQUEST);
    await x.session.approve();
    x.session.escalate(); // 카드만 섰고 앱이 꺼졌다
    const reopened = x.open();
    assert.equal(reopened.state, 'waiting_input', '선 카드는 되살리지 않는다 (D-064)');
    assert.equal(reopened.ladderOffer()?.stage, 'evidence', '결과가 없었으니 단계가 소모되지 않았다');
    reopened.escalate();
    await reopened.approve();
    const again = x.open();
    assert.equal(again.ladderOffer()?.stage, 'effort', '돈 단계는 기록에서 센다');
  });
});
