import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadEngines } from '../../data/engines.ts';
import { EngineError, buildInvocation } from '../resolve.ts';
import { adapterFor, createAdapter } from '../engine.ts';

const catalog = loadEngines();
const build = (model: Parameters<typeof buildInvocation>[1], effort: string, engine?: 'claude' | 'codex' | 'cursor') =>
  buildInvocation(catalog, model, effort, 'PROMPT', engine);

describe('쓰기 권한 (D-025)', () => {
  it('기본은 읽기 전용이다 — 쓰기 인자가 붙지 않는다', () => {
    for (const argv of [build('sol', 'high').argv, build('fable', 'high').argv, build('opus', 'high', 'cursor').argv]) {
      assert.doesNotMatch(argv.join(' '), /workspace-write|acceptEdits|--force/);
    }
  });

  it('codex 는 쓰기를 요청하지 않으면 읽기 전용 sandbox 를 명시한다 — 신뢰된 폴더의 기본값에 기대지 않는다 (D-051)', () => {
    const readOnly = 'sandbox_mode="read-only"';
    assert.ok(build('luna', 'medium', 'codex').argv.includes(readOnly));
    // exec resume 은 -s 를 받지 않는다 — 같은 -c 로 resume 경로도 막는다.
    assert.ok(buildInvocation(catalog, 'luna', 'low', 'hi', { engine: 'codex', resume: 'T1' }).argv.includes(readOnly));
    assert.ok(!buildInvocation(catalog, 'luna', 'medium', 'PROMPT', { engine: 'codex', write: true }).argv.includes(readOnly));
  });

  it('엔진별 실측 플래그를 붙인다 — 워크스페이스 밖까지 여는 값은 쓰지 않는다', () => {
    const write = (model: Parameters<typeof buildInvocation>[1], engine: 'claude' | 'codex' | 'cursor') =>
      buildInvocation(catalog, model, 'high', 'PROMPT', { engine, write: true }).argv;
    assert.deepEqual(write('sol', 'codex').slice(-2), ['-s', 'workspace-write']);
    assert.deepEqual(write('fable', 'claude').slice(-2), ['--permission-mode', 'acceptEdits']);
    assert.deepEqual(write('opus', 'cursor').slice(-1), ['--force']);
    for (const argv of [write('sol', 'codex'), write('fable', 'claude'), write('opus', 'cursor')]) {
      assert.doesNotMatch(argv.join(' '), /danger-full-access|bypassPermissions|--yolo/);
    }
  });

  it('선언이 없는 엔진에 쓰기를 요청하면 읽기 전용으로 떨어지지 않고 던진다', () => {
    // 선언을 **지운** 카탈로그다. `write: undefined` 로는 exactOptionalPropertyTypes 가 막는다.
    const stripped = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
    delete (stripped.engines.codex as { write?: unknown }).write;
    assert.throws(
      () => buildInvocation(stripped, 'sol', 'high', 'PROMPT', { engine: 'codex', write: true }),
      /쓰기 권한 선언이 없다/,
    );
  });
});

describe('argv 생성', () => {
  it('codex 는 exec 서브커맨드와 -c model_reasoning_effort 를 쓴다', () => {
    assert.deepEqual(build('sol', 'xhigh').argv, [
      'exec', 'PROMPT', '-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="xhigh"', '-c', 'sandbox_mode="read-only"',
    ]);
  });

  it('claude 는 -p 와 --effort 를 쓴다', () => {
    assert.deepEqual(build('fable', 'high').argv, [
      '-p', 'PROMPT', '--model', 'claude-fable-5-1', '--effort', 'high',
    ]);
  });

  it('cursor 는 effort 를 모델 id 접미사로 녹이고 별도 플래그를 두지 않는다', () => {
    const invocation = build('opus', 'max', 'cursor');
    assert.equal(invocation.modelId, 'claude-opus-5-thinking-max');
    assert.deepEqual(invocation.argv, ['-p', 'PROMPT', '--model', 'claude-opus-5-thinking-max']);
  });
});

describe('명시적 실패', () => {
  it('정규 어휘 밖의 effort 는 던진다 (조용한 폴백 없음)', () => {
    assert.throws(() => build('sol', 'bogus'), EngineError);
    assert.throws(() => build('sol', 'ultra'), EngineError);
  });

  it('cursor 에 없는 Astra·Haiku 는 가장 가까운 모델로 바뀌지 않고 던진다', () => {
    assert.throws(() => build('astra', 'max', 'cursor'), /cursor 는 astra 를 제공하지 않는다/);
    assert.throws(() => build('haiku', 'low', 'cursor'), /cursor 는 haiku 를 제공하지 않는다/);
  });

  it('벤더가 다른 엔진에 모델을 요청하면 던진다', () => {
    assert.throws(() => build('fable', 'high', 'codex'), EngineError);
    assert.throws(() => build('sol', 'high', 'claude'), EngineError);
  });
});

describe('supports()', () => {
  it('cursor 는 Astra·Haiku 를 지원하지 않는다고 답한다', () => {
    const cursor = createAdapter('cursor', catalog);
    assert.equal(cursor.supports('astra', 'max'), false);
    assert.equal(cursor.supports('haiku', 'low'), false);
    assert.equal(cursor.supports('sol', 'xhigh'), true);
  });

  it('기본 엔진이 못 받는 조합은 adapterFor 가 던진다', () => {
    assert.throws(() => adapterFor('astra', 'bogus', catalog), EngineError);
  });

  it('argv 끝에 엔진별 스트림 인자가 붙는다 — codex 는 --output-format 이 아니라 --json', () => {
    const req = { model: 'sol', effort: 'high', prompt: 'P', cwd: '.', timeoutMs: 1000 } as const;
    assert.deepEqual(createAdapter('codex', catalog).buildArgv(req).slice(-1), ['--json']);
    assert.deepEqual(createAdapter('claude', catalog).buildArgv({ ...req, model: 'fable' }).slice(-3), [
      '--output-format', 'stream-json', '--verbose',
    ]);
  });
});

describe('Cursor -fast (D-023)', () => {
  it('fast 가 있는 모델은 모델 id 에 -fast 가 붙는다', () => {
    assert.equal(
      buildInvocation(catalog, 'sol', 'xhigh', 'P', { engine: 'cursor', fast: true }).modelId,
      'gpt-5.6-sol-xhigh-fast',
    );
    assert.equal(
      buildInvocation(catalog, 'opus', 'max', 'P', { engine: 'cursor', fast: true }).modelId,
      'claude-opus-5-thinking-max-fast',
    );
  });

  it('fast 가 없는 Sonnet·Fable 은 일반 변형으로 떨어지지 않고 던진다', () => {
    assert.throws(() => buildInvocation(catalog, 'sonnet', 'high', 'P', { engine: 'cursor', fast: true }), /-fast 변형이 없다/);
    assert.throws(() => buildInvocation(catalog, 'fable', 'high', 'P', { engine: 'cursor', fast: true }), /-fast 변형이 없다/);
  });

  it('cursor 가 아닌 엔진에 fast 를 요청하면 던진다', () => {
    assert.throws(() => buildInvocation(catalog, 'sol', 'high', 'P', { engine: 'codex', fast: true }), /fast 는 cursor 전용/);
  });

  it('기본값은 fast 미사용이다 (SPEC §3.3 추론 품질 우선)', () => {
    assert.equal(buildInvocation(catalog, 'sol', 'xhigh', 'P', 'cursor').modelId, 'gpt-5.6-sol-xhigh');
  });
});

describe('git 밖 실행 (스크래치, SPEC §6.4.1)', () => {
  const catalog = loadEngines();
  it('codex 는 nonGit 이면 --skip-git-repo-check 를 붙인다', () => {
    const { argv } = buildInvocation(catalog, 'luna', 'low', 'hi', { engine: 'codex', nonGit: true });
    assert.ok(argv.includes('--skip-git-repo-check'));
  });
  it('기본은 붙이지 않는다 — git 검사가 지키던 것을 project 세션에서 버리지 않는다', () => {
    const { argv } = buildInvocation(catalog, 'luna', 'low', 'hi', { engine: 'codex' });
    assert.ok(!argv.includes('--skip-git-repo-check'));
  });
  it('쓰기와 git 밖 실행을 함께 받지 않는다 — 스크래치 쓰기 금지를 셸에만 맡기지 않는다', () => {
    assert.throws(
      () => buildInvocation(catalog, 'luna', 'low', 'hi', { engine: 'codex', write: true, nonGit: true }),
      EngineError,
    );
  });
  it('선언이 없는 엔진은 nonGit 이어도 아무것도 붙이지 않는다', () => {
    const plain = buildInvocation(catalog, 'haiku', 'low', 'hi', { engine: 'claude' }).argv;
    const nonGit = buildInvocation(catalog, 'haiku', 'low', 'hi', { engine: 'claude', nonGit: true }).argv;
    assert.deepEqual(nonGit, plain);
  });
});

describe('resume argv (SPEC §3.8, Q10 실측)', () => {
  const catalog = loadEngines();
  it('claude 는 --resume <id> 를 붙인다', () => {
    const { argv } = buildInvocation(catalog, 'haiku', 'low', 'hi', { engine: 'claude', resume: 'S1' });
    const i = argv.indexOf('--resume');
    assert.ok(i >= 0 && argv[i + 1] === 'S1');
  });
  it('codex 는 exec resume <id> <prompt> 순서다', () => {
    const { argv } = buildInvocation(catalog, 'luna', 'low', 'hi', { engine: 'codex', resume: 'T1' });
    assert.deepEqual(argv.slice(0, 4), ['exec', 'resume', 'T1', 'hi']);
    assert.ok(argv.includes('-m'));
  });
  it('cursor 는 --resume <id> 를 붙인다', () => {
    const { argv } = buildInvocation(catalog, 'luna', 'low', 'hi', { engine: 'cursor', resume: 'C1' });
    const i = argv.indexOf('--resume');
    assert.ok(i >= 0 && argv[i + 1] === 'C1');
  });
  it('resume 이 없으면 argv 가 그대로다', () => {
    const { argv } = buildInvocation(catalog, 'luna', 'low', 'hi', { engine: 'codex' });
    assert.ok(!argv.includes('resume'));
  });

  it('선언이 없는 엔진에 resume 을 요청하면 맥락 없는 새 실행으로 떨어지지 않고 던진다', () => {
    // 선언을 **지운** 카탈로그다. `resume: undefined` 로는 exactOptionalPropertyTypes 가 막는다.
    const stripped = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
    delete (stripped.engines.claude as { resume?: unknown }).resume;
    assert.throws(
      () => buildInvocation(stripped, 'haiku', 'low', 'hi', { engine: 'claude', resume: 'S1' }),
      /resume 선언이 없다/,
    );
  });

  it('codex 는 resume 상태에서 쓰기를 받지 않는다 — 두 플래그를 같이 붙이지 않고 던진다 (final-review #1)', () => {
    assert.throws(
      () => buildInvocation(catalog, 'luna', 'medium', 'hi', { engine: 'codex', resume: 'T1', write: true }),
      (error: unknown) => error instanceof EngineError && /codex/.test(error.message) && /resume/.test(error.message) && /쓰기/.test(error.message),
    );
  });

  it('resume 상태에서 쓰기를 거절해도 resume 단독·write 단독은 그대로 된다', () => {
    const resumeOnly = buildInvocation(catalog, 'luna', 'medium', 'hi', { engine: 'codex', resume: 'T1' }).argv;
    assert.ok(!resumeOnly.includes('-s'));
    const writeOnly = buildInvocation(catalog, 'luna', 'medium', 'hi', { engine: 'codex', write: true }).argv;
    assert.deepEqual(writeOnly.slice(-2), ['-s', 'workspace-write']);
  });
});

describe('격리 (D-032 B1) — 지휘자만 사용자 전역 설정에서 뗀다', () => {
  const catalog = loadEngines();
  it('claude 는 isolate 요청 시 선언된 다섯 인자를 그대로, 순서대로 붙인다', () => {
    const { argv } = buildInvocation(catalog, 'haiku', 'low', 'hi', { engine: 'claude', isolate: true });
    assert.deepEqual(argv.slice(-5), ['--setting-sources', 'project,local', '--strict-mcp-config', '--disable-slash-commands', '--safe-mode']);
  });

  it('claude 는 isolate 를 요청하지 않으면 격리 인자가 하나도 없다', () => {
    const { argv } = buildInvocation(catalog, 'haiku', 'low', 'hi', { engine: 'claude' });
    assert.doesNotMatch(argv.join(' '), /--setting-sources|--strict-mcp-config|--disable-slash-commands|--safe-mode/);
  });

  it('선언이 없는 엔진(codex)에 isolate 를 요청하면 격리 없이 조용히 돌리지 않고 던진다', () => {
    assert.throws(
      () => buildInvocation(catalog, 'luna', 'low', 'hi', { engine: 'codex', isolate: true }),
      /격리 인자 선언이 없다/,
    );
  });
});
