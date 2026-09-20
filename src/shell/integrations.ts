/**
 * 외부 CLI 조회 (SPEC §7 Sessions·Reviews).
 * 외부 경계는 불신한다 — 파싱 실패·미설치·원격 없음을 **값으로** 돌려주고 화면이 그대로 표시한다.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SessionRow {
  readonly source: 'claude' | 'codex';
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly cwd: string;
  /** 정식 CLI 출력인지, 비공식 내부 파일인지 (D-020). 화면이 이 값을 숨기지 않는다. */
  readonly provenance: 'cli' | 'internal-file';
}

export interface Probe<T> {
  readonly rows: readonly T[];
  /** 왜 비었는지. 빈 목록과 "조회 실패"를 구분한다. */
  readonly note: string;
}

const run = (bin: string, args: readonly string[], timeout = 20_000) =>
  spawnSync(bin, [...args], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });

/** `claude agents --json` — 실측 스키마: {pid,cwd,kind,startedAt,sessionId,name,status} */
export function claudeSessions(): Probe<SessionRow> {
  const r = run('claude', ['agents', '--json']);
  if (r.error || r.status !== 0) return { rows: [], note: `claude agents 조회 실패: ${r.stderr?.trim() || r.error?.message || `exit ${r.status}`}` };
  try {
    const parsed = JSON.parse(r.stdout) as { sessionId?: string; name?: string; status?: string; cwd?: string }[];
    return {
      rows: parsed.map((a) => ({
        source: 'claude' as const,
        id: a.sessionId ?? '?',
        name: a.name ?? '(이름 없음)',
        status: a.status ?? '?',
        cwd: a.cwd ?? '',
        provenance: 'cli' as const,
      })),
      note: '',
    };
  } catch (error) {
    return { rows: [], note: `claude agents 출력 파싱 실패: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * codex 쪽은 **비공식 폴백**이다 (D-020). `codex agents` 에는 `--json` 이 없다.
 * 내부 색인 `~/.codex/session_index.jsonl` 을 읽되 출처를 숨기지 않는다.
 */
export function codexSessions(limit = 10): Probe<SessionRow> {
  const file = path.join(os.homedir(), '.codex', 'session_index.jsonl');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { rows: [], note: `codex 세션 색인을 읽지 못했다: ${file}` };
  }

  const rows: SessionRow[] = [];
  for (const line of text.trim().split('\n').slice(-limit).reverse()) {
    // 중첩 try — 한 줄이 깨져도 나머지를 잃지 않는다.
    try {
      const o = JSON.parse(line) as { id?: string; thread_name?: string; updated_at?: string };
      rows.push({
        source: 'codex',
        id: o.id ?? '?',
        name: o.thread_name ?? '(이름 없음)',
        status: o.updated_at ?? '',
        cwd: '',
        provenance: 'internal-file',
      });
    } catch {
      continue;
    }
  }
  return { rows, note: 'codex 는 기계 판독 출력이 없어 내부 색인을 읽었다 (비공식, D-020)' };
}

export interface ReviewRow {
  readonly ref: string;
  readonly title: string;
  readonly state: string;
}

/**
 * gh-axi 의 목록 출력 파서. 실측 형태(2026-09-20):
 *
 *   pull_requests[3]{number,title,state,author,draft,review}:
 *     153761,"fix(update): allow …",open,steipete,no,none
 *
 * 헤더의 열 이름을 읽고 따옴표를 존중하며 쪼갠다 — 제목에 쉼표가 들어간다.
 */
export function parseAxiRows(stdout: string): Record<string, string>[] {
  const lines = stdout.split('\n');
  const headerIndex = lines.findIndex((l) => /^\w+\[\d+\]\{[^}]+\}:/.test(l));
  if (headerIndex === -1) return [];
  const columns = (/\{([^}]+)\}/.exec(lines[headerIndex] ?? '')?.[1] ?? '').split(',').map((c) => c.trim());

  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (!/^\s+\S/.test(line)) break; // 들여쓰기가 끊기면 목록 끝이다.
    const cells: string[] = [];
    let cell = '';
    let quoted = false;
    for (const ch of line.trim()) {
      if (ch === '"') { quoted = !quoted; continue; }
      if (ch === ',' && !quoted) { cells.push(cell); cell = ''; continue; }
      cell += ch;
    }
    cells.push(cell);
    rows.push(Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? ''])));
  }
  return rows;
}

/**
 * `gh-axi` 우선, `gh` 폴백 (SPEC §7).
 * **두 CLI 의 인터페이스가 다르다**(실측): gh-axi 는 `--fields` 에 number/title/state 를 받지 않고
 * 기본 출력에 이미 담아 준다. gh 는 `--json` 이다. 어느 쪽도 못 쓰면 이유를 note 로 돌려준다.
 */
export function reviews(limit = 20): Probe<ReviewRow> {
  const axi = run('gh-axi', ['pr', 'list', '--limit', String(limit)]);
  if (!axi.error && axi.status === 0) {
    const rows = parseAxiRows(axi.stdout);
    if (rows.length > 0) {
      return {
        rows: rows.map((r) => ({ ref: `#${r['number'] ?? '?'}`, title: r['title'] ?? '', state: r['state'] ?? '' })),
        note: '출처 gh-axi',
      };
    }
  }

  const gh = run('gh', ['pr', 'list', '--json', 'number,title,state', '--limit', String(limit)]);
  if (gh.error) {
    const why = (axi.stderr || axi.stdout || '').trim().split('\n')[0] ?? '';
    return { rows: [], note: `gh 를 찾지 못했다${why ? ` · gh-axi: ${why}` : ''}` };
  }
  if (gh.status !== 0) {
    return { rows: [], note: `gh pr list 실패: ${(gh.stderr || gh.stdout).trim().split('\n')[0] ?? ''}` };
  }
  try {
    const parsed = JSON.parse(gh.stdout) as { number?: number; title?: string; state?: string }[];
    return { rows: parsed.map((p) => ({ ref: `#${p.number ?? '?'}`, title: p.title ?? '', state: p.state ?? '' })), note: '출처 gh (gh-axi 폴백)' };
  } catch {
    return { rows: [], note: 'gh 출력 파싱 실패' };
  }
}
