import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

  it('codex 는 agent_message 에서 텍스트를, turn.completed 에서 사용량을 준다 (input 은 cached 를 뺀 값)', () => {
    assert.deepEqual(parseLine('codex', CODEX_MESSAGE), [{ kind: 'text', text: 'ok' }]);
    assert.deepEqual(parseLine('codex', CODEX_USAGE).find((e) => e.kind === 'usage')?.usage, {
      inputTokens: 26667, outputTokens: 5, cachedInputTokens: 11008, cacheWriteTokens: 0,
    });
  });

  it('codex 의 item.type="error" 는 실행 실패가 아니라 notice 다', () => {
    assert.deepEqual(parseLine('codex', CODEX_NOTICE), [{ kind: 'notice', level: 'warn', message: '경고' }]);
  });

  it('codex 의 input_tokens 가 cached_input_tokens 이하라도 inputTokens 는 음수로 내려가지 않는다', () => {
    const line = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 100, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 5 },
    });
    assert.deepEqual(parseLine('codex', line).find((e) => e.kind === 'usage')?.usage, {
      inputTokens: 0, outputTokens: 5, cachedInputTokens: 100, cacheWriteTokens: 0,
    });
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
  it('claude 의 compact_boundary 는 압축 이벤트다 — 2026-09-26 실측 줄 (D-058)', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'compact_boundary', session_id: 'S', compact_metadata: { trigger: 'manual', pre_tokens: 43869, post_tokens: 9340, cumulative_dropped_tokens: 34529, duration_ms: 16770 } });
    assert.deepEqual(parseLine('claude', line), [{ kind: 'compact', compaction: { trigger: 'manual', preTokens: 43869, postTokens: 9340 } }]);
    // 메타데이터가 없어도 압축 사실은 남긴다 — 토큰 칸은 지어내지 않는다.
    assert.deepEqual(parseLine('claude', JSON.stringify({ type: 'system', subtype: 'compact_boundary' })), [{ kind: 'compact', compaction: { trigger: 'unknown' } }]);
  });
  it('id 가 문자열이 아니면 내지 않는다 — 지어내지 않는다', () => {
    const line = JSON.stringify({ type: 'result', result: 'ok', session_id: 42 });
    assert.ok(!parseLine('claude', line).some((e) => e.kind === 'session'));
  });
});

/** 2026-09-26 Q17 실측 원본 (claude 2.1.283 · Haiku low) — 1턴과 그 세션을 `/compact` 로 resume 한 실행. */
const fixture = (name: string): string[] =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').split('\n');

describe('claude 토큰은 modelUsage 합으로 읽는다 (D-060)', () => {
  it('1턴: result.usage(10·392) 가 아니라 modelUsage(937·405) 다 — 보조 호출까지 든 total_cost_usd 와 같은 범위', () => {
    const events = fixture('claude-q17-turn1.jsonl').flatMap((l) => parseLine('claude', l));
    assert.equal(events.filter((e) => e.kind === 'unparsed').length, 0);
    const usage = events.filter((e) => e.kind === 'usage');
    assert.equal(usage.length, 1, 'usage 와 modelUsage 를 둘 다 내면 두 번 센다');
    assert.deepEqual(usage[0]?.usage, { inputTokens: 937, outputTokens: 405, cachedInputTokens: 12972, cacheWriteTokens: 7171 });
  });

  it('/compact 실행: result.usage 는 0 이지만 modelUsage 는 압축 몫을 품은 세션 누적이다', () => {
    const events = fixture('claude-q17-compact.jsonl').flatMap((l) => parseLine('claude', l));
    assert.equal(events.filter((e) => e.kind === 'unparsed').length, 0);
    assert.deepEqual(events.find((e) => e.kind === 'compact')?.compaction, { trigger: 'manual', preTokens: 20546, postTokens: 1362 });
    assert.deepEqual(events.find((e) => e.kind === 'usage')?.usage, {
      inputTokens: 2373, outputTokens: 1443, cachedInputTokens: 33115, cacheWriteTokens: 7570,
    });
  });

  it('모델이 여럿이면 모델별 칸을 더한다 — 다른 모델의 보조 호출도 빠지지 않는다', () => {
    const line = JSON.stringify({ ...JSON.parse(CLAUDE_RESULT), modelUsage: {
      'claude-opus-5-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 3000, cacheCreationInputTokens: 400 },
      'claude-haiku-4-5-20251001': { inputTokens: 900, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    } });
    assert.deepEqual(parseLine('claude', line).flatMap((e) => (e.kind === 'usage' ? [e.usage] : [])), [
      { inputTokens: 1000, outputTokens: 30, cachedInputTokens: 3000, cacheWriteTokens: 400 },
    ]);
  });

  it('modelUsage 가 없거나 비었으면 result.usage 로 떨어진다 (cursor)', () => {
    const empty = JSON.stringify({ ...JSON.parse(CLAUDE_RESULT), modelUsage: {} });
    for (const line of [CLAUDE_RESULT, empty]) {
      assert.deepEqual(parseLine('claude', line).find((e) => e.kind === 'usage')?.usage, {
        inputTokens: 10, outputTokens: 83, cachedInputTokens: 25980, cacheWriteTokens: 22607,
      });
    }
  });
});

/** 2026-09-26 Q18 실측 원본 (claude 2.1.283 · Haiku low, 새 실행 1회씩) — 지휘자 격리 argv · 그 argv + 창 env · 비격리 등가 + `autoCompactWindow`. */
describe('실패한 압축 시도는 압축으로 세지 않는다 (D-058, Q18 캡처)', () => {
  const compactions = (name: string) => {
    const events = fixture(name).flatMap((l) => parseLine('claude', l));
    assert.equal(events.filter((e) => e.kind === 'unparsed').length, 0, name);
    return events.flatMap((e) => (e.kind === 'compact' ? [e.compaction] : []));
  };

  it('격리는 임계값 판정을 건너뛰고, env 로 켠 판정은 too_few_groups 로 실패해 status 줄만 남는다 — 둘 다 압축 없음', () => {
    assert.deepEqual(compactions('claude-q18-isolated.jsonl'), []);
    assert.ok(fixture('claude-q18-isolated-env.jsonl').some((l) => l.includes('"compact_result":"failed"')), '실패한 시도 줄이 캡처에 있어야 이 검사가 뜻이 있다');
    assert.deepEqual(compactions('claude-q18-isolated-env.jsonl'), []);
  });

  it('설정 출처면 한 실행 안에서 자동 압축한다 — 성공한 두 번만 읽는다', () => {
    assert.deepEqual(compactions('claude-q18-settings.jsonl'), [
      { trigger: 'auto', preTokens: 20532, postTokens: 1742 },
      { trigger: 'auto', preTokens: 19824, postTokens: 2001 },
    ]);
  });
});
