/** 상한 (SPEC §9, D-017). 상한 없는 자율 방식은 만들지 않는다. */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** 대화 세션 승인 방식 (D-064). */
export type ApprovalMode = 'manual' | 'auto-ask' | 'auto';
export const APPROVAL_MODES: readonly ApprovalMode[] = ['manual', 'auto-ask', 'auto'];
export const isApprovalMode = (value: unknown): value is ApprovalMode => APPROVAL_MODES.includes(value as ApprovalMode);

export interface Limits {
  /** 새 대화 세션의 승인 방식 (D-064 결정 8). 기록에 방식이 없는 옛 세션은 이 값이 아니라 `manual` 이다. */
  readonly approvalMode: ApprovalMode;
  readonly budgetUsd: number;
  /** 구독제에서 금액 대신 막는 것 (D-030). 돈이 아니라 사용량 한도가 희소 자원이다. */
  readonly tokenBudget: number;
  readonly maxIterations: number;
  readonly maxNodes: number;
  readonly runTimeoutMs: number;
  /** 대화 세션이 프롬프트에 싣는 최근 턴 수 (SPEC §6.4.3). */
  readonly contextTurns: number;
  /** 그 맥락의 글자 상한. 넘으면 앞을 자른다. */
  readonly contextChars: number;
  /** Jev 분류의 확신도 기준 (D-065). 미만이면 행을 확정하지 않는다. */
  readonly jevConfidenceMin: number;
  readonly jevTimeoutMs: number;
  /** Jev 로 외부 전송하는 맥락의 상한 — 대화 세션이 싣는 것보다 작다. */
  readonly jevContextTurns: number;
  readonly jevContextChars: number;
  /** 쓰기가 본질인 행 (D-086). git project 폴더에서 이 행의 배정은 쓰기 스위치가 켜진 채 선다. */
  readonly writeRows: readonly string[];
}

const LIMITS_PATH = path.resolve(import.meta.dirname, '..', '..', 'data', 'limits.json');

let cached: Limits | undefined;

/** 수기 파일이라 값을 믿지 않는다. 0·음수 상한은 막지 않고, `contextChars` 가 2 미만이면 맥락 자르기가 깨진다. */
export function checkLimits(limits: Limits): Limits {
  for (const key of ['budgetUsd', 'tokenBudget', 'maxIterations', 'maxNodes', 'runTimeoutMs', 'contextTurns', 'contextChars', 'jevConfidenceMin', 'jevTimeoutMs', 'jevContextTurns', 'jevContextChars'] as const) {
    const value = limits[key];
    if (!Number.isFinite(value) || value <= 0) throw new Error(`limits.json 의 ${key} 는 양수여야 한다: ${value}`);
  }
  if (!Number.isInteger(limits.contextTurns)) throw new Error(`limits.json 의 contextTurns 는 정수여야 한다: ${limits.contextTurns}`);
  if (!Number.isInteger(limits.contextChars) || limits.contextChars < 2) {
    throw new Error(`limits.json 의 contextChars 는 2 이상의 정수여야 한다: ${limits.contextChars}`);
  }
  if (!isApprovalMode(limits.approvalMode)) throw new Error(`limits.json 의 approvalMode 는 ${APPROVAL_MODES.join('·')} 중 하나여야 한다: ${String(limits.approvalMode)}`);
  if (limits.jevConfidenceMin > 1) throw new Error(`limits.json 의 jevConfidenceMin 은 1 이하여야 한다: ${limits.jevConfidenceMin}`);
  for (const key of ['jevContextTurns', 'jevContextChars'] as const) {
    if (!Number.isInteger(limits[key]) || limits[key] < 2) throw new Error(`limits.json 의 ${key} 는 2 이상의 정수여야 한다: ${limits[key]}`);
  }
  if (!Array.isArray(limits.writeRows) || !limits.writeRows.every((id) => typeof id === 'string' && /^R\d{2}$/.test(id))) {
    throw new Error(`limits.json 의 writeRows 는 행 id(R01 꼴) 배열이어야 한다: ${JSON.stringify(limits.writeRows)}`);
  }
  return limits;
}

export function loadLimits(): Limits {
  cached ??= checkLimits(JSON.parse(readFileSync(LIMITS_PATH, 'utf8')) as Limits);
  return cached;
}
