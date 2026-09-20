/**
 * 결정 로그 (SPEC §8, `/delegation-router` §7 스키마).
 *
 * **두 번 쓴다.** 배정 확정 시 1차(`status:"decided"`, `outcome:"pending"`),
 * 검증 후 **같은 `id` 로** 2차. 갱신이 아니라 append 다 — 쿼리는 `id` 별 마지막 줄을 본다.
 * 결과 없는 1차 줄은 "검증을 안 했다"는 증거이고, 아예 없는 줄은 아무 증거도 아니다.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export type Branch = 'down' | 'keep' | 'up_part' | 'up_session';
export type Status = 'decided' | 'ran' | 'declined' | 'blocked' | 'no_reply';
export type Outcome = 'ok' | 'rework' | 'wrong' | 'unverified' | 'pending';

export interface DecisionRecord {
  readonly ts: string;
  readonly host: string;
  readonly task: string;
  readonly id: string;
  readonly mechanism: 'subagent';
  readonly branch: Branch;
  readonly session_model: string;
  readonly tier: string;
  readonly downshifted: boolean;
  readonly trigger: string;
  readonly parallel_n: number;
  readonly status: Status;
  readonly outcome: Outcome;
  readonly verified?: string;
  readonly sample?: string;
  readonly note?: string;
}

/**
 * 기본 경로는 라우터와 같다 (SPEC §8). **머신 로컬**이어야 한다 —
 * iCloud 같은 동기화 폴더에 두면 두 머신이 동시에 append 할 때 줄이 깨진다.
 */
export function decisionLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['HS_ORC_DECISION_LOG'] ?? path.join(os.homedir(), '.claude', 'logs', 'delegation-router.jsonl');
}

/**
 * `MMDD-HHMM-xxx`. 1차·2차 줄을 잇는 **유일한** 키다.
 *
 * 라우터 스키마는 `MMDD-HHMM` 으로 "충분하다"고 했지만 그건 사람이 손으로 쓸 때다.
 * 제품은 같은 분에 여러 작업을 돌릴 수 있고, 그러면 두 작업의 4줄이 한 `id` 로 섞여
 * **"id 당 2줄" 불변식이 깨진다**(실측 확인). 접두는 그대로 두고 접미사만 붙인다.
 */
export function newDecisionId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-${randomBytes(2).toString('hex').slice(0, 3)}`;
}

export function appendDecision(record: DecisionRecord, file = decisionLogPath()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

export function readDecisions(file = decisionLogPath()): DecisionRecord[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return []; // 로그가 아직 없는 것은 정상 상태다 — 에러로 올리지 않는다.
  }
  const rows: DecisionRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // 중첩 try — 남의 줄이 깨져 있어도 내 줄을 잃지 않는다.
    try {
      rows.push(JSON.parse(line) as DecisionRecord);
    } catch {
      continue;
    }
  }
  return rows;
}

export const linesFor = (id: string, file = decisionLogPath()): DecisionRecord[] =>
  readDecisions(file).filter((r) => r.id === id);
