/**
 * 에러 리포팅 (PLAN S6-3·S6-4, hs-00-core 금지 항목).
 *
 * 두 가지를 강제한다:
 *  1. **태그와 모듈 출처**를 붙인다.
 *  2. **정상 비즈니스 상태를 에러로 올리지 않는다.** 분류 실패·하한선 적중·결과 없음은
 *     제품이 의도한 경로다. 이것들을 `logE` 로 올리면 진짜 장애가 묻힌다.
 *
 * 그리고 `catch` 후 무동작을 막는다 — 실패에는 **사용자에게 보이는 상태**가 있어야 하므로
 * `reportError` 는 화면·CLI 가 그대로 쓸 수 있는 문자열을 **반환한다.**
 */
export type Severity = 'error' | 'notice';

/** 이 상태들은 정상 경로다. 에러 채널로 올리지 않는다. */
export const BUSINESS_STATES = ['unclassified', 'gate-direct', 'no-results', 'budget-exceeded', 'max-iterations'] as const;
export type BusinessState = (typeof BUSINESS_STATES)[number];

export const isBusinessState = (value: string): value is BusinessState =>
  (BUSINESS_STATES as readonly string[]).includes(value);

export interface Report {
  readonly severity: Severity;
  readonly module: string;
  readonly tag: string;
  readonly message: string;
  /** 사용자에게 그대로 보여줄 한 줄. */
  readonly display: string;
}

export function report(severity: Severity, module: string, tag: string, error: unknown): Report {
  const message = error instanceof Error ? error.message : String(error);
  return {
    severity,
    module,
    tag,
    message,
    display: `[${severity}][${module}/${tag}] ${message}`,
  };
}

/**
 * 정상 비즈니스 상태면 `notice` 로 강등한다. 호출자가 실수로 에러로 올려도 여기서 막힌다.
 * 반환값을 버리면 `catch` 후 무동작이 된다 — 호출자는 반드시 `display` 를 어딘가 보여준다.
 */
export function reportError(module: string, tag: string, error: unknown): Report {
  return report(isBusinessState(tag) ? 'notice' : 'error', module, tag, error);
}

export const reportNotice = (module: string, tag: string, message: string): Report =>
  report('notice', module, tag, message);
