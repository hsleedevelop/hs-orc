import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RowClassifier } from '../../adapters/jev.ts';
import { defaultJev } from '../jev.ts';

/**
 * Jev 누수 가드 — 키가 있는 셸에서 테스트가 api.typesafe.ai 로 나가지 않는다.
 *
 * Jev 는 기본 켜짐이다 (D-065). `scripts/test-setup.mjs`(npm test 의 `--import`)가 HS_ORC_JEV=off 를 강제하고,
 * 자식 프로세스는 `...process.env` 로 물려받는다. 그 격리가 **풀렸는지** 여기서 잰다.
 * 음성 대조: 같은 경로에서 격리(HS_ORC_JEV)만 지우면 fetch 가 실제로 불린다 — 가드가 무의미하게 통과하지 않는다는 증거.
 */
const BIN = path.resolve(import.meta.dirname, '..', '..', '..', 'bin', 'hs-orc.mjs');
const FAKE_KEY = 'leak-guard-fake-key';
const REQUEST = { state: '오늘 점심 뭐 먹지', instructions: 'x', criteria: {} };

/** fetch 를 세는 가짜 — 네트워크로 나가지 않는다. */
const withFakeFetch = async (run: () => Promise<void>) => {
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((url: string | URL) => {
    urls.push(url.toString());
    return Promise.resolve(new Response('{}', { status: 401 }));
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
  return urls;
};

describe('Jev 누수 가드', () => {
  it('테스트 프로세스에 격리가 실려 있다 — HS_ORC_JEV=off', () => {
    assert.equal(process.env['HS_ORC_JEV'], 'off', 'npm test 의 --import scripts/test-setup.mjs 가 빠졌다.');
  });

  it('키가 있어도 합성 루트가 Jev 를 만들지 않아 api.typesafe.ai 호출이 0회다', async () => {
    const urls = await withFakeFetch(async () => {
      const jev: RowClassifier | undefined = defaultJev({ ...process.env, TYPESAFE_API_KEY: FAKE_KEY });
      await jev?.(REQUEST);
      assert.equal(jev, undefined);
    });
    assert.deepEqual(urls, []);
  });

  it('음성 대조: 격리를 풀면 같은 경로가 api.typesafe.ai 를 부른다', async () => {
    const urls = await withFakeFetch(async () => {
      const jev = defaultJev({ ...process.env, HS_ORC_JEV: '', TYPESAFE_API_KEY: FAKE_KEY });
      await jev?.(REQUEST).catch(() => undefined);
    });
    assert.equal(urls.length, 1);
    assert.match(urls[0] ?? '', /api\.typesafe\.ai/);
  });

  describe('CLI 자식 프로세스', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-orc-jevleak-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    // 자식의 fetch 호출을 파일에 적는 preload — 실제 네트워크로 나가지 않는다.
    const preload = path.join(dir, 'count-fetch.mjs');
    const calls = path.join(dir, 'calls.txt');
    writeFileSync(
      preload,
      `import { appendFileSync } from 'node:fs';
globalThis.fetch = (url) => { appendFileSync(${JSON.stringify(calls)}, String(url) + '\\n'); return Promise.resolve(new Response('{}', { status: 401 })); };
`,
    );
    const run = (env: NodeJS.ProcessEnv) => {
      rmSync(calls, { force: true });
      spawnSync(process.execPath, ['--import', preload, BIN, '오늘 점심 뭐 먹지'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...env, PATH: '', HS_ORC_DECISION_LOG: path.join(dir, 'log.jsonl'), TYPESAFE_API_KEY: FAKE_KEY },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];
    };

    it('격리를 물려받은 CLI 는 api.typesafe.ai 를 부르지 않는다', () => {
      assert.deepEqual(run({ ...process.env }), []);
    });

    it('음성 대조: 격리를 지운 CLI 는 부른다', () => {
      const urls = run({ ...process.env, HS_ORC_JEV: '' });
      assert.ok(urls.length >= 1 && urls.every((u) => /api\.typesafe\.ai/.test(u)), `호출: ${urls.join(',')}`);
    });
  });
});
