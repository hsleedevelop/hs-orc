/**
 * 승인 방식 3종 (D-064 3단계). 실행기·Jev 는 전부 가짜다 — 엔진도 외부 서비스도 부르지 않는다.
 * 행은 가짜 Jev 로 고른다(`Jev Rxx …` 근거 = 확신 있는 행, D-065 결정 10) — 비용이 다른 행을 골라 A1 을 가른다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines, type Engines } from '../../data/engines.ts';
import { loadLimits, type ApprovalMode } from '../../data/limits.ts';
import type { JevChoiceAnswer, RowClassifier } from '../../adapters/jev.ts';
import { assign } from '../assign.ts';
import { H6_TEXT, evaluateApproval, evaluateRead, isModelPick } from '../approval.ts';
import { readerSlot } from '../reader.ts';
import { uncommittedFiles } from '../evidence-gather.ts';
import { Budget } from '../budget.ts';
import { Journal } from '../journal.ts';
import type { SlotExecutor, SlotRun, SlotRunOptions } from '../executor.ts';
import { ConversationSession, SCAFFOLD_GUIDE } from '../session.ts';
import { readDecisions } from '../decision-log.ts';
import { appendRecord, transcriptPath, type TranscriptRecord } from '../transcript.ts';

const isolate = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-modes-log-'));
  process.env['HS_ORC_DECISION_LOG'] = path.join(dir, 'log.jsonl');
  process.env['HS_ORC_RUN_STORE'] = path.join(dir, 'runs');
};

const matrix = loadMatrix();
const catalog = loadEngines();
const done = (text: string, extra: Partial<SlotRun> = {}): SlotRun => ({ ok: true, text, rawStdout: '', rawStderr: '', durationMs: 1, ...extra });
const tick = () => new Promise<void>((r) => setImmediate(r));

/** 위임 가짜 — reviewer 는 PASS. 시작된 슬롯을 센다(자동이 무엇을 시작했는지 본다). */
const delegateSpy = () => {
  const roles: string[] = [];
  const exec: SlotExecutor = (slot, prompt) => {
    roles.push(slot.role);
    return Promise.resolve(slot.role === 'reviewer' ? done('PASS') : done(`ran:${prompt}`));
  };
  return { exec, roles, primaries: () => roles.filter((r) => r === 'primary').length };
};
/** 지휘자 가짜 — 요약 요청이면 요약을, 아니면 직접 답을 준다. */
const conduct = (direct = '직접 답\nSUGGEST: NONE'): SlotExecutor => (_slot, prompt) =>
  Promise.resolve(done(prompt.startsWith('아래 위임 결과') ? '요약 한 줄' : direct));

/** 다음 메시지가 고를 행을 바꿀 수 있는 가짜 Jev. */
const jev = (row: { current: string }): RowClassifier => () =>
  Promise.resolve({ choice: row.current, probabilities: { [row.current]: 0.95, NONE: 0.05 }, confidence: 0.97, inputTokens: 1, outputTokens: 1, elapsedMs: 1 } satisfies JevChoiceAnswer);

interface Opts {
  mode?: ApprovalMode;
  row?: string;
  execute?: SlotExecutor;
  cat?: Engines;
  budget?: Budget;
  kind?: 'project' | 'scratch';
  dir?: string;
  withJev?: boolean;
  conductor?: SlotExecutor;
  inGit?: boolean;
  /** 없으면 비운다 — 기존 조건(A·H1~H4)은 쓰기 행 기본값(D-086) 없이 본다. */
  writeRows?: readonly string[];
  dirty?: readonly string[];
  /** 미커밋 확인 함수를 그대로 준다 — 실패하는 실제 `git status` 를 싣는다. */
  dirtyFiles?: () => readonly string[] | null;
}
const make = (o: Opts = {}) => {
  const spy = delegateSpy();
  const row = { current: o.row ?? 'R01' };
  const dir = o.dir ?? mkdtempSync(path.join(os.tmpdir(), 'hs-modes-'));
  const budget = o.budget ?? new Budget(20, 2_000_000);
  const session = new ConversationSession({
    matrix, catalog: o.cat ?? catalog, kind: o.kind ?? 'project', dir, id: '0930-1200-mmm', budget, journal: new Journal(),
    conduct: o.conductor ?? conduct(), executorFor: () => o.execute ?? spy.exec,
    ...(o.withJev === false ? {} : { classifier: jev(row) }),
    ...(o.mode ? { approvalMode: o.mode } : {}),
    ...(o.inGit !== undefined ? { inGit: o.inGit } : {}),
    writeRows: o.writeRows ?? [],
    ...(o.dirty ? { dirtyFiles: () => o.dirty ?? [] } : {}),
    ...(o.dirtyFiles ? { dirtyFiles: o.dirtyFiles } : {}),
  });
  return { session, spy, row, dir, budget };
};
/** 첫 위임(A4)을 지나 둔다 — 다른 조건만 보려는 테스트가 쓴다. */
const pastFirst = async (o: Opts = {}) => {
  const m = make({ ...o, mode: 'auto' });
  await m.session.send('첫 요청');
  m.session.setMode(o.mode ?? 'auto-ask');
  return m;
};
const kinds = (r: readonly TranscriptRecord[]) => r.map((x) => x.kind);
const lastPlan = (s: ConversationSession) => s.records().findLast((r) => r.kind === 'plan');
const codes = (s: ConversationSession) => {
  const p = lastPlan(s);
  return p?.kind === 'plan' ? (p.asked ?? []).map((a) => a.code) : [];
};

describe('승인 방식 — manual', () => {
  it('배정마다 승인 대기 — 싸고 확신 있는 읽기 전용 행도 묻는다, 묻는 이유 칸은 비어 있다', async () => {
    isolate();
    const { session, spy } = make({ mode: 'manual' });
    const out = await session.send('아무거나');
    assert.deepEqual(kinds(out), ['user', 'plan']);
    assert.equal(session.state, 'blocked');
    assert.equal(spy.roles.length, 0);
    const plan = out[1];
    assert.ok(plan?.kind === 'plan' && plan.mode === 'manual' && plan.asked?.length === 0);
  });

  it('사람이 승인하면 approval 은 by user·mode manual', async () => {
    isolate();
    const { session } = make({ mode: 'manual' });
    await session.send('아무거나');
    const out = await session.approve();
    assert.deepEqual(out[0], { ...out[0], kind: 'approval', approved: true, write: false, by: 'user', mode: 'manual', asked: [] });
  });
});

describe('승인 방식 — auto-ask (조건별 발동·미발동)', () => {
  it('아무 조건도 안 걸리면 클릭 없이 시작한다 — 카드·자동 approval·결과가 한 호출에 온다', async () => {
    isolate();
    const { session, spy } = await pastFirst({ mode: 'auto-ask', row: 'R01' });
    const out = await session.send('싼 읽기 전용 요청');
    assert.deepEqual(kinds(out), ['user', 'plan', 'approval', 'result', 'summary']);
    const [, plan, approval] = out;
    assert.ok(plan?.kind === 'plan' && plan.asked?.length === 0 && plan.estimateUsd === 0.39, '카드·비용은 그대로 보인다');
    assert.ok(approval?.kind === 'approval' && approval.by === 'auto' && approval.mode === 'auto-ask' && approval.write === false);
    assert.deepEqual(approval.asked, []);
    assert.equal(session.state, 'waiting_input');
    assert.equal(spy.primaries(), 2, '첫 요청 + 이번 요청 — 각각 1건');
  });

  it('A1 — 예상 $10 이상(R05 $10.89)이면 묻고 이유를 카드에 남긴다. R07 $9.12 는 자동', async () => {
    isolate();
    const m = await pastFirst({ row: 'R05' });
    const out = await m.session.send('무거운 조합');
    assert.deepEqual(kinds(out), ['user', 'plan']);
    assert.equal(m.session.state, 'blocked');
    assert.deepEqual(codes(m.session), ['A1']);
    const plan = out[1];
    assert.ok(plan?.kind === 'plan' && plan.asked?.[0]?.text === '예상 $10.89 ≥ $10');
    m.session.reject();
    m.row.current = 'R07';
    assert.equal(kinds(await m.session.send('덜 무거운 조합')).includes('approval'), true);
    assert.equal(m.session.state, 'waiting_input');
  });

  it('A2(토큰) — 남은 토큰이 상한의 20% 미만이면 묻는다, 넉넉하면 자동', async () => {
    isolate();
    const budget = new Budget(20, 1000);
    budget.countTokens({ inputTokens: 700, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 });
    const ok = await pastFirst({ budget });
    assert.equal(ok.session.state, 'waiting_input');
    const low = new Budget(20, 1000);
    const m = await pastFirst({ budget: low });
    low.countTokens({ inputTokens: 900, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 });
    await m.session.send('상한 근처');
    assert.equal(m.session.state, 'blocked');
    assert.deepEqual(codes(m.session), ['A2']);
  });

  it('A2(금액) — api 슬롯이고 남은 금액이 예상의 2배 미만이면 묻는다, 구독제는 금액을 보지 않는다', () => {
    const api: Engines = { ...catalog, engines: { ...catalog.engines, codex: { ...catalog.engines.codex, plan: 'api' } } };
    const a = matrix.assignments.find((x) => x.id === 'R01');
    assert.ok(a);
    const at = (cat: Engines, spent: number) => {
      const budget = new Budget(1, 0);
      budget.charge('x', spent, 0, undefined, 'api');
      return evaluateApproval({
        mode: 'auto-ask', plan: assign(matrix, cat, a), reason: 'Jev R01 p=0.9 conf=0.9', write: false, catalog: cat, budget,
        records: [{ kind: 'approval', approved: true, write: false, v: 1, at: '', turn: 1 }],
      }).asks.map((x) => x.code);
    };
    assert.deepEqual(at(api, 0.5), ['A2'], '남은 $0.5 < 0.39 × 2');
    assert.deepEqual(at(api, 0), [], '남은 $1 ≥ 0.78');
    assert.deepEqual(at(catalog, 0.5), [], '구독제 슬롯만이면 금액 근접은 없다');
  });

  it('A3 — 직전 위임이 실패했는데 같은 행이면 묻는다, 다른 행이거나 성공했으면 자동', async () => {
    isolate();
    let fail = true;
    const exec: SlotExecutor = (slot) => Promise.resolve(slot.role === 'reviewer' ? done(fail ? 'FAIL' : 'PASS') : done('ran'));
    const m = make({ mode: 'auto', row: 'R01', execute: exec });
    await m.session.send('첫 요청');
    assert.equal(m.session.records().findLast((r) => r.kind === 'result')?.kind, 'result');
    const result = m.session.records().findLast((r) => r.kind === 'result');
    assert.ok(result?.kind === 'result' && (result.verdict === 'fail' || result.outcome !== 'ok'), '가짜 reviewer FAIL — 실패 기록');
    m.session.setMode('auto-ask');
    await m.session.send('같은 행 재시도');
    assert.deepEqual(codes(m.session), ['A3']);
    m.session.reject();
    m.row.current = 'R02';
    await m.session.send('다른 행');
    assert.equal(m.session.state, 'waiting_input', '다른 행은 A3 가 아니다');
    fail = false;
  });

  it('A3 — 행 기본보다 높은 effort 는 묻는다', () => {
    const a = matrix.assignments.find((x) => x.id === 'R01');
    assert.ok(a);
    const higher = a.primary.efforts[0] === 'high' ? 'max' : 'high';
    const check = evaluateApproval({
      mode: 'auto-ask', plan: assign(matrix, catalog, a, { primaryEffort: higher }), reason: 'Jev R01 p=0.9 conf=0.9', write: false, catalog,
      budget: new Budget(20, 2_000_000), records: [{ kind: 'approval', approved: true, write: false, v: 1, at: '', turn: 1 }],
    });
    assert.deepEqual(check.asks.map((x) => x.code), ['A3']);
  });

  it('A4 — 세션 첫 위임은 묻고, 승인된 위임이 하나라도 있으면 자동', async () => {
    isolate();
    const m = make({ mode: 'auto-ask' });
    await m.session.send('첫 요청');
    assert.deepEqual(codes(m.session), ['A4']);
    await m.session.approve();
    const out = await m.session.send('둘째 요청');
    assert.equal(kinds(out).includes('approval'), true);
  });

  it('A3·A4 는 취소·거절을 실패·첫 위임의 근거로 삼지 않는다 — 거절만 있으면 아직 첫 위임이다', async () => {
    isolate();
    const m = make({ mode: 'auto-ask' });
    await m.session.send('요청');
    m.session.reject();
    await m.session.send('다시');
    assert.deepEqual(codes(m.session), ['A4']);
  });
});

describe('승인 방식 — H 조건 (auto 에서도 묻는다)', () => {
  it('H1 — 지휘자 제안 배정은 auto 에서도 묻는다', async () => {
    isolate();
    const m = make({ mode: 'auto', withJev: false, conductor: conduct('작업 같다\nSUGGEST: R01') });
    const out = await m.session.send('안녕하세요 이 저장소 좀 봐주세요');
    assert.deepEqual(kinds(out), ['user', 'direct', 'plan']);
    assert.equal(m.session.state, 'blocked');
    assert.deepEqual(codes(m.session), ['H1']);
    assert.equal(m.spy.roles.length, 0);
  });

  it('H1 판정 — 확신 있는 Jev·규칙·수동 지정은 아니고, 지휘자 제안·Haiku 분류·모르는 출처는 맞다 (D-065 결정 10)', () => {
    assert.equal(isModelPick('Jev R03 p=0.90 conf=0.97'), false);
    assert.equal(isModelPick('키워드 리팩터링 (점수 2)'), false);
    assert.equal(isModelPick('수동 지정 R04'), false);
    assert.equal(isModelPick('지휘자 제안 R04'), true);
    assert.equal(isModelPick('Haiku·low 분류 R04'), true);
    assert.equal(isModelPick('알 수 없는 출처'), true);
  });

  it('확신 있는 Jev 행은 H1 이 아니다 — auto 는 첫 위임도 바로 시작한다 (A 는 auto 에서 안 본다)', async () => {
    isolate();
    const m = make({ mode: 'auto', row: 'R05' });
    const out = await m.session.send('무거운 첫 요청');
    assert.deepEqual(kinds(out), ['user', 'plan', 'approval', 'result', 'summary']);
    const approval = out[2];
    assert.ok(approval?.kind === 'approval' && approval.by === 'auto' && approval.mode === 'auto');
  });

  it('H2 — 쓰기 위임으로 보내면 어느 방식에서도 카드가 서고 쓰기가 켜진 채다 — 자동 승인은 쓰기를 켜지 않는다', async () => {
    isolate();
    for (const mode of ['auto-ask', 'auto'] as const) {
      const m = make({ mode });
      const out = await m.session.send('파일을 고쳐줘', { write: true });
      assert.deepEqual(kinds(out), ['user', 'plan'], mode);
      assert.equal(m.session.state, 'blocked');
      const plan = out[1];
      assert.ok(plan?.kind === 'plan' && plan.write === true && plan.asked?.some((a) => a.code === 'H2'), mode);
      assert.equal(m.spy.roles.length, 0);
    }
  });

  it('H2 — 자동 승인된 위임은 언제나 읽기 전용이다', async () => {
    isolate();
    const m = make({ mode: 'auto' });
    const out = await m.session.send('읽기 전용 요청');
    const approval = out.find((r) => r.kind === 'approval');
    assert.ok(approval?.kind === 'approval' && approval.write === false && approval.by === 'auto');
  });

  it('H2 — 스크래치는 쓰기 위임으로 보낼 수 없다 (기록도 남기지 않는다)', async () => {
    isolate();
    const m = make({ mode: 'auto', kind: 'scratch' });
    await assert.rejects(() => m.session.send('고쳐줘', { write: true }), /스크래치/);
    assert.equal(m.session.records().length, 0);
    assert.equal(m.session.state, 'waiting_input');
  });

  it('H3 — 읽기 전용 인자가 없는 primary 엔진(cursor 유형)은 auto 에서도 묻는다', async () => {
    isolate();
    const noRo = { ...catalog.engines.codex } as Record<string, unknown>;
    delete noRo['readOnlyArgv'];
    const cat = { ...catalog, engines: { ...catalog.engines, codex: noRo } } as unknown as Engines;
    const m = make({ mode: 'auto', cat });
    await m.session.send('요청');
    assert.equal(m.session.state, 'blocked');
    assert.deepEqual(codes(m.session), ['H3']);
    const plan = lastPlan(m.session);
    assert.match(plan?.kind === 'plan' ? (plan.asked?.[0]?.text ?? '') : '', /codex .*읽기 전용/);
  });

  it('H3 — 기본 카탈로그의 primary 는 codex·claude 모두 인자로 읽기 전용이 보장돼 걸리지 않는다', () => {
    for (const a of matrix.assignments) {
      const p = assign(matrix, catalog, a).slots.primary.engine;
      assert.notEqual(catalog.engines[p].readOnlyArgv, undefined, `${a.id}/${p}`);
    }
  });
});

describe('git 아닌 폴더의 쓰기 위임 — H4 예고·스캐폴더 안내 (D-074)', () => {
  const H4 = 'git 아닌 폴더 · codex 쓰기 → codex 가 거절한다 (D-055). git init 하거나 쓰기를 끄라';
  const guideOf = (r?: TranscriptRecord) => (r && (r.kind === 'plan' || r.kind === 'direct') ? (r.guide ?? []) : []);

  it('codex primary 쓰기면 어느 방식에서도 H4 를 묻는 이유로 싣고 스캐폴더 안내가 붙는다 — 승인은 막지 않는다', async () => {
    isolate();
    for (const mode of ['auto-ask', 'auto'] as const) {
      const m = make({ mode, inGit: false });
      await m.session.send('파일을 고쳐줘', { write: true });
      const plan = lastPlan(m.session);
      assert.ok(plan?.kind === 'plan' && plan.asked?.some((a) => a.code === 'H4' && a.text === H4), mode);
      assert.deepEqual(guideOf(plan), [SCAFFOLD_GUIDE], `${mode} — H4 는 묻는 이유에 있으니 안내에 겹쳐 싣지 않는다`);
      await m.session.approve({ write: true });
      assert.equal(m.spy.primaries(), 1, `${mode} — 승인하면 그대로 시작한다`);
    }
  });

  it('git 폴더·읽기 전용·git 밖 거절이 없는 엔진(claude primary)은 H4 가 없다 — 안내는 git 아닌 쓰기면 엔진과 무관하다', async () => {
    isolate();
    const inGit = make({ mode: 'auto-ask', inGit: true });
    await inGit.session.send('파일을 고쳐줘', { write: true });
    assert.ok(!codes(inGit.session).includes('H4'));
    assert.deepEqual(guideOf(lastPlan(inGit.session)), []);

    const readOnly = make({ mode: 'auto-ask', inGit: false });
    await readOnly.session.send('읽어줘');
    assert.ok(!codes(readOnly.session).includes('H4'));
    assert.deepEqual(guideOf(lastPlan(readOnly.session)), []);

    const claude = make({ mode: 'auto-ask', inGit: false, row: 'R10' });
    await claude.session.send('설계해줘', { write: true });
    assert.ok(!codes(claude.session).includes('H4'));
    assert.deepEqual(guideOf(lastPlan(claude.session)), [SCAFFOLD_GUIDE]);
  });

  it('manual 은 묻는 이유가 비므로 H4 를 안내 줄로 싣는다 — 카드가 같은 줄을 보인다', async () => {
    isolate();
    const m = make({ mode: 'manual', inGit: false });
    await m.session.send('파일을 고쳐줘', { write: true });
    const plan = lastPlan(m.session);
    assert.deepEqual(plan?.kind === 'plan' ? plan.asked : null, []);
    assert.deepEqual(guideOf(plan), [H4, SCAFFOLD_GUIDE]);
  });

  it('행 없이 직접 답으로 가도 git 아닌 폴더의 쓰기 메시지면 스캐폴딩 안내가 붙는다 — 파일이 있어 스캐폴딩 카드가 서지 않는 폴더 (D-088)', async () => {
    isolate();
    const occupied = () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-modes-occupied-'));
      writeFileSync(path.join(dir, 'README.md'), '#');
      return dir;
    };
    const m = make({ mode: 'auto-ask', inGit: false, withJev: false, dir: occupied() });
    const out = await m.session.send('Expo 프로젝트 생성해줘', { write: true });
    assert.deepEqual(guideOf(out.find((r) => r.kind === 'direct')), [SCAFFOLD_GUIDE]);
    const git = make({ mode: 'auto-ask', inGit: true, withJev: false, dir: occupied() });
    assert.deepEqual(guideOf((await git.session.send('Expo 프로젝트 생성해줘', { write: true })).find((r) => r.kind === 'direct')), []);
  });
});

describe('쓰기 행 기본값 — auto 는 git 폴더에서 쓰기로 바로 시작하고 위험 조짐은 미리 묻는다 (D-086)', () => {
  const WRITE_ROWS = ['R01', 'R03'];
  const guideOf = (r?: TranscriptRecord) => (r?.kind === 'plan' ? (r.guide ?? []) : []);

  it('auto · git · 쓰기 행 · 깨끗한 폴더면 카드는 쓰기 켠 채 보이고 클릭 없이 쓰기로 시작한다', async () => {
    isolate();
    const m = make({ mode: 'auto', row: 'R03', writeRows: WRITE_ROWS, inGit: true });
    const out = await m.session.send('기능 추가해줘');
    assert.deepEqual(kinds(out), ['user', 'plan', 'approval', 'result', 'summary']);
    const [, plan, approval] = out;
    assert.ok(plan?.kind === 'plan' && plan.write === true && plan.asked?.length === 0);
    assert.ok(approval?.kind === 'approval' && approval.by === 'auto' && approval.write === true);
  });

  it('auto-ask 는 쓰기 행도 H2 로 묻는다 — 스위치만 켜진 채 선다', async () => {
    isolate();
    const m = await pastFirst({ mode: 'auto-ask', row: 'R03', writeRows: WRITE_ROWS, inGit: true });
    await m.session.send('기능 추가해줘');
    assert.equal(m.session.state, 'blocked');
    const plan = lastPlan(m.session);
    assert.ok(plan?.kind === 'plan' && plan.write === true);
    assert.deepEqual(codes(m.session), ['H2']);
  });

  it('H5 — 미커밋 변경이 있으면 auto 에서도 묻고 파일을 보인다, manual 은 안내 줄로 싣는다', async () => {
    isolate();
    const dirty = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
    const m = make({ mode: 'auto', row: 'R03', writeRows: WRITE_ROWS, inGit: true, dirty });
    await m.session.send('기능 추가해줘');
    assert.equal(m.session.state, 'blocked');
    assert.equal(m.spy.roles.length, 0);
    assert.deepEqual(codes(m.session), ['H5']);
    const plan = lastPlan(m.session);
    assert.match(plan?.kind === 'plan' ? (plan.asked?.[0]?.text ?? '') : '', /미커밋 변경 4개.*a\.ts, b\.ts, c\.ts 외 1개/);

    const manual = make({ mode: 'manual', row: 'R03', writeRows: WRITE_ROWS, inGit: true, dirty });
    await manual.session.send('기능 추가해줘');
    assert.match(guideOf(lastPlan(manual.session)).join('\n'), /미커밋 변경 4개/);
  });

  it('H5 fail-closed — git status 가 실패하면 깨끗함으로 읽지 않고 묻는다, 자동 시작하지 않는다', async () => {
    isolate();
    const broken = mkdtempSync(path.join(os.tmpdir(), 'hs-modes-nogit-'));
    assert.equal(uncommittedFiles(broken), null, 'git 저장소가 아니면 종료 코드가 0 이 아니다 → null');
    const m = make({ mode: 'auto', row: 'R03', writeRows: WRITE_ROWS, inGit: true, dirtyFiles: () => uncommittedFiles(broken) });
    await m.session.send('기능 추가해줘');
    assert.equal(m.session.state, 'blocked');
    assert.equal(m.spy.roles.length, 0);
    assert.deepEqual(codes(m.session), ['H5']);
    const plan = lastPlan(m.session);
    assert.match(plan?.kind === 'plan' ? (plan.asked?.[0]?.text ?? '') : '', /확인하지 못했다/);
  });

  it('H6 — git 아닌 폴더의 쓰기 행은 묻고 스캐폴딩 안내를 붙이며, 읽기 전용 승인은 막는다 (D-088) — 쓰기를 켜면 승인된다', async () => {
    isolate();
    for (const mode of ['auto', 'manual'] as const) {
      const m = make({ mode, row: 'R03', writeRows: WRITE_ROWS, inGit: false });
      await m.session.send('기능 추가해줘');
      assert.equal(m.session.state, 'blocked');
      const plan = lastPlan(m.session);
      assert.ok(plan?.kind === 'plan' && plan.write !== true, 'git 밖에서는 쓰기를 켜지 않는다 — codex 가 거절한다(H4)');
      assert.equal(plan?.kind === 'plan' && plan.readOnlyBlocked, true, mode);
      if (mode === 'auto') {
        assert.deepEqual(codes(m.session), ['H6']);
        assert.deepEqual(guideOf(plan), [SCAFFOLD_GUIDE]);
      } else assert.deepEqual(guideOf(plan), [H6_TEXT, SCAFFOLD_GUIDE], 'manual 은 같은 줄을 안내로 싣는다');
      // 1005-2233-dc3 재현: 승인하면 읽기 전용 헛실행이 돌았다. 이제 막고 카드는 남는다.
      await assert.rejects(m.session.approve({ write: false }), /읽기 전용으로 승인하지 않는다/);
      assert.equal(m.spy.roles.length, 0, `${mode} — 엔진을 띄우지 않는다`);
      assert.equal(m.session.state, 'blocked');
      assert.ok(!m.session.records().some((r) => r.kind === 'approval'), '승인 기록도 남기지 않는다');
      // 쓰기를 켠 승인은 사람이 고른 것이다 — H4(엔진 거절 예고) 규칙대로 시작한다.
      await m.session.approve({ write: true });
      assert.equal(m.spy.primaries(), 1);
    }
  });

  it('쓰기 행이 아니거나 스크래치면 종전대로 읽기 전용 자동 시작이다', async () => {
    isolate();
    const read = make({ mode: 'auto', row: 'R02', writeRows: WRITE_ROWS, inGit: true });
    const approval = (await read.session.send('비교해줘')).find((r) => r.kind === 'approval');
    assert.ok(approval?.kind === 'approval' && approval.by === 'auto' && approval.write === false);

    const scratch = make({ mode: 'auto', row: 'R03', writeRows: WRITE_ROWS, kind: 'scratch' });
    const out = await scratch.session.send('기능 추가해줘');
    const auto = out.find((r) => r.kind === 'approval');
    assert.ok(auto?.kind === 'approval' && auto.by === 'auto' && auto.write === false, '스크래치는 쓰기를 켤 수 없다 (SPEC §6.4.1)');
  });
});

describe('승인 방식 — 자동은 클릭 대신일 뿐 (D-064 결정 2)', () => {
  it('자동으로 시작한 뒤 다음 제안(사다리)이 있어도 새 위임을 스스로 시작하지 않는다', async () => {
    isolate();
    const exec: SlotExecutor = (slot) => Promise.resolve(slot.role === 'reviewer' ? done('FAIL') : done('ran'));
    const m = make({ mode: 'auto', execute: exec });
    const out = await m.session.send('요청');
    const summary = out.find((r) => r.kind === 'summary');
    assert.ok(summary?.kind === 'summary' && summary.next !== '', '실패라 다음 제안이 있다');
    assert.equal(out.filter((r) => r.kind === 'approval').length, 1, '위임은 이 메시지의 1건뿐이다');
    assert.equal(out.filter((r) => r.kind === 'result').length, 1);
    assert.equal(m.session.state, 'waiting_input');
  });

  it('선 카드가 있는 채 방식을 auto 로 바꿔도 그 카드는 자동 승인하지 않는다 (결정 9) — 다음 배정부터다', async () => {
    isolate();
    const m = make({ mode: 'manual' });
    await m.session.send('요청');
    assert.equal(m.session.state, 'blocked');
    m.session.setMode('auto');
    assert.equal(m.session.state, 'blocked');
    assert.equal(m.spy.roles.length, 0);
    m.session.reject();
    const out = await m.session.send('다음 요청');
    assert.equal(kinds(out).includes('approval'), true, '다음 배정은 auto');
  });

  it('대기 중 새 메시지는 그 배정을 거절로 남기고 새 배정에 방식이 적용된다', async () => {
    isolate();
    const m = make({ mode: 'auto-ask' });
    await m.session.send('첫 요청'); // A4 로 대기
    assert.equal(m.session.state, 'blocked');
    const out = await m.session.send('둘째 요청');
    assert.equal(out[0]?.kind === 'approval' && out[0].approved === false, true);
    assert.equal(m.spy.primaries(), 0, '둘째도 A4 (승인된 위임이 아직 없다)');
  });
});

describe('승인 방식 — 영속·재생·옛 기록', () => {
  it('바꾸면 mode 기록이 남고, 같은 파일을 다시 열면 마지막 방식을 재생한다', async () => {
    isolate();
    const m = make({ mode: 'auto-ask' });
    const out = m.session.setMode('auto');
    assert.deepEqual(out.map((r) => r.kind === 'mode' && r.mode), ['auto']);
    assert.deepEqual(m.session.setMode('auto'), [], '같은 방식은 다시 쓰지 않는다');
    await m.session.send('요청');
    const reopened = make({ dir: m.dir, mode: 'manual' }); // 기본값을 다르게 줘도 기록이 이긴다
    assert.equal(reopened.session.mode, 'auto');
  });

  it('새 세션은 limits.json 기본값(auto-ask)으로 열고, 첫 메시지 전에 그 방식을 기록으로 굳힌다', async () => {
    isolate();
    assert.equal(loadLimits().approvalMode, 'auto-ask');
    const m = make();
    assert.equal(m.session.mode, 'auto-ask');
    assert.equal(m.session.records().length, 0);
    await m.session.send('요청');
    const first = m.session.records()[0];
    assert.ok(first?.kind === 'mode' && first.mode === 'auto-ask');
    // 나중에 기본값이 바뀌어도 이 세션은 그대로 — 기록이 진실이다.
    assert.equal(make({ dir: m.dir, mode: 'auto' }).session.mode, 'auto-ask');
  });

  it('mode 기록이 없는 옛 세션은 manual 로 연다 — 조용히 자동이 되지 않는다', async () => {
    isolate();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-modes-old-'));
    const file = transcriptPath(dir, '0930-1200-mmm');
    appendRecord(file, { v: 1, at: '2026-09-28T00:00:00Z', turn: 1, kind: 'user', text: '옛 메시지' });
    appendRecord(file, { v: 1, at: '2026-09-28T00:00:01Z', turn: 1, kind: 'approval', approved: true, write: false });
    const m = make({ dir, mode: 'auto' }); // 기본값이 auto 여도 옛 기록은 manual
    assert.equal(m.session.mode, 'manual');
    const out = await m.session.send('새 메시지');
    assert.deepEqual(kinds(out), ['user', 'plan']);
    assert.equal(m.session.state, 'blocked');
    assert.equal(m.session.records().findLast((r) => r.kind === 'mode')?.kind, 'mode', '열자마자가 아니라 첫 새 메시지에서 manual 로 굳힌다');
  });

  it('깨진 mode 값은 무시한다 — 손으로 고친 기록이 자동이 되지 않는다', () => {
    isolate();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-modes-bad-'));
    const file = transcriptPath(dir, '0930-1200-mmm');
    appendRecord(file, { v: 1, at: '2026-09-28T00:00:00Z', turn: 1, kind: 'user', text: 'x' });
    appendRecord(file, { v: 1, at: '2026-09-28T00:00:01Z', turn: 1, kind: 'mode', mode: 'yolo' as never });
    assert.equal(make({ dir }).session.mode, 'manual');
  });

  it('모르는 방식으로 바꾸려 하면 던진다', () => {
    isolate();
    assert.throws(() => make().session.setMode('yolo' as never), /모르는 승인 방식/);
  });
});

describe('승인 방식 — 결정 로그·기록', () => {
  it('1차 note 에 승인 auto/user 가 붙는다 — 라우터 스키마 필드는 늘리지 않는다', async () => {
    isolate();
    const auto = make({ mode: 'auto' });
    await auto.session.send('자동');
    const manual = make({ mode: 'manual' });
    await manual.session.send('수동');
    await manual.session.approve();
    const notes = readDecisions().filter((d) => d.status === 'decided').map((d) => d.note ?? '');
    assert.equal(notes.length, 2);
    assert.match(notes[0] ?? '', /session 0930-1200-mmm · 승인 auto$/);
    assert.match(notes[1] ?? '', /session 0930-1200-mmm · 승인 user$/);
  });

  it('자동 승인 뒤 상한이 닿아 있으면 시작하지 않는다 — approval 은 남고 결정 로그는 blocked', async () => {
    isolate();
    const budget = new Budget(20, 10);
    budget.countTokens({ inputTokens: 20, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 });
    const m = make({ mode: 'auto', budget });
    const out = await m.session.send('요청');
    assert.deepEqual(kinds(out), ['user', 'plan', 'approval', 'error']);
    assert.equal(m.spy.roles.length, 0);
    assert.equal(readDecisions().at(-1)?.status, 'blocked');
  });
});

describe('승인 방식 — 자동 실행 중 취소 (D-066 호환)', () => {
  it('자동으로 시작한 위임도 도는 중에 취소된다 — 결과는 cancelled, 세션은 입력 대기', async () => {
    isolate();
    let started = false;
    const exec: SlotExecutor = (slot, _prompt, options?: SlotRunOptions) => {
      started = true;
      return new Promise<SlotRun>((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve({ ok: false, cancelled: true, text: '', rawStdout: '', rawStderr: '', durationMs: 1 }), { once: true });
        void slot;
      });
    };
    const m = make({ mode: 'auto', execute: exec });
    const sending = m.session.send('자동으로 돌 요청');
    for (let i = 0; i < 200 && !m.session.cancellable; i += 1) await tick();
    assert.equal(started, true);
    assert.equal(m.session.state, 'working');
    assert.equal(m.session.cancel(), true);
    const out = await sending;
    assert.deepEqual(kinds(out), ['user', 'plan', 'approval', 'result']);
    const result = out.find((r) => r.kind === 'result');
    assert.ok(result?.kind === 'result' && result.outcome === 'cancelled');
    assert.equal(m.session.state, 'waiting_input');
    assert.equal(m.session.interrupted, false);
  });
});

/**
 * 질문형 경로 (D-083) — Jev GENERAL 은 방식이 허락하면 읽기 전용 1슬롯이 클릭 없이 답하고, 사람이 누르면 어느 방식에서도 바로 돈다.
 * 실행기는 가짜다 — 무엇이 어떤 쓰기 스위치·슬롯 자리로 시작됐는지만 센다.
 */
describe('질문형 경로 — 읽기 전용 1슬롯 (D-083)', () => {
  const readSpy = () => {
    const runs: { label: string; role: string; write: boolean }[] = [];
    const conducted: string[] = [];
    const conductor: SlotExecutor = (_slot, prompt) => (conducted.push(prompt), Promise.resolve(done('지휘자 답\nSUGGEST: NONE')));
    const executorFor = (write: boolean): SlotExecutor => (slot) => (runs.push({ label: slot.label, role: slot.role, write }), Promise.resolve(done('src/core/session.ts:206 에서 send() 가 받는다.', { actualUsd: 0.03 })));
    return { runs, conducted, conductor, executorFor };
  };
  const session = (mode: ApprovalMode, spy: ReturnType<typeof readSpy>, budget = new Budget(20, 2_000_000)) =>
    new ConversationSession({
      matrix, catalog, kind: 'project', dir: mkdtempSync(path.join(os.tmpdir(), 'hs-read-')), id: '1005-1200-rrr', budget, journal: new Journal(),
      conduct: spy.conductor, executorFor: spy.executorFor, classifier: jev({ current: 'GENERAL' }), approvalMode: mode,
    });

  it('auto-ask 의 GENERAL 은 첫 메시지에도 클릭 없이 답하고 끝난다 — 카드·승인·reviewer·지휘자 없이, 쓰기 꺼진 reviewer 자리 1슬롯', async () => {
    isolate();
    const spy = readSpy();
    const s = session('auto-ask', spy);
    const out = await s.send('hs-orc 앱이 동작하는 방식이 궁금해');
    assert.deepEqual(kinds(out), ['user', 'direct']);
    const direct = out[1];
    assert.ok(direct?.kind === 'direct' && direct.read?.by === 'auto' && direct.general === true && direct.suggest === null);
    assert.match(direct.read.slot, /^읽기·Luna·medium → codex\//);
    assert.equal(direct.cost, '$0.0300 actual');
    assert.deepEqual(spy.runs, [{ label: '읽기·Luna', role: 'reviewer', write: false }]);
    assert.equal(spy.conducted.length, 0);
    assert.equal(s.state, 'waiting_input');
    assert.equal(readDecisions().length, 0, '위임이 아니다 — 결정 로그에 남지 않는다');
  });

  it('manual 의 GENERAL 은 돌리지 않고 지휘자가 답하며 이유를 남긴다 — 이어 readAnswer() 한 번이면 바로 돈다(by user)', async () => {
    const spy = readSpy();
    const s = session('manual', spy);
    const first = await s.send('src/core 구조를 설명해줘');
    const direct = first[1];
    assert.ok(direct?.kind === 'direct' && direct.read === undefined);
    assert.match(direct.notes.join('\n'), /코드를 읽고 답하기는 manual 이라 묻는다/);
    assert.equal(spy.runs.length, 0);
    const out = await s.readAnswer();
    assert.deepEqual(kinds(out), ['direct']);
    assert.ok(out[0]?.kind === 'direct' && out[0].read?.by === 'user');
    assert.deepEqual(spy.runs.map((r) => r.write), [false]);
    assert.ok(!s.records().some((r) => r.kind === 'plan' || r.kind === 'approval'));
  });

  it('auto-ask 에서 상한 근접(A2)이거나 쓰기로 보낸 GENERAL 은 클릭 없이 돌리지 않는다 — auto 는 A 를 보지 않는다', async () => {
    const spy = readSpy();
    const near = new Budget(20, 1000);
    near.countTokens({ inputTokens: 900, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 });
    const slot = readerSlot(catalog);
    assert.deepEqual(evaluateRead({ mode: 'auto-ask', slot, catalog, budget: near, estimateUsd: 0.18 }).asks.map((a) => a.code), ['A2']);
    assert.equal(evaluateRead({ mode: 'auto', slot, catalog, budget: near, estimateUsd: 0.18 }).auto, true);
    const out = await session('auto-ask', spy, near).send('모듈 의존 관계를 mermaid 로 그려줘');
    assert.ok(out[1]?.kind === 'direct' && out[1].read === undefined && /A2 남은 토큰/.test(out[1].notes.join('\n')));
    await session('auto', spy).send('README 에 설치 절차 절을 써줘', { write: true });
    assert.equal(spy.runs.length, 0);
  });
});
