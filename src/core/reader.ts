/**
 * 질문형 경로 (D-083) — 코드·문서를 읽어야 답할 수 있는 질문에 **읽기 전용 엔진 1슬롯**이 직접 답한다.
 *
 * 위임이 아니다: 배정·reviewer·증거·사다리·결정 로그가 없고 결과는 `direct` 기록(`read`)으로 남는다.
 * INV-1(두 슬롯 교차 벤더)의 명시적 예외다 — 고치는 것이 없어 독립 검증할 산출물이 없고, 답의 검증은 사람이 읽는 것이다.
 * 지휘자와 다르다: 지휘자는 격리·도구 없음(D-080)이라 파일을 못 읽고, 이 슬롯은 위임 실행기 그대로 세션 폴더를 읽는다.
 */
import type { Engines } from '../data/engines.ts';
import { resolveSlot, type ResolvedSlot } from './assign.ts';

/**
 * Luna·medium (R01 primary 와 같은 모델) — 가장 싼 쌍의 primary 이고 2026-10-05 실측(run `1005-1534-721`)에서 이 저장소를 읽고 설명을 냈다.
 * role 을 `reviewer` 로 둔다 — `createExecutor` 가 **쓰기를 절대 주지 않는 자리**다(지휘자와 같은 이유). 읽기 전용은 엔진 인자로 붙는다
 * (`readOnlyArgv`, codex `sandbox_mode="read-only"` — D-051).
 */
export function readerSlot(catalog: Engines): ResolvedSlot {
  return resolveSlot(catalog, { model: 'luna', vendor: 'openai', efforts: ['medium'], label: '읽기·Luna' }, 'medium', 'reviewer');
}

/** 카드·기록에 찍는 슬롯 한 줄 — `plan.primary` 와 같은 모양이다. */
export const slotLine = (slot: ResolvedSlot): string => `${slot.label}·${slot.effort} → ${slot.engine}/${slot.modelId}${slot.longContext ? '[1m]' : ''}`;

/** 운영 기준은 Jev `GENERAL` 문구의 뒷절 그대로다 (D-082) — 읽은 근거를 경로:줄로 인용하고 추측과 구분한다. */
export function buildReadPrompt(context: string, message: string): string {
  return [
    '너는 hs-orc 가 띄운 읽기 전용 답변자다. 이 폴더의 코드·문서를 읽고 사용자의 질문에 답한다.',
    '규칙:',
    '- 파일을 만들거나 고치지 않는다. 이 실행은 읽기 전용이다.',
    '- 읽은 근거를 경로:줄로 인용하고, 확인한 것과 추측을 구분한다.',
    '- 답은 이 한 번으로 끝난다. 작업을 진행 중이라거나 곧 진행한다고 말하지 않는다 — 고치는 작업은 사람이 위임을 승인해야 시작된다.',
    ...(context ? ['', '[최근 대화]', context] : []),
    '',
    '[질문]',
    message,
  ].join('\n');
}
