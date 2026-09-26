/**
 * 슬롯 실행기 — 세 진행 방식이 공유하는 단 하나의 실행 통로 (PLAN S4 공통 인프라).
 *
 * 주입 가능한 함수 타입으로 둔다. 상한·중단 로직의 테스트가 **실제 엔진을 띄우지 않아야**
 * 하기 때문이다(상한 테스트가 돈을 쓰면 아무도 안 돌린다).
 */
import type { Matrix } from '../data/matrix.ts';
import type { Engines, ResumeCumulative } from '../data/engines.ts';
import { createAdapter } from '../adapters/engine.ts';
import type { EngineCompaction } from '../adapters/types.ts';
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
  /** 엔진 세션 id (SPEC §3.8). 못 읽었으면 없다. */
  readonly sessionId?: string;
  /**
   * 엔진이 보고한 **원본** 금액·토큰 (D-057). resume 했으면 세션 누적일 수 있어 `actualUsd`·`usage` 와 다르다.
   * 다음 resume 이 뺄 기준이라 엔진 세션과 함께 기록에 남긴다.
   */
  readonly reported?: EngineReport;
  /** 이 실행 중 엔진이 한 압축 (D-058). 없으면 필드가 없다. */
  readonly compactions?: readonly EngineCompaction[];
  /** `usage` 에 압축 몫이 빠졌을 수 있다 — 엔진 선언 (D-060, codex). `Budget.countTokens` 에 그대로 넘긴다. */
  readonly compactionUncounted?: boolean;
}

/** 엔진이 보고한 그대로의 금액·토큰. 보고가 없던 칸은 없다. */
export interface EngineReport {
  readonly costUsd?: number;
  readonly usage?: TokenCounts;
}

export interface SlotRunOptions {
  /** 이어 붙일 엔진 세션 id. **primary 에만** 온다 — reviewer 는 잇지 않는다 (SPEC §6.4.3). */
  readonly resume?: string;
  /** 이어 붙일 세션의 직전 원본 보고 (D-057). 누적 칸은 이것을 빼서 센다. */
  readonly baseline?: EngineReport;
}

/**
 * resume 한 실행의 보고를 **이번 실행 몫**으로 되돌린다 (D-057). `cumulative` 로 선언된 칸만 뺀다.
 * 빼서 음수가 나오는 칸이 있으면 그 칸은 누적이 아니었던 것이다 — 원본을 그대로 센다. 적게 세면 상한이
 * 거짓이 되고, 많이 세면 일찍 멈출 뿐이다.
 */
export function sinceBaseline(
  raw: EngineReport,
  baseline: EngineReport | undefined,
  cumulative: readonly ResumeCumulative[],
): EngineReport {
  let { costUsd, usage } = raw;
  if (cumulative.includes('cost') && costUsd !== undefined && baseline?.costUsd !== undefined && costUsd >= baseline.costUsd) {
    costUsd -= baseline.costUsd;
  }
  const base = baseline?.usage;
  if (cumulative.includes('usage') && usage !== undefined && base !== undefined) {
    const delta: TokenCounts = {
      inputTokens: usage.inputTokens - base.inputTokens,
      outputTokens: usage.outputTokens - base.outputTokens,
      cachedInputTokens: usage.cachedInputTokens - base.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteTokens - base.cacheWriteTokens,
    };
    if (Object.values(delta).every((n) => n >= 0)) usage = delta;
  }
  return { ...(costUsd !== undefined ? { costUsd } : {}), ...(usage !== undefined ? { usage } : {}) };
}

export type SlotExecutor = (slot: ResolvedSlot, prompt: string, options?: SlotRunOptions) => Promise<SlotRun>;

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
  /** 스크래치 세션 (SPEC §6.4.1). git 밖에서 돌려야 하는 엔진에 그 인자를 붙인다. */
  readonly nonGit?: boolean;
  /** 지휘자 전용 실행기에서만 켠다 (D-032 B1) — 사용자 전역 hook·설정·MCP·skills 를 싣지 않는다. */
  readonly isolate?: boolean;
}

export function createExecutor(
  catalog: Engines,
  cwd: string,
  timeoutMs: number,
  options: ExecutorOptions = {},
): SlotExecutor {
  return async (slot, prompt, runOptions) => {
    const write = options.write === true && slot.role === 'primary';
    const handle = createAdapter(slot.engine, catalog).start({
      model: slot.model,
      effort: slot.effort,
      prompt,
      cwd,
      timeoutMs,
      ...(write ? { write: true } : {}),
      ...(options.nonGit === true ? { nonGit: true } : {}),
      ...(options.isolate === true ? { isolate: true } : {}),
      ...(runOptions?.resume !== undefined ? { resume: runOptions.resume } : {}),
    });
    const result = await handle.result;
    const reported: EngineReport = {
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    };
    const { costUsd, usage } = runOptions?.resume !== undefined
      ? sinceBaseline(reported, runOptions.baseline, catalog.engines[slot.engine].resume?.cumulative ?? [])
      : reported;
    // 엔진이 비용을 안 주면 토큰으로 계산해 본다 — 단가 선언이 없으면 undefined 로 남는다.
    const metered = costUsd === undefined ? meteredUsd(slot.modelId, usage) : undefined;
    return {
      ok: result.outcome === 'ok',
      text: result.text,
      rawStdout: result.rawStdout,
      rawStderr: result.rawStderr,
      ...(costUsd !== undefined ? { actualUsd: costUsd } : {}),
      ...(metered !== undefined ? { meteredUsd: metered } : {}),
      ...(usage !== undefined ? { usage } : {}),
      durationMs: result.durationMs,
      ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
      reported,
      ...(result.compactions ? { compactions: result.compactions } : {}),
      ...(catalog.engines[slot.engine].compactionUncounted === true ? { compactionUncounted: true } : {}),
    };
  };
}
