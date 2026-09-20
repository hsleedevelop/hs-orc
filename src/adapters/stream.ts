/**
 * 엔진 스트림 파싱 (SPEC §3.5).
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
  if (event['type'] !== 'result') return [];

  const out: RunEvent[] = [];
  const usage = asRecord(event['usage']);
  if (usage) {
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

function codexEvents(event: Record<string, unknown>): RunEvent[] {
  switch (event['type']) {
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
      return [
        {
          kind: 'usage',
          usage: {
            inputTokens: num(usage['input_tokens']),
            outputTokens: num(usage['output_tokens']),
            cachedInputTokens: num(usage['cached_input_tokens']),
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
