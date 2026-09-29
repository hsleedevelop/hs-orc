/**
 * Jev 클라이언트 (D-065). 실제 네트워크는 쓰지 않는다 — fetch 를 가짜로 바꾼다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JEV_ENDPOINT, JevUnavailableError, createJevClient, jevEnabled, type JevChoiceRequest } from '../jev.ts';

const KEY = 'tsk-secret-value-123';
const request: JevChoiceRequest = { state: '이 타입 에러 고쳐줘', instructions: '하나 고른다', criteria: { R01: '짧은 구현', NONE: '해당 없음' } };
const body = {
  answers: { row: { choice: 'R01', probabilities: { R01: 0.95, NONE: 0.05 }, confidence: 0.9 } },
  usage: { input_tokens: 1032, output_tokens: 12 },
};
const ok = (json: unknown = body): typeof fetch => () => Promise.resolve(Response.json(json));
const status = (code: number): typeof fetch => () => Promise.resolve(new Response(`{"error":"${KEY}"}`, { status: code }));
const client = (f: typeof fetch, env: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: KEY }) => createJevClient({ env, fetch: f });
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    assert.ok(error instanceof JevUnavailableError, `JevUnavailableError 여야 한다: ${String(error)}`);
    return error;
  }
  return assert.fail('던져야 한다');
};

describe('Jev 클라이언트', () => {
  it('Choice 질문을 보내고 선택·확률·확신도·토큰을 읽는다', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const answer = await client((url, init) => {
      seen = { url: typeof url === 'string' ? url : 'non-string-url', init: init ?? {} };
      return Promise.resolve(Response.json(body));
    })(request);
    assert.equal(seen?.url, JEV_ENDPOINT);
    const headers = seen?.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], `Bearer ${KEY}`);
    const sent = JSON.parse(seen?.init.body as string) as { model: string; state: string; questions: { row: { type: string; criteria: object } } };
    assert.equal(sent.model, 'jev-latest');
    assert.equal(sent.state, '이 타입 에러 고쳐줘');
    assert.equal(sent.questions.row.type, 'choice');
    assert.deepEqual(sent.questions.row.criteria, request.criteria);
    assert.deepEqual([answer.choice, answer.confidence, answer.inputTokens, answer.outputTokens], ['R01', 0.9, 1032, 12]);
    assert.equal(answer.probabilities['R01'], 0.95);
  });

  it('키가 없으면 요청을 보내지 않고 no-key 로 던진다', async () => {
    let called = false;
    const error = await failure(client(() => ((called = true), Promise.resolve(Response.json(body))), { TYPESAFE_API_KEY: '  ' })(request));
    assert.equal(error.failure, 'no-key');
    assert.equal(called, false);
  });

  it('상태 코드를 사유로 옮긴다 — 401·422·429·529·그 외', async () => {
    const got = await Promise.all([401, 422, 429, 529, 500].map(async (code) => (await failure(client(status(code))(request))).failure));
    assert.deepEqual(got, ['auth', 'rejected', 'rate-limit', 'overloaded', 'http']);
  });

  it('네트워크 오류·시간 초과를 가른다', async () => {
    const net = await failure(client(() => Promise.reject(new TypeError('fetch failed')))(request));
    assert.equal(net.failure, 'network');
    const late = await failure(client(() => Promise.reject(new DOMException('t', 'TimeoutError')))(request));
    assert.equal(late.failure, 'timeout');
  });

  it('응답 모양이 틀리면 bad-response 다 — 행을 추측하지 않는다', async () => {
    for (const json of [{}, { answers: {} }, { answers: { row: { choice: 'R01' } } }, { answers: { row: { choice: 1, probabilities: {}, confidence: 1 } } }]) {
      assert.equal((await failure(client(ok(json))(request))).failure, 'bad-response');
    }
    assert.equal((await failure(client(() => Promise.resolve(new Response('<html>', { status: 200 })))(request))).failure, 'bad-response');
  });

  it('오류 문구에 키가 들어가지 않는다 — 응답 본문이 키를 되돌려도', async () => {
    for (const code of [401, 422, 500]) assert.doesNotMatch((await failure(client(status(code))(request))).message, /tsk-secret/);
  });

  it('HS_ORC_JEV 로 끈다', () => {
    assert.equal(jevEnabled({}), true);
    for (const off of ['off', '0', 'false', 'OFF']) assert.equal(jevEnabled({ HS_ORC_JEV: off }), false);
  });
});
