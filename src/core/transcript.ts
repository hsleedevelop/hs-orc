/**
 * 대화 기록 (SPEC §6.4.1, D-031).
 *
 * **세션의 진실은 이 파일이다** — 엔진의 세션 파일이 아니다. 턴마다 벤더가 바뀌는 제품에서
 * 엔진 쪽 기록을 진실로 삼으면 교차 벤더 순간 대화가 끊긴다.
 * append-only JSONL. 결정 로그와 같은 규칙으로 읽는다: 깨진 줄은 건너뛰고 **센다**.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newDecisionId } from './decision-log.ts';

export type SessionKind = 'project' | 'scratch';
/** AO 어휘 (D-031). `blocked` 는 위임 승인 대기다 — 그 상태에서는 아무것도 자동으로 진행하지 않는다. */
export type SessionState = 'waiting_input' | 'working' | 'blocked';

/** 이어 붙일 수 있는 엔진 세션 (SPEC §3.8). resume 은 엔진·모델·effort 가 모두 같을 때만 한다. */
export interface EngineSessionRef {
  readonly engine: string;
  readonly modelId: string;
  readonly effort: string;
  readonly id: string;
}

export type TranscriptEntry =
  | { readonly kind: 'user'; readonly text: string }
  | {
      readonly kind: 'direct';
      readonly text: string;
      /** 지휘자가 제안한 행. 없으면 null — 행을 추측하지 않는다. */
      readonly suggest: string | null;
      /** 화면에 찍을 비용 한 줄. 말없이 도는 유료 호출은 없다 (D-026). */
      readonly cost: string;
      /** 분류 폴백이 돌았다는 사실 같은, 답보다 먼저 알려야 할 줄들. */
      readonly notes: readonly string[];
    }
  | {
      readonly kind: 'plan';
      readonly taskId: string;
      readonly title: string;
      readonly reason: string;
      readonly primary: string;
      readonly reviewer: string;
      readonly estimateUsd: number;
      readonly notes: readonly string[];
    }
  | { readonly kind: 'approval'; readonly approved: boolean; readonly write: boolean }
  | {
      readonly kind: 'result';
      readonly outcome: 'ok' | 'unverified' | 'wrong';
      readonly verdict: 'pass' | 'fail' | 'unknown';
      readonly text: string;
      readonly review: string;
      readonly evidence: string;
      readonly decisionId: string;
      readonly engineSession?: EngineSessionRef;
    }
  | { readonly kind: 'summary'; readonly text: string; readonly next: string }
  | { readonly kind: 'error'; readonly text: string };

export type TranscriptRecord = TranscriptEntry & { readonly v: 1; readonly at: string; readonly turn: number };

export function scratchRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env['HS_ORC_SCRATCH'] ?? path.join(os.homedir(), '.hs-orc', 'scratch');
}

export const transcriptPath = (dir: string, id: string): string =>
  path.join(dir, '.hs-orc', 'sessions', `${id}.jsonl`);

/** 세션 id 는 결정 로그와 같은 모양이다 — 두 기록을 사람이 눈으로 잇는다 (SPEC §6.4.1). */
export const newSessionId = (now = new Date()): string => newDecisionId(now);

/**
 * 세션 폴더를 정한다. scratch 는 **여기서 만든다** — 엔진이 cwd 를 요구한다.
 * project 는 만들지 않는다: 폴더 검증은 D-029 의 `validateProject` 가 이미 했다.
 */
export function prepareSession(
  kind: SessionKind,
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { dir: string; id: string } {
  const id = newSessionId();
  if (kind === 'project') return { dir: projectDir, id };
  const dir = path.join(scratchRoot(env), id);
  mkdirSync(dir, { recursive: true });
  return { dir, id };
}

export function appendRecord(file: string, record: TranscriptRecord): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

export interface LoadedTranscript {
  readonly records: TranscriptRecord[];
  /** 깨진 줄 수. 0 이 아니면 화면이 그 사실을 보여준다. */
  readonly broken: number;
}

export function readTranscript(file: string): LoadedTranscript {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { records: [], broken: 0 }; // 아직 없는 기록은 정상 상태다.
  }
  const records: TranscriptRecord[] = [];
  let broken = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as TranscriptRecord;
      if (parsed.v !== 1 || typeof parsed.turn !== 'number') {
        broken += 1;
        continue;
      }
      records.push(parsed);
    } catch {
      broken += 1;
    }
  }
  return { records, broken };
}

export interface SessionSummary {
  readonly id: string;
  readonly dir: string;
  readonly kind: SessionKind;
  readonly lastAt: string;
  readonly preview: string;
}

export function listSessions(dir: string, kind: SessionKind): SessionSummary[] {
  const folder = path.join(dir, '.hs-orc', 'sessions');
  let names: string[];
  try {
    names = readdirSync(folder).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return []; // 세션을 한 번도 안 연 폴더다 — 정상이다.
  }
  return names
    .map((name): SessionSummary => {
      const { records } = readTranscript(path.join(folder, name));
      const first = records.find((r) => r.kind === 'user');
      return {
        id: name.slice(0, -'.jsonl'.length),
        dir,
        kind,
        lastAt: records.at(-1)?.at ?? '',
        preview: first?.kind === 'user' ? first.text.slice(0, 60) : '',
      };
    })
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export function listScratchSessions(env: NodeJS.ProcessEnv = process.env): SessionSummary[] {
  const root = scratchRoot(env);
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  return dirs.flatMap((d) => listSessions(path.join(root, d), 'scratch'));
}
