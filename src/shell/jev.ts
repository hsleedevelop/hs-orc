/**
 * 셸이 Jev 분류기를 켜는 자리 (D-065). **합성 루트(CLI·TUI·GUI 메인·chat)만 부른다** —
 * Core·서비스 클래스는 기본이 "꺼짐"이라 테스트가 키가 있는 머신에서 외부로 나가지 않는다.
 * `HS_ORC_JEV=off` 면 만들지 않는다 (외부 전송이 아예 없다).
 */
import { createJevClient, jevEnabled, type RowClassifier } from '../adapters/jev.ts';
import { loadLimits } from '../data/limits.ts';

export function defaultJev(env: NodeJS.ProcessEnv = process.env): RowClassifier | undefined {
  return jevEnabled(env) ? createJevClient({ env, timeoutMs: loadLimits().jevTimeoutMs }) : undefined;
}
