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
import { legacyStateDir, projectStateDir } from './project-state.ts';
import type { Budget, Spend } from './budget.ts';
import type { ContextCut } from './context.ts';
import type { SettledOutcome } from './evidence.ts';
import type { EngineReport } from './executor.ts';
import type { ApprovalMode, OrchestratorChoice } from '../data/limits.ts';
import type { AskReason } from './approval.ts';
import type { LadderApplied } from './ladder.ts';
import type { CacheWrite, EngineCompaction } from '../adapters/types.ts';

/** `plan` 기록에 남는 사다리 적용 (D-068) — 적용 내용에 더해 어느 결정에서 올랐고 원래 행 근거가 무엇이었나. */
export interface LadderRecord extends LadderApplied {
  /** 상향 근거가 된 직전 결과의 결정 id. */
  readonly from: string;
  /** 사다리 이전 배정의 근거(`plan.reason`). 사다리 배정의 reason 은 `사다리 ②… · <이것>` 이다. */
  readonly origin: string;
}

export type SessionKind = 'project' | 'scratch';
/** AO 어휘 (D-031). `blocked` 는 위임 승인 대기다 — 그 상태에서는 아무것도 자동으로 진행하지 않는다. */
export type SessionState = 'waiting_input' | 'working' | 'blocked';

/** 이어 붙일 수 있는 엔진 세션 (SPEC §3.8). resume 은 엔진·모델·effort 가 모두 같을 때만 한다. */
export interface EngineSessionRef {
  readonly engine: string;
  readonly modelId: string;
  readonly effort: string;
  readonly id: string;
  /** 그 실행의 원본 보고 (D-057) — 다음 resume 이 누적 칸에서 뺄 기준이다. 없으면 원본 그대로 센다. */
  readonly reported?: EngineReport;
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
      /** 다음 행동 안내 (D-074) — git 아닌 폴더의 쓰기 위임. 분류 사실(`notes`)과 따로 둔다. 옛 기록에는 없다. */
      readonly guide?: readonly string[];
      /** Jev 가 GENERAL(행에 안 맞는 작업)로 판정한 턴 (D-082) — 셸이 행 선택 앞에 그 사실을 말한다. 옛 기록에는 없다. */
      readonly general?: true;
      /**
       * 지휘자가 아니라 읽기 전용 엔진 1슬롯이 코드를 읽고 낸 답이다 (D-083 질문형 경로). `slot` 은 `plan.primary` 와 같은 모양,
       * `by` 는 누가 시작했나 — `auto` 는 Jev GENERAL 에서 클릭 없이, `user` 는 "코드를 읽고 답하기"·`/read`. reviewer 판정은 없다. 옛 기록에는 없다.
       */
      readonly read?: { readonly slot: string; readonly by: 'auto' | 'user' };
      /** 맥락을 잘랐으면 버린 양. 안 잘랐으면 없다 (D-053). */
      readonly cut?: ContextCut;
      /** 이 답 실행의 캐시 쓰기 TTL 내역 (D-062). 관측 전용 — 엔진이 안 줬으면 없다. 직접 답은 원시 로그가 없어 여기에 남긴다. */
      readonly cacheWrite?: CacheWrite;
      /** 답한 지휘자 슬롯 한 줄 (D-087) — 지휘자 모델을 세션마다 고르므로 기록이 말한다. 옛 기록·읽기 답에는 없다(옛 지휘자는 Haiku·low). */
      readonly by?: string;
    }
  | {
      readonly kind: 'plan';
      readonly taskId: string;
      readonly title: string;
      readonly reason: string;
      readonly primary: string;
      readonly reviewer: string;
      /** 사다리 ④ 가 더한 reviewer (D-072). 옛 기록·두 슬롯 배정에는 없다. */
      readonly reviewer2?: string;
      readonly estimateUsd: number;
      readonly notes: readonly string[];
      /** 다음 행동 안내 (D-074) — git 아닌 폴더의 쓰기 위임. 분류 사실(`notes`)과 따로 둔다. 옛 기록에는 없다. */
      readonly guide?: readonly string[];
      /** 이 배정이 설 때의 승인 방식 (D-064). 이 결정 전 기록에는 없다. */
      readonly mode?: ApprovalMode;
      /** 승인 클릭을 기다리는 이유(`manual` 이 아니면). 비어 있으면 자동 승인이 뒤따른다. 카드가 이름으로 보인다. */
      readonly asked?: readonly AskReason[];
      /** 사용자가 쓰기 위임으로 보냈다 — 카드의 쓰기 스위치가 켜진 채 선다. */
      readonly write?: boolean;
      /** 사용자가 눌러 상향한 배정이다 (D-068). 사다리 상태는 이 필드와 뒤따르는 결과에서 계산한다 — 옛 기록은 없다. */
      readonly ladder?: LadderRecord;
      /** 승인한 같은 배정이 예외(throw)로 끝나 같은 계획으로 다시 세운 카드다 (D-081). 옛 기록에는 없다. */
      readonly retry?: true;
    }
  | {
      readonly kind: 'approval';
      readonly approved: boolean;
      readonly write: boolean;
      /** 누가 승인했나 (D-064 결정 7). 이 결정 전 기록·거절에는 없다. */
      readonly by?: 'user' | 'auto';
      readonly mode?: ApprovalMode;
      /** 그 배정에서 걸린 조건 코드(`H1`…`H6`·`A1`…`A4`). 자동 승인은 비어 있다. */
      readonly asked?: readonly string[];
    }
  /** 승인 방식 변경 (D-064 결정 8). 세션을 열면 마지막 것을 재생한다 — 화면에 한 줄로 보인다(감사용). */
  | { readonly kind: 'mode'; readonly mode: ApprovalMode }
  /** 지휘자 모델·effort 변경 (D-087). 세션을 열면 마지막 것을 재생한다 — 없으면 옛 세션이라 옛 지휘자(Haiku·low)다. */
  | ({ readonly kind: 'orchestrator' } & OrchestratorChoice)
  /**
   * 지휘자가 낸 단계 계획 (D-087). 단계마다 배정은 매트릭스가 했다 — `primary`·`reviewer` 는 `plan` 기록과 같은 모양이다.
   * 승인하면 단계마다 위임이 돌고 `result` 가 `step` 을 달고 붙는다. 자동 승인하지 않는다(모델이 고른 행 — H1).
   */
  | {
      readonly kind: 'steps';
      /** 나눈 요청 — 사용자가 쓴 그대로. */
      readonly title: string;
      readonly steps: readonly {
        readonly id: string;
        readonly taskId: string;
        readonly task: string;
        readonly prompt: string;
        readonly dependsOn: readonly string[];
        readonly primary: string;
        readonly reviewer: string;
        readonly estimateUsd: number;
      }[];
      readonly estimateUsd: number;
      /** 계획한 지휘자 슬롯 한 줄과 그 실행 비용. */
      readonly by: string;
      readonly cost: string;
      readonly cut?: ContextCut;
    }
  | {
      readonly kind: 'result';
      /** `cancelled` — 사용자가 실행 중에 멈췄다 (D-066). 실패가 아니라 끊김도 아니다 — 잇지 않는다. */
      readonly outcome: SettledOutcome | 'cancelled';
      readonly verdict: 'pass' | 'fail' | 'unknown';
      readonly text: string;
      readonly review: string;
      readonly evidence: string;
      readonly decisionId: string;
      readonly engineSession?: EngineSessionRef;
      /** primary 실행 중 엔진이 맥락을 압축했다 (D-058). resume 체인에서 앞 맥락이 요약으로 바뀌었다는 뜻이다. */
      readonly compacted?: readonly EngineCompaction[];
      /** 위임 프롬프트의 맥락을 잘랐으면 버린 양 (D-053). */
      readonly cut?: ContextCut;
      /** 단계 계획(D-087)의 어느 단계인가. 단계 결과는 엔진 세션을 남기지 않는다 — 다음 위임이 단계 하나에 잇지 않는다. */
      readonly step?: string;
    }
  | { readonly kind: 'summary'; readonly text: string; readonly next: string; /** 요약한 지휘자 슬롯 한 줄 (D-087). 옛 기록에는 없다. */ readonly by?: string }
  | { readonly kind: 'error'; readonly text: string }
  /**
   * 유료 호출로 쌓인 과금·토큰 (D-054). 앱을 다시 켜고 세션을 열면 이것을 재생해 세션 Budget 을
   * 되살린다. 화면에는 보이지 않는다.
   */
  | ({ readonly kind: 'spend' } & Spend);

export type TranscriptRecord = TranscriptEntry & { readonly v: 1; readonly at: string; readonly turn: number };

export function scratchRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env['HS_ORC_SCRATCH'] ?? path.join(os.homedir(), '.hs-orc', 'scratch');
}

/** 쓰는 자리 — 세션 폴더가 아니라 홈의 프로젝트 상태 아래다 (D-071). 스크래치도 같은 규칙이다. */
export const transcriptPath = (dir: string, id: string, env: NodeJS.ProcessEnv = process.env): string =>
  path.join(projectStateDir(dir, env), 'sessions', `${id}.jsonl`);

/** D-071 이전 자리(`<세션 폴더>/.hs-orc/sessions/`). **읽기만 한다** — 옮기지도 지우지도, 덧쓰지도 않는다. */
export const legacyTranscriptPath = (dir: string, id: string): string =>
  path.join(legacyStateDir(dir), 'sessions', `${id}.jsonl`);

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

/** 기록의 `spend` 를 Budget 에 재생한다 (D-054). */
export function replaySpend(budget: Budget, records: readonly TranscriptRecord[]): void {
  for (const r of records) if (r.kind === 'spend') budget.absorb(r);
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
  } catch (error) {
    // 아직 없는 기록만 정상 상태다(경로 중간이 파일이어도 기록은 있을 수 없다). 다른 읽기 오류를
    // 빈 대화로 삼키면 다시 연 세션이 턴 1 부터 덧쓴다.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { records: [], broken: 0 };
    throw error;
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

/**
 * 세션 하나의 기록 전체 — 옛 자리 다음에 새 자리를 잇는다 (D-071). 옛 세션을 이어 쓰면 새 줄은 홈에 쌓이므로,
 * 둘을 이어 읽어야 턴 번호·Budget 재생(D-054)이 끊기지 않는다. 옛 자리가 먼저인 것은 시간 순서 그대로다.
 */
export function readSessionLog(dir: string, id: string): LoadedTranscript {
  const legacy = readTranscript(legacyTranscriptPath(dir, id));
  const current = readTranscript(transcriptPath(dir, id));
  return { records: [...legacy.records, ...current.records], broken: legacy.broken + current.broken };
}

export interface SessionSummary {
  readonly id: string;
  readonly dir: string;
  readonly kind: SessionKind;
  readonly lastAt: string;
  readonly preview: string;
  /** 쓴 것이 있으면 그 합. 유료 호출이 없던 세션에는 없다. */
  readonly usage?: SessionUsage;
}

/**
 * 사이드바 한 줄용 세션 사용량 — 기록의 `spend` 줄 합이다 (D-054 재료 그대로, 기록 형식은 바꾸지 않는다). **표시 전용**이다.
 * 미보고 횟수 같은 정확한 내역은 세션을 열면 머리의 Budget 요약이 보인다.
 */
export interface SessionUsage {
  readonly tokens: number;
  /** `tokens` 중 캐시 읽기로 알려진 몫. */
  readonly cacheReadTokens: number;
  /** 캐시 읽기 내역을 모르는 보고가 섞였다 — D-070 이전 `spend` 이거나 칸을 안 준 엔진. `cacheReadTokens` 는 하한이다. */
  readonly cacheReadPartial?: true;
  /** 청구되는 금액 (plan `api`). */
  readonly billedUsd: number;
  /** 구독제 슬롯의 API 환산액 — 청구되지 않는다 (D-030). */
  readonly convertedUsd: number;
}

function sessionUsage(records: readonly TranscriptRecord[]): SessionUsage | undefined {
  let tokens = 0;
  let cacheRead = 0;
  let partial = false;
  let billed = 0;
  let converted = 0;
  let spent = false;
  for (const r of records) {
    if (r.kind !== 'spend') continue;
    spent = true;
    tokens += r.tokens;
    if ((r.tokens > 0 && r.cacheReadTokens === undefined) || (r.cacheReadUnreported ?? 0) > 0) partial = true;
    cacheRead += r.cacheReadTokens ?? 0;
    for (const c of r.charges) if (c.plan === 'api') billed += c.usd; else converted += c.usd;
  }
  if (!spent) return undefined;
  return {
    tokens,
    cacheReadTokens: cacheRead,
    ...(partial ? { cacheReadPartial: true as const } : {}),
    billedUsd: Number(billed.toFixed(6)),
    convertedUsd: Number(converted.toFixed(6)),
  };
}

function sessionIds(folder: string): string[] {
  try {
    return readdirSync(folder)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => n.slice(0, -'.jsonl'.length));
  } catch {
    return []; // 세션을 한 번도 안 연 폴더다 — 정상이다.
  }
}

/** 새 자리와 옛 자리(D-071 이전)를 합쳐 본다. 같은 id 는 한 세션이다. */
export function listSessions(dir: string, kind: SessionKind): SessionSummary[] {
  const ids = new Set([
    ...sessionIds(path.dirname(transcriptPath(dir, 'x'))),
    ...sessionIds(path.dirname(legacyTranscriptPath(dir, 'x'))),
  ]);
  return [...ids]
    .map((id): SessionSummary => {
      let records: TranscriptRecord[];
      try {
        ({ records } = readSessionLog(dir, id));
      } catch {
        // 한 세션을 못 읽어도 목록은 보여준다. 열면 그때 오류가 드러난다.
        return { id, dir, kind, lastAt: '', preview: '(읽지 못한 기록)' };
      }
      const first = records.find((r) => r.kind === 'user');
      const usage = sessionUsage(records);
      return {
        id,
        dir,
        kind,
        lastAt: records.at(-1)?.at ?? '',
        preview: first?.kind === 'user' ? first.text.slice(0, 60) : '',
        ...(usage ? { usage } : {}),
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
