/**
 * 엔진 스트림 파싱 (SPEC §3.7).
 * **중첩 try**: 한 줄의 파싱 실패가 실행 전체를 죽이지 않는다. 대신 `unparsed` 이벤트로 남긴다.
 *
 * 스키마는 2026-09-20에 세 CLI 를 실제로 돌려 캡처한 것이다:
 *  - claude(`--output-format stream-json --verbose`), cursor(`--output-format stream-json`)
 *      → system / user / assistant / result. 최종 텍스트는 `result.result`.
 *  - codex(`--json`, `--output-format` 자체가 없다)
 *      → thread.started / turn.started / item.completed / turn.completed.
 *        최종 텍스트는 `item.type === 'agent_message'` 의 `text`, 사용량은 `turn.completed.usage`.
 */
import type { RunEvent, Usage } from './types.ts';

export type StreamFormat = 'claude' | 'codex';

const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** 배열도 `typeof === 'object'` 라 명시적으로 걸러낸다. */
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function claudeEvents(event: Record<string, unknown>): RunEvent[] {
  if (event['type'] === 'system' && event['subtype'] === 'compact_boundary') return [compactEvent(event)];
  if (event['type'] !== 'result') return [];

  const out: RunEvent[] = [];
  // Q10 실측: claude·cursor 모두 result 줄에 session_id 를 싣는다. 한 번만 내도록 result 줄에서만 읽는다.
  if (typeof event['session_id'] === 'string') out.push({ kind: 'session', id: event['session_id'] });
  const models = modelUsageTotal(event['modelUsage']);
  const usage = asRecord(event['usage']);
  // D-060: `modelUsage` 가 있으면 그것만 쓴다. `usage` 와 더하면 같은 토큰을 두 번 센다.
  if (models) out.push({ kind: 'usage', usage: models });
  else if (usage) {
    // claude 는 snake_case, cursor 는 camelCase 로 같은 자리를 채운다.
    const normalized: Usage = {
      inputTokens: num(usage['input_tokens'] ?? usage['inputTokens']),
      outputTokens: num(usage['output_tokens'] ?? usage['outputTokens']),
      cachedInputTokens: num(usage['cache_read_input_tokens'] ?? usage['cacheReadTokens']),
      cacheWriteTokens: num(usage['cache_creation_input_tokens'] ?? usage['cacheWriteTokens']),
    };
    out.push({ kind: 'usage', usage: normalized });
  }

  const text = typeof event['result'] === 'string' ? event['result'] : '';
  const cost = event['total_cost_usd'];
  out.push({
    kind: 'done',
    ok: event['is_error'] !== true,
    text,
    ...(typeof cost === 'number' ? { costUsd: cost } : {}),
  });
  return out;
}

/**
 * D-060: claude `modelUsage` 의 모델별 합. `total_cost_usd` 와 같은 범위라 압축·보조 호출 토큰까지 든다 —
 * `result.usage` 는 본 대화 턴 몫뿐이고 압축 실행에서는 0 이다 (2026-09-26 실측, fixtures/claude-q17-*).
 * `outputTokens` 는 thinking 을 이미 포함한다(실측 금액이 thinking 을 따로 더하지 않아야 맞는다).
 * 없거나 비었으면(cursor) undefined — 호출자가 `usage` 로 떨어진다.
 */
function modelUsageTotal(value: unknown): Usage | undefined {
  const models = Object.values(asRecord(value) ?? {})
    .map(asRecord)
    .filter((m): m is Record<string, unknown> => m !== null);
  if (models.length === 0) return undefined;
  const sum = (key: string): number => models.reduce((total, m) => total + num(m[key]), 0);
  return {
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cachedInputTokens: sum('cacheReadInputTokens'),
    cacheWriteTokens: sum('cacheCreationInputTokens'),
  };
}

/** D-058: resume 체인에서 엔진이 앞 맥락을 요약으로 바꿨다는 신호. orc 는 이것 없이는 모른다. */
function compactEvent(event: Record<string, unknown>): RunEvent {
  const meta = asRecord(event['compact_metadata']) ?? {};
  const pre = meta['pre_tokens'];
  const post = meta['post_tokens'];
  return {
    kind: 'compact',
    compaction: {
      trigger: typeof meta['trigger'] === 'string' ? meta['trigger'] : 'unknown',
      ...(typeof pre === 'number' ? { preTokens: pre } : {}),
      ...(typeof post === 'number' ? { postTokens: post } : {}),
    },
  };
}

function codexEvents(event: Record<string, unknown>): RunEvent[] {
  switch (event['type']) {
    case 'thread.started':
      return typeof event['thread_id'] === 'string' ? [{ kind: 'session', id: event['thread_id'] }] : [];
    case 'item.completed': {
      const item = asRecord(event['item']);
      if (!item) return [];
      if (item['type'] === 'agent_message' && typeof item['text'] === 'string') {
        return [{ kind: 'text', text: item['text'] }];
      }
      if (item['type'] === 'error' && typeof item['message'] === 'string') {
        // codex 는 경고성 안내도 item.type='error' 로 흘린다 — 실행 실패와 구분해 notice 로 둔다.
        return [{ kind: 'notice', level: 'warn', message: item['message'] }];
      }
      return [];
    }
    case 'turn.completed': {
      const usage = asRecord(event['usage']);
      if (!usage) return [];
      const cachedInputTokens = num(usage['cached_input_tokens']);
      // D-032: codex 의 input_tokens 는 캐시 입력을 이미 포함한다 (codex 세션 로그: total = input + output).
      // claude/cursor 는 반대로 입력이 캐시를 빼고 온다 — 여기서만 빼서 이후 Usage 네 칸이 벤더와 무관하게 겹치지 않게 한다.
      const inputTokens = Math.max(0, num(usage['input_tokens']) - cachedInputTokens);
      return [
        {
          kind: 'usage',
          usage: {
            inputTokens,
            outputTokens: num(usage['output_tokens']),
            cachedInputTokens,
            cacheWriteTokens: num(usage['cache_write_input_tokens']),
          },
        },
      ];
    }
    case 'turn.failed':
      return [{ kind: 'notice', level: 'error', message: JSON.stringify(event['error'] ?? event) }];
    default:
      return [];
  }
}

/** 한 줄 → 0개 이상의 정규화 이벤트. 이 함수는 **절대 던지지 않는다.** */
export function parseLine(format: StreamFormat, line: string): RunEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return [{ kind: 'unparsed', line: trimmed, reason: error instanceof Error ? error.message : String(error) }];
  }

  // 바깥 try 와 분리된 중첩 try: 스키마가 바뀌어 접근이 터져도 그 줄만 잃는다.
  try {
    const event = asRecord(parsed);
    if (!event) return [{ kind: 'unparsed', line: trimmed, reason: 'JSON 최상위가 객체가 아니다' }];
    return format === 'codex' ? codexEvents(event) : claudeEvents(event);
  } catch (error) {
    return [{ kind: 'unparsed', line: trimmed, reason: error instanceof Error ? error.message : String(error) }];
  }
}

/** 줄 경계가 청크를 가로지를 수 있으므로 꼬리를 물고 간다. */
export function createLineSplitter(): (chunk: string) => string[] {
  let buffer = '';
  return (chunk: string): string[] => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    return lines;
  };
}
