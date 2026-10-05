/**
 * 스캐폴딩 전용 경로 (D-088). 실행기는 가짜다 — 네트워크·npx 를 부르지 않는다. `runArgv` 만 node 로 실제 spawn 을 잰다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { loadScaffolders, type Scaffolders } from '../../data/scaffolders.ts';
import type { RowClassifier } from '../../adapters/jev.ts';
import { Budget } from '../budget.ts';
import { Journal } from '../journal.ts';
import { buildDirectPrompt } from '../conductor.ts';
import type { SlotExecutor, SlotRun } from '../executor.ts';
import { GIT_INIT_COMMANDS, allowedArgv, detectScaffold, runArgv, type CommandOptions, type CommandRun } from '../scaffold.ts';
import { ConversationSession } from '../session.ts';
import type { TranscriptRecord } from '../transcript.ts';

const matrix = loadMatrix();
const catalog = loadEngines();
const scaffolders = loadScaffolders();
const next = scaffolders.scaffolders.find((s) => s.id === 'next');
const done = (text: string): SlotRun => ({ ok: true, text, rawStdout: '', rawStderr: '', durationMs: 1 });
const kinds = (r: readonly TranscriptRecord[]) => r.map((x) => x.kind);
const isolate = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-scaffold-log-'));
  process.env['HS_ORC_DECISION_LOG'] = path.join(dir, 'log.jsonl');
  process.env['HS_ORC_RUN_STORE'] = path.join(dir, 'runs');
};

describe('스캐폴딩 감지 — 결정론 (D-088)', () => {
  it('새 프로젝트 생성 요청에서 허용 목록 항목을 하나 고른다 — 1005-2233-dc3 의 문장 그대로', () => {
    assert.equal(detectScaffold('hs-orc test용 next 앱 하나 init 해줘', scaffolders)?.scaffolder?.id, 'next');
    assert.equal(detectScaffold('새 Expo 프로젝트 생성해줘', scaffolders)?.scaffolder?.id, 'expo');
    assert.equal(detectScaffold('vite 앱 만들어줘', scaffolders)?.scaffolder?.id, 'vite');
    assert.equal(detectScaffold('npx create-next-app 으로 스캐폴딩해줘', scaffolders)?.scaffolder?.id, 'next');
  });

  it('프로젝트를 만드는 말이 아니면 잡지 않는다 — PR #118 리뷰 재현 문장 포함', () => {
    for (const text of ['git init 해줘', '이 프로젝트에 로그인 기능 만들어줘', 'DB 초기화 코드 고쳐줘', 'next 버전 올려줘', '이 타입 에러 고쳐줘', '앱을 시작하면 흰 화면이 나와', 'app create 버튼 추가']) {
      assert.equal(detectScaffold(text, scaffolders), null, text);
    }
  });

  it('일상 문장은 잡혀도 새 프로젝트 뜻(strong)이 아니다 — 세션이 종전 경로로 둔다', () => {
    for (const text of ['템플릿 초기화 함수 리팩터링', 'next 초기화 로직 고쳐줘']) assert.equal(detectScaffold(text, scaffolders)?.strong, false, text);
    assert.equal(detectScaffold('next 앱 init 해줘', scaffolders)?.strong, true);
    assert.equal(detectScaffold('nextjs init 해줘', scaffolders)?.scaffolder?.id, 'next', '약한 말이라도 프레임워크를 짚으면 빈 폴더 카드 후보다');
  });

  it('프레임워크를 모르거나 둘 이상이면 항목을 고르지 않는다 — 카드 없이 지휘자가 안내한다', () => {
    const unknown = detectScaffold('새 프로젝트 초기화해줘', scaffolders);
    assert.ok(unknown && unknown.scaffolder === null && unknown.candidates.length === 0);
    const two = detectScaffold('vite 랑 next 중에 앱 만들어줘', scaffolders);
    assert.ok(two && two.scaffolder === null && two.candidates.length === 2);
  });
});

describe('스캐폴딩 허용 목록 — 안전 (D-088)', () => {
  it('허용 목록 밖 명령은 거절한다 — 모양이 맞아도 목록과 글자까지 같아야 한다', () => {
    assert.equal(allowedArgv(next?.argv ?? [], scaffolders).id, 'next');
    for (const argv of [
      ['npx', '--yes', 'create-evil-app@latest', '.'],
      ['npx', '--yes', 'create-next-app@latest', '.'],
      ['sh', '-c', 'create-next-app'],
      ['npx', 'rimraf', '.'],
      ['npx', '--yes', 'create-next-app@latest', '.;rm', '-rf'],
      ['npx', '--yes', 'create-next-app@latest', '..'],
      ['npx', '--yes', 'create-next-app@latest', '$(touch x)'],
    ]) {
      assert.throws(() => allowedArgv(argv, scaffolders), /허용|npx|create-|대상 폴더/, argv.join(' '));
    }
  });

  it('argv 를 셸 없이 띄운다 — 셸 메타문자는 글자 그대로 인자다', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-scaffold-argv-'));
    const evil = '$(touch pwned1); touch pwned2 && `touch pwned3` | cat > pwned4';
    const run = await runArgv([process.execPath, '-e', 'process.stdout.write(process.argv[1])', evil], { cwd: dir, timeoutMs: 10_000 });
    assert.equal(run.outcome, 'ok');
    assert.equal(run.exitCode, 0);
    assert.equal(run.tail, evil);
    assert.deepEqual(readdirSync(dir), [], '어떤 파일도 생기지 않는다');
  });

  it('종료 코드가 0 이 아니면 failed, 시간 초과는 그룹째 끝내고 timeout, 취소는 cancelled', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-scaffold-exit-'));
    const failed = await runArgv([process.execPath, '-e', 'console.error("boom"); process.exit(3)'], { cwd: dir, timeoutMs: 10_000 });
    assert.deepEqual([failed.outcome, failed.exitCode, failed.tail], ['failed', 3, 'boom']);

    const hang = [process.execPath, '-e', 'setInterval(() => {}, 1000)'];
    const timeout = await runArgv(hang, { cwd: dir, timeoutMs: 200 });
    assert.equal(timeout.outcome, 'timeout');
    const controller = new AbortController();
    const pending = runArgv(hang, { cwd: dir, timeoutMs: 10_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    assert.equal((await pending).outcome, 'cancelled');

    const missing = await runArgv(['hs-orc-no-such-binary'], { cwd: dir, timeoutMs: 1_000 });
    assert.equal(missing.outcome, 'failed');
    assert.match(missing.tail, /실행하지 못했다/);
  });
});

interface Fake {
  readonly calls: { argv: readonly string[]; options: CommandOptions }[];
  readonly run: (argv: readonly string[], options: CommandOptions) => Promise<CommandRun>;
}
/** 가짜 실행기 — 스캐폴더면 파일을 만든다. `makeGit` 이면 스캐폴더가 저장소를 만든 것처럼 `git` 표시를 켠다. */
const fakeRunner = (git: { value: boolean }, options: { makeGit?: boolean; hang?: boolean } = {}): Fake => {
  const calls: Fake['calls'] = [];
  return {
    calls,
    run: (argv, opts) => {
      calls.push({ argv, options: opts });
      if (options.hang) {
        return new Promise((resolve) => opts.signal?.addEventListener('abort', () => resolve({ outcome: 'cancelled', exitCode: null, tail: '', durationMs: 5 })));
      }
      if (argv[0] === 'npx') {
        opts.onLine?.('Creating a new Next.js app');
        writeFileSync(path.join(opts.cwd, 'package.json'), '{}');
        writeFileSync(path.join(opts.cwd, 'next.config.ts'), '');
        if (options.makeGit) git.value = true;
      }
      if (argv[0] === 'git' && argv[1] === 'init') git.value = true;
      return Promise.resolve({ outcome: 'ok', exitCode: 0, tail: `ran ${argv.join(' ')}`, durationMs: 10 });
    },
  };
};

const make = (o: { mode?: 'manual' | 'auto-ask' | 'auto'; kind?: 'project' | 'scratch'; dir?: string; git?: { value: boolean }; runner?: Fake; withJev?: boolean; catalog?: () => Scaffolders } = {}) => {
  isolate();
  const dir = o.dir ?? mkdtempSync(path.join(os.tmpdir(), 'hs-scaffold-'));
  const git = o.git ?? { value: false };
  const runner = o.runner ?? fakeRunner(git);
  const prompts: string[] = [];
  const engines: string[] = [];
  let jevCalls = 0;
  const conduct: SlotExecutor = (_slot, prompt) => {
    prompts.push(prompt);
    return Promise.resolve(done('안내\nSUGGEST: R03'));
  };
  const jev: RowClassifier = () => {
    jevCalls += 1;
    return Promise.resolve({ choice: 'R03', probabilities: { R03: 0.95 }, confidence: 0.97, inputTokens: 1, outputTokens: 1, elapsedMs: 1 });
  };
  const session = new ConversationSession({
    matrix, catalog, kind: o.kind ?? 'project', dir, id: '1006-1200-sca', budget: new Budget(20, 2_000_000), journal: new Journal(),
    conduct,
    executorFor: () => (slot) => {
      engines.push(slot.role);
      return Promise.resolve(done(slot.role === 'reviewer' ? 'PASS' : 'ran'));
    },
    approvalMode: o.mode ?? 'auto',
    ...(o.withJev === false ? {} : { classifier: jev }),
    writeRows: ['R01', 'R03'],
    inGit: git.value,
    gitProbe: () => git.value,
    dirtyFiles: () => [],
    scaffolders: o.catalog ?? (() => scaffolders),
    runCommand: runner.run,
  });
  return { session, dir, git, runner, prompts, engines, jev: () => jevCalls };
};

describe('스캐폴딩 카드 — 세션 (D-088)', () => {
  it('빈 project 폴더의 스캐폴딩 요청은 Jev·지휘자 없이 카드가 서고, auto 여도 자동 실행하지 않는다 (H7)', async () => {
    for (const mode of ['auto', 'auto-ask', 'manual'] as const) {
      const m = make({ mode });
      const out = await m.session.send('hs-orc test용 next 앱 하나 init 해줘');
      assert.deepEqual(kinds(out), ['user', 'scaffold'], mode);
      const [, card] = out;
      assert.ok(card?.kind === 'scaffold' && card.scaffolder === 'next');
      assert.deepEqual(card.argv, next?.argv);
      assert.deepEqual(card.asked.map((a) => a.code), ['H7']);
      assert.equal(m.session.state, 'blocked');
      assert.ok(m.session.scaffoldPending);
      assert.equal(m.runner.calls.length, 0, `${mode} — 사람이 확인하기 전에는 실행하지 않는다`);
      assert.equal(m.jev(), 0, 'Jev 를 부르지 않는다');
      assert.deepEqual(m.prompts, [], '지휘자를 부르지 않는다');
      assert.ok(!m.session.records().some((r) => r.kind === 'spend'), '비용이 없다');
    }
  });

  it('승인하면 허용 목록 argv 를 세션 폴더에서 돌리고 결과·진행 줄을 남긴다 — 엔진 0회, git 이 없으면 git init 을 제안한다', async () => {
    const m = make();
    await m.session.send('next 앱 init 해줘');
    const out = await m.session.approve();
    assert.deepEqual(kinds(out), ['approval', 'scaffold-run']);
    const [approval, run] = out;
    assert.ok(approval?.kind === 'approval' && approval.approved && approval.by === 'user' && approval.asked?.join() === 'H7');
    assert.equal(m.runner.calls.length, 1);
    assert.deepEqual(m.runner.calls[0]?.argv, next?.argv);
    assert.equal(m.runner.calls[0]?.options.cwd, m.dir, 'cwd 는 세션 폴더로 고정');
    assert.equal(m.runner.calls[0]?.options.timeoutMs, scaffolders.timeoutMs);
    assert.ok(run?.kind === 'scaffold-run' && run.outcome === 'ok' && run.exitCode === 0 && run.git === 'offer');
    assert.deepEqual(run.created, ['next.config.ts', 'package.json']);
    assert.ok(m.session.progress.some((l) => /Creating a new Next\.js app/.test(l)), '진행 줄 (D-084)');
    assert.deepEqual(m.engines, []);
    assert.ok(!m.session.records().some((r) => r.kind === 'spend'));
    assert.equal(m.session.state, 'waiting_input');
    assert.ok(m.session.gitInitOffered);
  });

  it('git init 뒤 같은 세션의 쓰기 행은 H6 없이 쓰기를 켠 채 선다 — auto 는 클릭 없이 쓰기로 시작한다 (D-086 이어서)', async () => {
    const m = make();
    await m.session.send('next 앱 init 해줘');
    await m.session.approve();
    const init = await m.session.initGit();
    assert.ok(init[0]?.kind === 'scaffold-run' && init[0].step === 'git-init' && init[0].outcome === 'ok');
    assert.deepEqual(m.runner.calls.slice(1).map((c) => c.argv), GIT_INIT_COMMANDS);
    assert.ok(!m.session.gitInitOffered, '한 번 하면 더 제안하지 않는다');
    const out = await m.session.send('홈 화면에 버튼 추가해줘');
    const plan = out.find((r) => r.kind === 'plan');
    assert.ok(plan?.kind === 'plan' && plan.write === true && plan.readOnlyBlocked === undefined);
    assert.ok(!(plan.asked ?? []).some((a) => a.code === 'H6'));
    const approval = out.find((r) => r.kind === 'approval');
    assert.ok(approval?.kind === 'approval' && approval.by === 'auto' && approval.write === true);
  });

  it('스캐폴더가 저장소를 만들었으면 git init 을 제안하지 않는다', async () => {
    const git = { value: false };
    const m = make({ git, runner: fakeRunner(git, { makeGit: true }) });
    await m.session.send('next 앱 init 해줘');
    const [, run] = await m.session.approve();
    assert.ok(run?.kind === 'scaffold-run' && run.git === 'scaffolder');
    assert.ok(!m.session.gitInitOffered);
    await assert.rejects(m.session.initGit(), /git init 은 스캐폴딩이 git 없이 끝난 직후/);
  });

  it('비어 있지 않은 폴더는 카드를 세우지 않고 그 사유를 남긴다 — 지휘자는 행 대신 스캐폴딩 길을 안내한다', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-scaffold-full-'));
    writeFileSync(path.join(dir, 'notes.txt'), 'x');
    writeFileSync(path.join(dir, '.DS_Store'), '');
    const m = make({ dir, withJev: false });
    const out = await m.session.send('next 앱 init 해줘');
    assert.ok(!out.some((r) => r.kind === 'scaffold'));
    const direct = out.find((r) => r.kind === 'direct');
    assert.ok(direct?.kind === 'direct');
    assert.ok(direct.notes.some((n) => /스캐폴딩 카드를 세우지 않았다 — 폴더가 비어 있지 않다 \(1개: notes\.txt\)/.test(n)), direct.notes.join('|'));
    assert.equal(direct.suggest, null, '지휘자의 SUGGEST 는 버린다 — 행 위임으로는 스캐폴더가 돌지 않는다');
    const prompt = m.prompts[0] ?? '';
    assert.match(prompt, /\[스캐폴딩\]/);
    assert.match(prompt, /create-next-app@latest/);
    assert.match(prompt, /업무 행을 고르라고 안내하지 않는다/);
    assert.match(prompt, /마지막 줄은 반드시 `SUGGEST: NONE`/);
    assert.equal(m.runner.calls.length, 0);
  });

  it('카드와 승인 사이 폴더에 파일이 생기면 실행하지 않는다 (refused)', async () => {
    const m = make();
    await m.session.send('next 앱 init 해줘');
    writeFileSync(path.join(m.dir, 'late.txt'), 'x');
    const [, run] = await m.session.approve();
    assert.ok(run?.kind === 'scaffold-run' && run.outcome === 'refused' && /비어 있지 않다/.test(run.tail));
    assert.equal(m.runner.calls.length, 0);
  });

  it('스크래치·모르는 프레임워크는 카드 없이 지휘자 안내, 거절하면 카드를 닫는다', async () => {
    const scratch = make({ kind: 'scratch', withJev: false });
    const s = await scratch.session.send('next 앱 init 해줘');
    assert.ok(!s.some((r) => r.kind === 'scaffold'));
    assert.match(scratch.prompts[0] ?? '', /스크래치 세션이다/);

    const unknown = make({ withJev: false });
    await unknown.session.send('새 프로젝트 초기화해줘');
    assert.match(unknown.prompts[0] ?? '', /어느 스캐폴더인지 모른다/);

    const m = make();
    await m.session.send('next 앱 init 해줘');
    const [declined] = m.session.reject();
    assert.ok(declined?.kind === 'approval' && !declined.approved);
    assert.ok(!m.session.scaffoldPending);
    assert.equal(m.runner.calls.length, 0);
    assert.ok(!existsSync(path.join(m.dir, 'package.json')));
  });

  it('실행 중 취소하면 그 실행만 멈추고 cancelled 로 남는다 (D-066 통로)', async () => {
    const git = { value: false };
    const m = make({ git, runner: fakeRunner(git, { hang: true }) });
    await m.session.send('next 앱 init 해줘');
    const pending = m.session.approve();
    await new Promise((r) => setImmediate(r));
    assert.ok(m.session.cancellable);
    assert.ok(m.session.cancel());
    const [, run] = await pending;
    assert.ok(run?.kind === 'scaffold-run' && run.outcome === 'cancelled');
    assert.equal(m.session.state, 'waiting_input');
  });

  it('기존 프로젝트·스크래치의 일상 문장은 종전 경로 그대로다 — 지휘자 제안 카드가 남고 스캐폴딩 안내가 붙지 않는다 (PR #118 리뷰 Medium)', async () => {
    const occupied = () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-scaffold-existing-'));
      writeFileSync(path.join(dir, 'package.json'), '{}');
      return dir;
    };
    const sentences = ['앱을 시작하면 흰 화면이 나와', 'app create 버튼 추가', '앱 초기화 로직 설명해줘', '템플릿 초기화 함수 리팩터링', 'next 초기화 로직 고쳐줘'];
    for (const kind of ['project', 'scratch'] as const) {
      for (const text of sentences) {
        const m = make({ kind, mode: 'manual', withJev: false, git: { value: kind === 'project' }, ...(kind === 'project' ? { dir: occupied() } : {}) });
        const out = await m.session.send(text);
        const label = `${kind} · ${text}`;
        assert.ok(!out.some((r) => r.kind === 'scaffold'), label);
        assert.ok(!out.some((r) => (r.kind === 'direct' || r.kind === 'plan') && r.notes.some((n) => /스캐폴딩/.test(n))), `${label} — 분류 줄에 스캐폴딩 사유가 없다`);
        assert.ok(!m.prompts.some((p) => /\[스캐폴딩\]/.test(p)), `${label} — 지휘자 프롬프트는 종전 그대로`);
        const direct = out.find((r) => r.kind === 'direct');
        if (direct?.kind === 'direct') {
          assert.equal(direct.suggest, 'R03', `${label} — 지휘자 SUGGEST 가 살아 있다`);
          assert.ok(out.some((r) => r.kind === 'plan' && r.reason.startsWith('지휘자 제안')), `${label} — 제안 카드가 선다`);
        }
      }
    }
  });

  it('허용 목록은 실행 직전에 다시 읽는다 — 카드 뒤 목록에서 빠진 명령은 돌지 않는다 (PR #118 리뷰)', async () => {
    let current: Scaffolders = scaffolders;
    const m = make({ catalog: () => current });
    await m.session.send('next 앱 init 해줘');
    current = { ...scaffolders, scaffolders: scaffolders.scaffolders.filter((s) => s.id !== 'next') };
    const [, run] = await m.session.approve();
    assert.ok(run?.kind === 'scaffold-run' && run.outcome === 'refused' && /허용 목록/.test(run.tail), JSON.stringify(run));
    assert.equal(m.runner.calls.length, 0);
  });

  it('git init 이 끝나지 못하면(커밋 실패) 다시 제안하고, 다시 하면 끝난다 (PR #118 리뷰)', async () => {
    const git = { value: false };
    const base = fakeRunner(git);
    let commits = 0;
    const runner: Fake = {
      calls: base.calls,
      run: (argv, opts) => {
        if (argv[1] === 'commit' && ++commits === 1) {
          base.calls.push({ argv, options: opts });
          return Promise.resolve({ outcome: 'failed', exitCode: 128, tail: 'gpg failed to sign the data', durationMs: 3 });
        }
        return base.run(argv, opts);
      },
    };
    const m = make({ git, runner });
    await m.session.send('next 앱 init 해줘');
    await m.session.approve();
    const [failed] = await m.session.initGit();
    assert.ok(failed?.kind === 'scaffold-run' && failed.step === 'git-init' && failed.outcome === 'failed');
    assert.ok(git.value, 'git init 은 이미 됐다');
    assert.ok(m.session.gitInitOffered, '커밋이 실패했으니 다시 제안한다');
    const [ok] = await m.session.initGit();
    assert.ok(ok?.kind === 'scaffold-run' && ok.outcome === 'ok');
    assert.ok(!m.session.gitInitOffered);
  });

  it('지휘자 프롬프트 — 스캐폴딩 안내가 있으면 행을 고르라는 규칙 대신 그 안내를 싣는다', () => {
    const prompt = buildDirectPrompt(matrix, '', 'next 앱 init', { scaffold: '허용 목록: …' });
    assert.match(prompt, /\[스캐폴딩\]\n허용 목록: …/);
    assert.doesNotMatch(prompt, /맞는 행을 제안한다/);
    assert.match(prompt, /`SUGGEST: NONE` 이다/);
  });
});
