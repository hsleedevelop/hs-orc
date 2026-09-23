import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLineSplitter, parseLine } from '../stream.ts';

// 2026-09-20 에 세 CLI 를 실제로 돌려 캡처한 줄을 그대로 쓴다.
const CLAUDE_RESULT = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 3011,
  total_cost_usd: 0.048237,
  usage: { input_tokens: 10, output_tokens: 83, cache_read_input_tokens: 25980, cache_creation_input_tokens: 22607 },
});
const CURSOR_RESULT = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 7460,
  usage: { inputTokens: 3, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 24445 },
});
const CODEX_MESSAGE = JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'ok' } });
const CODEX_NOTICE = JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: '경고' } });
const CODEX_USAGE = JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 37675, cached_input_tokens: 11008, cache_write_input_tokens: 0, output_tokens: 5 },
});

describe('stream 파싱', () => {
  it('claude 의 result 줄에서 텍스트·사용량·비용을 뽑는다', () => {
    const events = parseLine('claude', CLAUDE_RESULT);
    assert.deepEqual(events.find((e) => e.kind === 'usage')?.usage, {
      inputTokens: 10, outputTokens: 83, cachedInputTokens: 25980, cacheWriteTokens: 22607,
    });
    const done = events.find((e) => e.kind === 'done');
    assert.deepEqual([done?.ok, done?.text, done?.costUsd], [true, 'ok', 0.048237]);
  });

  it('cursor 의 camelCase usage 를 같은 자리로 정규화한다', () => {
    const usage = parseLine('claude', CURSOR_RESULT).find((e) => e.kind === 'usage')?.usage;
    assert.deepEqual(usage, { inputTokens: 3, outputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 24445 });
  });

  it('cursor 는 total_cost_usd 를 주지 않으므로 비용이 비어 있다', () => {
    assert.equal(parseLine('claude', CURSOR_RESULT).find((e) => e.kind === 'done')?.costUsd, undefined);
  });

  it('codex 는 agent_message 에서 텍스트를, turn.completed 에서 사용량을 준다', () => {
    assert.deepEqual(parseLine('codex', CODEX_MESSAGE), [{ kind: 'text', text: 'ok' }]);
    assert.deepEqual(parseLine('codex', CODEX_USAGE).find((e) => e.kind === 'usage')?.usage, {
      inputTokens: 37675, outputTokens: 5, cachedInputTokens: 11008, cacheWriteTokens: 0,
    });
  });

  it('codex 의 item.type="error" 는 실행 실패가 아니라 notice 다', () => {
    assert.deepEqual(parseLine('codex', CODEX_NOTICE), [{ kind: 'notice', level: 'warn', message: '경고' }]);
  });
});

describe('깨진 줄', () => {
  it('깨진 JSON 한 줄은 던지지 않고 unparsed 로 남는다', () => {
    const events = parseLine('claude', '{"type":"result", 깨짐');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'unparsed');
  });

  it('깨진 줄이 뒤따르는 정상 줄의 파싱을 막지 않는다', () => {
    const lines = ['not json at all', CLAUDE_RESULT];
    const events = lines.flatMap((l) => parseLine('claude', l));
    assert.equal(events.filter((e) => e.kind === 'unparsed').length, 1);
    assert.equal(events.find((e) => e.kind === 'done')?.text, 'ok');
  });

  it('최상위가 객체가 아닌 JSON 도 unparsed 다', () => {
    assert.equal(parseLine('codex', '[1,2,3]')[0]?.kind, 'unparsed');
    assert.deepEqual(parseLine('codex', '   '), []);
  });
});

describe('줄 분할', () => {
  it('청크 경계를 가로지르는 줄을 이어 붙인다', () => {
    const split = createLineSplitter();
    assert.deepEqual(split('{"a":1}\n{"b":'), ['{"a":1}']);
    assert.deepEqual(split('2}\n'), ['{"b":2}']);
  });
});

describe('엔진 세션 id (SPEC §3.8)', () => {
  it('claude·cursor 는 result 줄의 session_id 를 낸다', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'b338a8c5-2660-4dd9-bba2-d665ae8e9759' });
    assert.ok(parseLine('claude', line).some((e) => e.kind === 'session' && e.id === 'b338a8c5-2660-4dd9-bba2-d665ae8e9759'));
  });
  it('codex 는 thread.started 의 thread_id 를 낸다', () => {
    const line = JSON.stringify({ type: 'thread.started', thread_id: '01a0cdb0-2134-7742-932e-ffeb293f61c1' });
    assert.deepEqual(parseLine('codex', line), [{ kind: 'session', id: '01a0cdb0-2134-7742-932e-ffeb293f61c1' }]);
  });
  it('id 가 문자열이 아니면 내지 않는다 — 지어내지 않는다', () => {
    const line = JSON.stringify({ type: 'result', result: 'ok', session_id: 42 });
    assert.ok(!parseLine('claude', line).some((e) => e.kind === 'session'));
  });
});
