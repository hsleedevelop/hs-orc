/**
 * Gatekeeper — `/delegation-router` §1 하한선 (SPEC §4.1).
 *
 * **순서가 핵심이다.** 매트릭스를 먼저 적용해 Fable을 띄워놓고 하한선을 확인하는 구현은 틀렸다.
 * 하나라도 걸리면 배정하지 않고 종료한다 — 엔진을 띄우지 않는다.
 *
 * 신호는 **추측하지 않고 호출자가 선언한다.** 작업 문자열만 보고 "되돌리기 어려운 변경"을
 * 자동 판정하면 조용히 틀리고, 그 실패는 정확히 이 게이트가 막으려던 것이다.
 */

export const GATE_CHECKS = [
  'toolCallsAtMostTwo',
  'oneLineScript',
  'contextAlreadyPresent',
  'mustRereadEverything',
  'needsUserMidway',
  'irreversibleChange',
] as const;

export type GateCheck = (typeof GATE_CHECKS)[number];

export const GATE_REASONS: Readonly<Record<GateCheck, string>> = {
  toolCallsAtMostTwo: '도구 호출 1~2번이면 끝난다',
  oneLineScript: '스크립트 한 줄로 된다 (항목 수는 작업량이 아니다)',
  contextAlreadyPresent: '필요한 것이 이미 컨텍스트에 있다',
  mustRereadEverything: '결과를 어차피 전부 다시 읽어야 한다 (검증 비용 ≥ 작업 비용)',
  needsUserMidway: '진행 중 사용자에게 물어야 한다',
  irreversibleChange: '되돌리기 어려운 변경이다 (난이도와 무관)',
};

export type GateSignals = Partial<Record<GateCheck, boolean>>;

export type GateVerdict =
  | { readonly kind: 'direct'; readonly tripped: readonly GateCheck[]; readonly reasons: readonly string[] }
  | { readonly kind: 'delegate' };

export function evaluateGate(signals: GateSignals): GateVerdict {
  const tripped = GATE_CHECKS.filter((check) => signals[check] === true);
  if (tripped.length === 0) return { kind: 'delegate' };
  return { kind: 'direct', tripped, reasons: tripped.map((c) => GATE_REASONS[c]) };
}

export function parseGateCheck(value: string): GateCheck {
  const found = GATE_CHECKS.find((c) => c === value);
  if (!found) throw new Error(`그런 하한선 항목이 없다: ${value}\n  가능: ${GATE_CHECKS.join(' | ')}`);
  return found;
}
