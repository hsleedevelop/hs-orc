/**
 * 슬롯 실행기 — 세 진행 방식이 공유하는 단 하나의 실행 통로 (PLAN S4 공통 인프라).
 *
 * 주입 가능한 함수 타입으로 둔다. 상한·중단 로직의 테스트가 **실제 엔진을 띄우지 않아야**
 * 하기 때문이다(상한 테스트가 돈을 쓰면 아무도 안 돌린다).
 */
import type { Matrix } from '../data/matrix.ts';
import type { Engines } from '../data/engines.ts';
import { createAdapter } from '../adapters/engine.ts';
import type { ResolvedSlot } from './assign.ts';

export interface SlotRun {
  readonly ok: boolean;
  readonly text: string;
  /** 엔진이 실제 비용을 돌려줬으면 그 값. 없으면 undefined 이고 호출자가 추정치로 대체한다. */
  readonly actualUsd?: number;
  readonly durationMs: number;
}

export type SlotExecutor = (slot: ResolvedSlot, prompt: string) => Promise<SlotRun>;

/** 매트릭스 비용표 기준 추정치 (SPEC §2.3). 실측이 없을 때만 쓴다. */
export function estimateUsd(matrix: Matrix, slot: ResolvedSlot): number {
  return matrix.economics.find((e) => e.model === slot.model)?.taskCostUsd ?? 0;
}

export function createExecutor(catalog: Engines, cwd: string, timeoutMs: number): SlotExecutor {
  return async (slot, prompt) => {
    const handle = createAdapter(slot.engine, catalog).start({
      model: slot.model,
      effort: slot.effort,
      prompt,
      cwd,
      timeoutMs,
    });
    const result = await handle.result;
    return {
      ok: result.outcome === 'ok',
      text: result.text,
      ...(result.costUsd !== undefined ? { actualUsd: result.costUsd } : {}),
      durationMs: result.durationMs,
    };
  };
}
