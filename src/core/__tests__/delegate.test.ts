import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { assign } from '../assign.ts';
import { Budget } from '../budget.ts';
import { readDecisions } from '../decision-log.ts';
import { delegate } from '../delegate.ts';
import type { SlotExecutor } from '../executor.ts';
import { Journal } from '../journal.ts';
import { projectStateDir, verifyConfigPath } from '../project-state.ts';
import { REPO_ROOT, REPO_VERIFY_PATH } from '../../data/verify.ts';
import { loadLimits } from '../../data/limits.ts';
import { DENIAL_HEADER } from '../auto-verify.ts';
import type { CommandRunner } from '../scaffold.ts';

const matrix = loadMatrix();
const catalog = loadEngines();
const row = (id: string) => matrix.assignments.find((a) => a.id === id)!;

describe('위임 1건 (SPEC §4 5~7단계)', () => {
  it('결정 로그에는 사용자 문장을, 엔진에는 맥락이 붙은 프롬프트를 보내고 note 로 세션을 잇는다', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-delegate-'));
    const log = path.join(dir, 'log.jsonl');
    process.env['HS_ORC_DECISION_LOG'] = log;
    process.env['HS_ORC_RUN_STORE'] = path.join(dir, 'runs');
    const prompts: string[] = [];
    const execute: SlotExecutor = (slot, prompt) => {
      prompts.push(prompt);
      return Promise.resolve({ ok: true, text: slot.label === 'Haiku' ? 'PASS' : 'ran', rawStdout: '', rawStderr: '', durationMs: 1 });
    };

    const d = await delegate({
      matrix, plan: assign(matrix, catalog, row('R01')), reason: '수동 지정 R01',
      title: '타입 고쳐줘', prompt: '[최근 대화]\n사용자: 앞\n\n[이번 요청]\n타입 고쳐줘',
      verify: [], write: true, cwd: process.cwd(), execute, budget: new Budget(20, 2_000_000), journal: new Journal(),
      note: 'session 0923-1200-aaa',
    });

    const lines = readDecisions(log).filter((r) => r.id === d.decisionId);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.task, '타입 고쳐줘');
    assert.match(lines[0]?.note ?? '', / · session 0923-1200-aaa$/);
    assert.match(prompts[0] ?? '', /^\[최근 대화\]/);
    assert.equal(d.outcome, 'unverified');
    assert.equal(d.verdict, 'pass');
  });

  it('journal 의 실행 줄은 reviewer 가 돌아도 primary 의 과금을 싣는다', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-delegate-'));
    process.env['HS_ORC_DECISION_LOG'] = path.join(dir, 'log.jsonl');
    process.env['HS_ORC_RUN_STORE'] = path.join(dir, 'runs');
    const execute: SlotExecutor = (slot) =>
      Promise.resolve(slot.label === 'Haiku'
        ? { ok: true, text: 'PASS', rawStdout: '', rawStderr: '', durationMs: 1, actualUsd: 0.01 }
        : { ok: true, text: 'ran', rawStdout: '', rawStderr: '', durationMs: 1, actualUsd: 0.5 });
    const budget = new Budget(20, 2_000_000);
    const journal = new Journal();

    await delegate({
      matrix, plan: assign(matrix, catalog, row('R01')), reason: '수동 지정 R01', title: 't', prompt: 't',
      verify: [], write: true, cwd: dir, execute, budget, journal,
    });

    assert.equal(budget.charges.length, 2, 'reviewer 가 실제로 돌았다');
    assert.equal(journal.records.at(-1)?.charge?.usd, 0.5);
  });

  it('primary 실행의 캐시 쓰기 TTL 내역을 원시 로그 meta 에 남긴다 (D-062)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-delegate-'));
    process.env['HS_ORC_DECISION_LOG'] = path.join(dir, 'log.jsonl');
    process.env['HS_ORC_RUN_STORE'] = path.join(dir, 'runs');
    const cacheWrite = { ephemeral1hTokens: 7138, ephemeral5mTokens: 0 };
    const execute: SlotExecutor = (slot) =>
      Promise.resolve(slot.role === 'reviewer'
        ? { ok: true, text: 'PASS', rawStdout: '', rawStderr: '', durationMs: 1 }
        : { ok: true, text: 'ran', rawStdout: '', rawStderr: '', durationMs: 1, cacheWrite });

    const d = await delegate({
      matrix, plan: assign(matrix, catalog, row('R01')), reason: '수동 지정 R01', title: 't', prompt: 't',
      verify: [], write: true, cwd: dir, execute, budget: new Budget(20, 2_000_000), journal: new Journal(),
    });

    const runDir = path.join(dir, 'runs', d.decisionId);
    const meta = readdirSync(runDir).find((f) => f.endsWith('.meta.json')) ?? '';
    const stored = JSON.parse(readFileSync(path.join(runDir, meta), 'utf8')) as { cacheWrite?: unknown };
    assert.deepEqual(stored.cacheWrite, cacheWrite);
  });

  it('검증 명령이 실패하면 결정 로그 2차 outcome 은 ok 가 아니라 rework 다 (D-043)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-delegate-'));
    const log = path.join(dir, 'log.jsonl');
    process.env['HS_ORC_DECISION_LOG'] = log;
    process.env['HS_ORC_RUN_STORE'] = path.join(dir, 'runs');
    const execute: SlotExecutor = (slot) =>
      Promise.resolve({ ok: true, text: slot.label === 'Haiku' ? 'PASS' : 'ran', rawStdout: '', rawStderr: '', durationMs: 1 });

    const d = await delegate({
      matrix, plan: assign(matrix, catalog, row('R01')), reason: '수동 지정 R01', title: '타입 고쳐줘', prompt: '타입 고쳐줘',
      verify: [afterBaseline('exit 1')], write: true, cwd: dir, execute, budget: new Budget(20, 2_000_000), journal: new Journal(),
    });

    assert.equal(d.outcome, 'rework');
    assert.equal(readDecisions(log).filter((r) => r.id === d.decisionId).at(-1)?.outcome, 'rework');
  });

  it('primary 가 선언된 기존 테스트를 약화하면 rework 다 — GUI·TUI 경로도 같다 (D-047)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-delegate-'));
    process.env['HS_ORC_DECISION_LOG'] = path.join(dir, 'log.jsonl');
    process.env['HS_ORC_RUN_STORE'] = path.join(dir, 'runs');
    const config = path.join(dir, 'verify.json');
    writeFileSync(config, JSON.stringify({ tests: ['t/*.test.ts'] }), 'utf8');
    mkdirSync(path.join(dir, 't'));
    writeFileSync(path.join(dir, 't', 'a.test.ts'), 'expect(1)\n', 'utf8');
    process.env['HS_ORC_VERIFY_CONFIG'] = config;
    const execute: SlotExecutor = (slot) => {
      if (slot.label !== 'Haiku') writeFileSync(path.join(dir, 't', 'a.test.ts'), 'skip\n', 'utf8');
      return Promise.resolve({ ok: true, text: slot.label === 'Haiku' ? 'PASS' : 'ran', rawStdout: '', rawStderr: '', durationMs: 1 });
    };
    try {
      const d = await delegate({
        matrix, plan: assign(matrix, catalog, row('R01')), reason: '수동 지정 R01', title: '타입 고쳐줘', prompt: '타입 고쳐줘',
        verify: [], write: true, cwd: dir, execute, budget: new Budget(20, 2_000_000), journal: new Journal(),
      });
      assert.equal(d.outcome, 'rework');
      assert.match(d.report.summary, /기존 테스트가 약해졌다/);
    } finally {
      delete process.env['HS_ORC_VERIFY_CONFIG'];
    }
  });
});

/** reviewer 는 `slot.role` 로 가른다. 프롬프트를 슬롯별로 모으고, reviewer 판정을 고를 수 있다. */
const spy = (reviewer: string, primaryDo?: () => void) => {
  const prompts = { primary: [] as string[], reviewer: [] as string[] };
  const execute: SlotExecutor = (slot, prompt) => {
    if (slot.role === 'reviewer') prompts.reviewer.push(prompt);
    else {
      prompts.primary.push(prompt);
      primaryDo?.();
    }
    return Promise.resolve({ ok: true, text: slot.role === 'reviewer' ? reviewer : 'ran', rawStdout: '', rawStderr: '', durationMs: 1 });
  };
  return { execute, prompts };
};

const project = (files: Record<string, string>): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-delegate-proj-'));
  process.env['HS_ORC_DECISION_LOG'] = path.join(dir, '.log.jsonl');
  process.env['HS_ORC_RUN_STORE'] = path.join(dir, '.runs');
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), body, 'utf8');
  }
  return dir;
};

const run = (id: string, dir: string, execute: SlotExecutor) =>
  delegate({
    matrix, plan: assign(matrix, catalog, row(id)), reason: `수동 지정 ${id}`, title: '날짜 넣어줘', prompt: '날짜 넣어줘',
    verify: [], write: true, cwd: dir, execute, budget: new Budget(20, 2_000_000), journal: new Journal(),
  });

describe('테스트 없는 프로젝트 (D-093)', () => {
  const nextApp = { 'package.json': JSON.stringify({ scripts: { dev: 'next dev', lint: 'eslint' } }), 'app/page.tsx': 'export default 1\n' };

  it('test 스크립트도 테스트 파일도 없으면 primary·reviewer·증거에 그 사실이 실린다 (R01)', async () => {
    const dir = project(nextApp);
    const s = spy('없음\nPASS');
    const d = await run('R01', dir, s.execute);
    assert.match(s.prompts.primary[0] ?? '', /\[Core 확인\] 이 프로젝트에는 기존 테스트가 없다/);
    assert.match(s.prompts.reviewer[0] ?? '', /test 를 실행하지 않은 것을 이유로 FAIL 하지 마라/);
    assert.match(d.report.summary, /대상에 기존 테스트 없음/);
    // 판정은 바꾸지 않는다 — 산문은 증거가 아니라 대체 검증 보고만으로 ok 가 되지 않는다.
    assert.equal(d.outcome, 'unverified');
  });

  it('npm init 자리표시 test 스크립트는 테스트가 아니다', async () => {
    const dir = project({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
    const s = spy('PASS');
    await run('R06', dir, s.execute);
    assert.match(s.prompts.reviewer[0] ?? '', /Core 확인 사실/);
  });

  for (const [why, files] of [
    ['test 스크립트가 있다', { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) }],
    ['테스트 파일이 있다', { ...nextApp, 'app/page.test.tsx': 'it(1)\n' }],
    ['_test 이름의 테스트 파일이 있다', { ...nextApp, 'lib/date_test.ts': 'it(1)\n' }],
    // Node test runner 기본 이름 — scripts.test 없이 `node --test` 로 돈다.
    ['루트에 test.js 가 있다', { ...nextApp, 'test.js': 'it(1)\n' }],
    ['date-test.js 가 있다', { ...nextApp, 'date-test.js': 'it(1)\n' }],
    ['test-date.js 가 있다', { ...nextApp, 'test-date.js': 'it(1)\n' }],
    ['package.json 이 없다 — 판정하지 않는다', { 'Package.swift': '// swift\n' }],
  ] as const) {
    it(`${why}면 면제가 없다 — 테스트를 안 돌린 위임은 reviewer FAIL 그대로 rework 다`, async () => {
      const dir = project(files);
      const s = spy('→ 기존 test 를 실행하지 않았다\nFAIL');
      const d = await run('R01', dir, s.execute);
      assert.doesNotMatch(s.prompts.primary[0] ?? '', /Core 확인/);
      assert.doesNotMatch(s.prompts.reviewer[0] ?? '', /Core 확인 사실/);
      assert.doesNotMatch(d.report.summary, /기존 테스트 없음/);
      assert.equal(d.outcome, 'rework');
    });
  }

  it('기존 테스트를 전제하지 않는 행은 건드리지 않는다', async () => {
    const dir = project(nextApp);
    const s = spy('PASS');
    const d = await run('R02', dir, s.execute);
    assert.doesNotMatch(s.prompts.reviewer[0] ?? '', /Core 확인 사실/);
    assert.doesNotMatch(d.report.summary, /기존 테스트 없음/);
  });
});

describe('검증 선언은 대상 폴더의 것이다 (D-093)', () => {
  it('hs-orc 저장소의 선언(tests glob)을 다른 프로젝트에 대지 않는다', async () => {
    // hs-orc 의 tests 는 `src/**/__tests__/**/*.ts` 다 — 같은 모양의 남의 파일을 고쳐도 hs-orc 게이트로 막지 않는다.
    const dir = project({ 'src/x/__tests__/a.ts': 'expect(1)\n' });
    const s = spy('PASS', () => writeFileSync(path.join(dir, 'src/x/__tests__/a.ts'), 'skip\n', 'utf8'));
    const d = await run('R01', dir, s.execute);
    assert.equal(d.report.accepted.some((e) => e.kind === 'test-files'), false);
    assert.notEqual(d.outcome, 'rework');
  });

  it('그 프로젝트의 선언(상태 폴더 verify.json)은 쓴다', async () => {
    const dir = project({ 'src/x/__tests__/a.ts': 'expect(1)\n' });
    mkdirSync(projectStateDir(dir), { recursive: true });
    writeFileSync(path.join(projectStateDir(dir), 'verify.json'), JSON.stringify({ tests: ['src/**/__tests__/**/*.ts'] }), 'utf8');
    const s = spy('PASS', () => writeFileSync(path.join(dir, 'src/x/__tests__/a.ts'), 'skip\n', 'utf8'));
    const d = await run('R01', dir, s.execute);
    assert.equal(d.outcome, 'rework');
    assert.match(d.report.summary, /기존 테스트가 약해졌다/);
  });

  it('hs-orc 저장소 자신은 저장소의 data/verify.json 을 쓴다', () => {
    assert.equal(verifyConfigPath(REPO_ROOT, { ...process.env, HS_ORC_VERIFY_CONFIG: undefined }), REPO_VERIFY_PATH);
    assert.notEqual(verifyConfigPath(os.tmpdir(), { ...process.env, HS_ORC_VERIFY_CONFIG: undefined }), REPO_VERIFY_PATH);
  });
});

/** 기준선(D-096 V2a)에서는 통과하고 primary 뒤에만 `cmd` 를 돌린다 — 작업이 만든 실패를 흉내 낸다. */
const afterBaseline = (cmd: string): string => `[ -e .baseline-ran ] || { touch .baseline-ran; exit 0; }; ${cmd}`;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 실제 종료는 `kill -0` 로만 안다 — 기다리지 않고 단정하면 초록 거짓말이 된다. */
const waitGone = async (pid: number, ms = 5_000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
};

describe('검증 명령은 primary 뒤·reviewer 앞에 돈다 (D-094)', () => {
  const go = (dir: string, execute: SlotExecutor, verify: readonly string[], write: boolean, signal?: AbortSignal) =>
    delegate({
      matrix, plan: assign(matrix, catalog, row('R01')), reason: '수동 지정 R01', title: '날짜 넣어줘', prompt: '날짜 넣어줘',
      verify, write, cwd: dir, execute, budget: new Budget(20, 2_000_000), journal: new Journal(), ...(signal ? { signal } : {}),
    });

  it('쓰기 위임이면 결과가 reviewer 프롬프트에 실리고, 증거에도 남는다', async () => {
    const dir = project({});
    const s = spy('없음\nPASS');
    const d = await go(dir, s.execute, ['echo CHECK_MARK'], true);
    assert.match(s.prompts.reviewer[0] ?? '', /--- 검증 명령 \(Core 실행\) ---\n\$ echo CHECK_MARK\nexit=0\nCHECK_MARK/);
    assert.match(s.prompts.reviewer[0] ?? '', /Core 가 이미 실행했다/);
    assert.ok(d.report.accepted.some((e) => e.kind === 'command' && e.cmd === 'echo CHECK_MARK' && e.exitCode === 0));
  });

  it('실패한 명령도 reviewer 가 보고, 판정은 rework 다', async () => {
    const dir = project({});
    const s = spy('없음\nPASS');
    const d = await go(dir, s.execute, [afterBaseline('echo RED_MARK; exit 3')], true);
    assert.match(s.prompts.reviewer[0] ?? '', /exit=3\nRED_MARK/);
    assert.equal(d.outcome, 'rework');
  });

  it('읽기 전용 위임에서는 돌리지 않고, 그 사실이 증거 요약에 남는다', async () => {
    const dir = project({});
    const s = spy('없음\nPASS');
    const d = await go(dir, s.execute, ['touch ran-marker'], false);
    assert.equal(existsSync(path.join(dir, 'ran-marker')), false, '원본에 명령이 돌았다');
    assert.doesNotMatch(s.prompts.reviewer[0] ?? '', /검증 명령 \(Core 실행\)/);
    assert.equal(d.report.accepted.some((e) => e.kind === 'command'), false);
    assert.match(d.report.summary, /읽기 전용 위임이라 검증 명령 1개를 실행하지 않았다 — `touch ran-marker`/);
  });

  it('명령이 도는 동안 이벤트 루프를 막지 않는다 — GUI 메인 프로세스가 취소·화면 요청을 받는다', async () => {
    const dir = project({});
    const s = spy('없음\nPASS');
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 20);
    try {
      await go(dir, s.execute, ['sleep 0.6'], true);
    } finally {
      clearInterval(timer);
    }
    assert.ok(ticks >= 10, `명령 0.6초 동안 타이머가 ${ticks}번만 돌았다`);
  });

  it('명령 중에 취소하면 손자까지 끝내고 reviewer 를 띄우지 않는다 (D-066·D-078)', async () => {
    const dir = project({});
    const pidFile = path.join(dir, 'grandchild.pid');
    const s = spy('없음\nPASS');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);
    const started = Date.now();
    const d = await go(dir, s.execute, [afterBaseline(`sleep 120 >/dev/null 2>&1 & echo $! > '${pidFile}'; wait`)], true, controller.signal);
    assert.ok(Date.now() - started < 10_000, '취소가 명령을 멈추지 못했다');
    assert.equal(d.outcome, 'cancelled');
    assert.equal(d.cancelledAt, 'verify');
    assert.equal(s.prompts.reviewer.length, 0);
    assert.ok(await waitGone(Number(readFileSync(pidFile, 'utf8').trim())), '손자 sleep 이 살아 있다');
  });
});

describe('Core 가 고른 검증 명령은 codex sandbox 안에서 기준선과 함께 돈다 (D-096)', () => {
  const PKG = { scripts: { dev: 'next dev', lint: 'eslint .', 'type-check': 'tsc --noEmit' } };
  type Reply = { readonly exit: number; readonly out?: readonly string[]; readonly denials?: readonly string[] | null };
  /** 프로세스를 띄우지 않는 가짜 sandbox — 안쪽 명령과 몇 번째 실행인지(1 = 기준선)로 답한다. 거부 머리줄은 `denials: null` 이면 없다. */
  const fake = (respond: (inner: string, nth: number) => Reply = () => ({ exit: 0 })) => {
    const calls: { argv: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
    const inner = (argv: readonly string[]): string => argv.slice(argv.indexOf('--') + 1).join(' ');
    const runner: CommandRunner = (argv, options) => {
      calls.push({ argv, ...(options.env ? { env: options.env } : {}) });
      const r = respond(inner(argv), calls.filter((c) => inner(c.argv) === inner(argv)).length);
      for (const line of r.out ?? []) options.onLine?.(line);
      if (r.denials !== null) for (const line of [DENIAL_HEADER, ...(r.denials ?? ['None found.'])]) options.onLine?.(line);
      return Promise.resolve({ outcome: r.exit === 0 ? 'ok' : 'failed', exitCode: r.exit, tail: '', durationMs: 1 });
    };
    return { runner, calls, inners: () => calls.map((c) => inner(c.argv)) };
  };
  const go = (dir: string, execute: SlotExecutor, auto: { runner: CommandRunner; codex?: string | null }, options: { write?: boolean; id?: string; signal?: AbortSignal } = {}) =>
    delegate({
      matrix, plan: assign(matrix, catalog, row(options.id ?? 'R01')), reason: '수동 지정', title: '날짜 넣어줘', prompt: '날짜 넣어줘',
      verify: [], write: options.write ?? true, cwd: dir, execute, budget: new Budget(20, 2_000_000), journal: new Journal(),
      autoVerify: { codex: auto.codex === undefined ? '/bin/codex' : auto.codex, runner: auto.runner, scripts: loadLimits().verifyScripts },
      ...(options.signal ? { signal: options.signal } : {}),
    });

  it('package.json 의 lint·type-check 를 sandbox argv 로 기준선·작업 뒤 두 번 돌리고, 결과를 reviewer 에 싣는다 — 테스트 없는 R01 은 lint 통과로 ok (V4a)', async () => {
    const dir = project({ 'package.json': JSON.stringify(PKG) });
    const s = spy('없음\nPASS');
    const f = fake((inner) => ({ exit: 0, out: [`OUT ${inner}`] }));
    const d = await go(dir, s.execute, f);
    assert.deepEqual(f.calls[0]?.argv, ['/bin/codex', 'sandbox', '-P', ':workspace', '-C', dir, '--log-denials', '--', 'npm', 'run', 'lint']);
    assert.deepEqual(f.inners(), ['npm run lint', 'npm run type-check', 'npm run lint', 'npm run type-check']);
    assert.match(String(f.calls[0]?.env?.['npm_config_logs_dir']), /hs-orc-npm-logs$/);
    assert.match(s.prompts.reviewer[0] ?? '', /\$ npm run lint {2}\[codex sandbox\]\nexit=0\nOUT npm run lint/);
    assert.equal(d.outcome, 'ok');
  });

  it('잡음 거부만 있는 실패는 진짜 실패다 — rework (V1·V3a)', async () => {
    const dir = project({ 'package.json': JSON.stringify(PKG) });
    const f = fake((inner, nth) => (inner === 'npm run lint' && nth === 2 ? { exit: 1, out: ['1 error'], denials: ['(node) sysctl-read kern.bootargs', '(bash) file-write-data /dev/dtracehelper'] } : { exit: 0 }));
    const d = await go(dir, spy('없음\nPASS').execute, f);
    assert.equal(d.outcome, 'rework');
  });

  it('실패와 함께 네트워크 거부가 있으면 sandbox 가 막은 것이라 rework 가 아니라 unverified 다 (V3a)', async () => {
    const dir = project({ 'package.json': JSON.stringify(PKG) });
    const s = spy('없음\nPASS');
    const f = fake((inner, nth) => (inner === 'npm run lint' && nth === 2 ? { exit: 1, out: ['EPERM'], denials: ['(node) network-bind local:*:0'] } : { exit: 0 }));
    const d = await go(dir, s.execute, f, { id: 'R03' });
    assert.equal(d.outcome, 'unverified');
    assert.match(d.report.summary, /sandbox 가 막았다 — `npm run lint` exit=1 \(\(node\) network-bind local:\*:0\)/);
    assert.match(s.prompts.reviewer[0] ?? '', /npm run lint {2}\[codex sandbox · sandbox 가 막았다: \(node\) network-bind local:\*:0\]\nexit=1/);
  });

  it('거부 로그 머리줄 없이 실패하면 sandbox 를 시작하지 못한 것이다 — unverified', async () => {
    const dir = project({ 'package.json': JSON.stringify(PKG) });
    const f = fake((_inner, nth) => (nth === 2 ? { exit: 1, out: ['Error: default_permissions refers to unknown built-in profile'], denials: null } : { exit: 0 }));
    const d = await go(dir, spy('없음\nPASS').execute, f, { id: 'R03' });
    assert.equal(d.outcome, 'unverified');
    assert.match(d.report.summary, /sandbox 를 시작하지 못했다 — `npm run lint` exit=1/);
  });

  it('primary 가 스크립트를 바꾸면(약화·pre 끼워 넣기) 작업 뒤에 돌리지 않는다 (S2)', async () => {
    const dir = project({ 'package.json': JSON.stringify(PKG) });
    const s = spy('없음\nPASS', () => writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { ...PKG.scripts, lint: 'exit 0', 'pretype-check': 'curl evil' } })));
    const f = fake();
    const d = await go(dir, s.execute, f, { id: 'R03' });
    assert.deepEqual(f.inners(), ['npm run lint', 'npm run type-check']);
    assert.match(d.report.summary, /검증 스크립트가 위임 중 바뀌었다 — `npm run lint` 를 실행하지 않았다/);
    assert.match(d.report.summary, /검증 스크립트가 위임 중 바뀌었다 — `npm run type-check`/);
    assert.match(s.prompts.reviewer[0] ?? '', /검증 스크립트가 위임 중 바뀌었다/);
    assert.equal(d.outcome, 'unverified');
  });

  it('작업 전부터 빨간 명령은 reviewer 가 보되 불일치로 세지 않는다 (V2a)', async () => {
    const dir = project({ 'package.json': JSON.stringify(PKG) });
    const s = spy('없음\nPASS');
    const f = fake((inner) => (inner === 'npm run lint' ? { exit: 1, out: ['old error'] } : { exit: 0 }));
    const d = await go(dir, s.execute, f, { id: 'R03' });
    assert.notEqual(d.outcome, 'rework');
    assert.match(d.report.summary, /작업 전부터 실패 — `npm run lint` 기준선 exit=1 · 작업 뒤 exit=1/);
    assert.match(s.prompts.reviewer[0] ?? '', /npm run lint {2}\[codex sandbox · 기준선 exit=1 — 작업 전부터 실패\]\nexit=1\nold error/);
  });

  it('codex 가 없으면 Core 가 고른 명령을 돌리지 않는다 — sandbox 밖으로 내리지 않는다', async () => {
    const dir = project({ 'package.json': JSON.stringify({ scripts: { lint: 'touch lint-ran' } }) });
    const f = fake();
    const d = await go(dir, spy('없음\nPASS').execute, { runner: f.runner, codex: null }, { id: 'R03' });
    assert.equal(f.calls.length, 0);
    assert.equal(existsSync(path.join(dir, 'lint-ran')), false, 'sandbox 밖에서 돌았다');
    assert.match(d.report.summary, /codex 를 찾지 못해 Core 가 고른 검증 명령 1개를 실행하지 않았다/);
  });

  it('읽기 전용 위임에서는 돌리지 않는다 (D-094 결정 4)', async () => {
    const dir = project({ 'package.json': JSON.stringify(PKG) });
    const f = fake();
    await go(dir, spy('없음\nPASS').execute, f, { write: false });
    assert.equal(f.calls.length, 0);
  });

  it('기준선 중에 취소하면 primary 를 시작하지 않는다', async () => {
    const dir = project({ 'package.json': JSON.stringify(PKG) });
    const s = spy('없음\nPASS');
    const controller = new AbortController();
    const runner: CommandRunner = (_argv, options) => new Promise((resolve) => {
      options.signal?.addEventListener('abort', () => resolve({ outcome: 'cancelled', exitCode: null, tail: '', durationMs: 1 }), { once: true });
      setTimeout(() => controller.abort(), 20);
    });
    const d = await go(dir, s.execute, { runner }, { signal: controller.signal });
    assert.equal(d.outcome, 'cancelled');
    assert.equal(d.cancelledAt, 'baseline');
    assert.equal(s.prompts.primary.length, 0);
  });
});
