/**
 * 미분류 누적과 행 추가 **제안** (D-022, PLAN S3-5).
 *
 * 제품은 매트릭스에 행을 더하지 않는다. `matrix.json` 은 생성물이고 원본 HTML 이 진실이라(D-013),
 * 로컬 오버레이를 두면 진실의 출처가 둘로 갈라지고 `matrix:check` 대조가 무의미해진다.
 * **임계치를 넘으면 제안만 하고, 추가는 원본 편집 → `npm run gen:matrix` 로만 한다.**
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface UnclassifiedRow {
  readonly ts: string;
  readonly task: string;
}

export const DEFAULT_THRESHOLD = 3;

export function unclassifiedLogPath(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  return env['HS_ORC_UNCLASSIFIED_LOG'] ?? path.join(cwd, '.hs-orc', 'unclassified.jsonl');
}

export function recordUnclassified(task: string, file = unclassifiedLogPath(), now = new Date()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ ts: now.toISOString(), task: task.slice(0, 120) })}\n`, 'utf8');
}

export function readUnclassified(file = unclassifiedLogPath()): UnclassifiedRow[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return []; // 아직 없는 것은 정상 상태다.
  }
  const rows: UnclassifiedRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as UnclassifiedRow);
    } catch {
      continue;
    }
  }
  return rows;
}

/** 작업 문자열에서 뽑은 거친 키 — 같은 모양의 미분류를 묶는 용도일 뿐 분류가 아니다. */
export function shapeKey(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 4)
    .sort()
    .join(' ');
}

export interface Suggestion {
  readonly key: string;
  readonly count: number;
  readonly samples: readonly string[];
  readonly message: string;
}

/**
 * 임계치를 넘은 모양만 제안한다. **자동 반영되지 않는다** —
 * 매트릭스를 바꾸는 것은 운영 정책을 바꾸는 일이다.
 */
export function suggestRows(rows: readonly UnclassifiedRow[], threshold = DEFAULT_THRESHOLD): Suggestion[] {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const key = shapeKey(row.task);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), row.task]);
  }

  return [...groups.entries()]
    .filter(([, tasks]) => tasks.length >= threshold)
    .map(([key, tasks]) => ({
      key,
      count: tasks.length,
      samples: tasks.slice(0, 3),
      message:
        `미분류가 ${tasks.length}회 반복됐다: "${key}"\n` +
        `  예) ${tasks.slice(0, 2).join(' / ')}\n` +
        '  행이 필요하면 **원본 HTML 의 rows 배열**을 고치고 `npm run gen:matrix` 로 재생성한다 (D-022).',
    }))
    .sort((a, b) => b.count - a.count);
}
