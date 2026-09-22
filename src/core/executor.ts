/**
 * 슬롯 실행기 — 세 진행 방식이 공유하는 단 하나의 실행 통로 (PLAN S4 공통 인프라).
 *
 * 주입 가능한 함수 타입으로 둔다. 상한·중단 로직의 테스트가 **실제 엔진을 띄우지 않아야**
 * 하기 때문이다(상한 테스트가 돈을 쓰면 아무도 안 돌린다).
 */
import type { Matrix } from '../data/matrix.ts';
import type { Engines } from '../data/engines.ts';
import { createAdapter } from '../adapters/engine.ts';
import { meteredUsd, type TokenCounts } from '../data/pricing.ts';
import type { ResolvedSlot } from './assign.ts';

export interface SlotRun {
  readonly ok: boolean;
  readonly text: string;
  /**
   * 어댑터가 보존한 **원본** 출력 (SPEC §3.7). `text` 는 파싱 결과고 이것은 그 전이다.
   *
   * **선택 필드가 아니다.** 예전에는 이 자리가 아예 없어서 셸이 `text` 를 "원시 로그"라는
   * 이름으로 디스크에 썼고, codex·cursor 의 토큰 보고(`turn.completed`)가 통째로 사라졌다
   * (2026-09-22 첫 실사용에서 드러났다). 타입이 강제해야 같은 실수가 다시 안 생긴다.
   */
  readonly rawStdout: string;
  readonly rawStderr: string;
  /** 엔진이 실제 비용을 돌려줬으면 그 값. 없으면 undefined 이고 호출자가 아래 순서로 대체한다. */
  readonly actualUsd?: number;
  /** 측정 토큰 × 선언 단가 (D-027). `data/pricing.json` 에 그 모델이 없으면 undefined 다. */
  readonly meteredUsd?: number;
  /**
   * 엔진이 보고한 토큰 (D-030). **구독제에서 실제로 희소한 자원이 이것이다** — 돈이 아니다.
   * 엔진이 보고하지 않으면 undefined 다. 0 으로 채우면 "공짜로 돌았다" 가 되어 상한이 거짓이 된다.
   */
  readonly usage?: TokenCounts;
  readonly durationMs: number;
}

export type SlotExecutor = (slot: ResolvedSlot, prompt: string) => Promise<SlotRun>;

/** 매트릭스 비용표 기준 추정치 (SPEC §2.3). 실측이 없을 때만 쓴다. */
export function estimateUsd(matrix: Matrix, slot: ResolvedSlot): number {
  return matrix.economics.find((e) => e.model === slot.model)?.taskCostUsd ?? 0;
}

export interface ExecutorOptions {
  /**
   * primary 슬롯에 파일 쓰기를 허용한다 (D-025). 기본은 꺼짐 — 외부 쓰기는 사람에게 올린다(PLAN).
   * **reviewer 는 이 값이 true 여도 읽기 전용이다.** 판정 대상을 스스로 고칠 수 있으면
   * 독립 검증(INV-1·D-003)이 성립하지 않는다. 그 강제가 아래 한 줄이고, 여기가 유일한 부여 지점이다.
   */
  readonly write?: boolean;
}

export function createExecutor(
  catalog: Engines,
  cwd: string,
  timeoutMs: number,
  options: ExecutorOptions = {},
): SlotExecutor {
  return async (slot, prompt) => {
    const write = options.write === true && slot.role === 'primary';
    const handle = createAdapter(slot.engine, catalog).start({
      model: slot.model,
      effort: slot.effort,
      prompt,
      cwd,
      timeoutMs,
      ...(write ? { write: true } : {}),
    });
    const result = await handle.result;
    // 엔진이 비용을 안 주면 토큰으로 계산해 본다 — 단가 선언이 없으면 undefined 로 남는다.
    const metered = result.costUsd === undefined ? meteredUsd(slot.modelId, result.usage) : undefined;
    return {
      ok: result.outcome === 'ok',
      text: result.text,
      rawStdout: result.rawStdout,
      rawStderr: result.rawStderr,
      ...(result.costUsd !== undefined ? { actualUsd: result.costUsd } : {}),
      ...(metered !== undefined ? { meteredUsd: metered } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
      durationMs: result.durationMs,
    };
  };
}
