/**
 * 엔진 카탈로그 접근 (SPEC §3.2·§9).
 * `data/engines.json` 은 수기 파일이지만 값은 전부 실측이다 — `$evidence` 참조.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Effort, ModelKey } from './matrix.ts';

export type EngineName = 'claude' | 'codex' | 'cursor';

export type EffortStyle =
  | { readonly kind: 'flag'; readonly flag: string }
  | { readonly kind: 'config'; readonly flag: string; readonly key: string }
  | { readonly kind: 'modelSuffix' };

/**
 * 이 엔진을 **무슨 요금제로 쓰는가** (D-030).
 *
 * 제품이 알아낼 수 없다 — 같은 CLI 를 구독제로도 API 키로도 쓴다. 그래서 선언이다.
 * `subscription` 이면 `total_cost_usd`(actual) 와 토큰×단가(metered) 가 **청구되지 않는다**:
 * API 로 썼다면 들었을 환산액이다. 누적 상한이 무엇을 막는지가 이 값에 달려 있다.
 */
export type BillingPlan = 'subscription' | 'api';

export interface EngineSpec {
  /** 앞에서부터 탐색한다. cursor 는 `cursor-cli` → `cursor-agent` 폴백 (D-005). */
  readonly binaries: readonly string[];
  /** **선택이 아니다.** 빠지면 금액 표시가 청구인지 환산인지 말할 수 없다. */
  readonly plan: BillingPlan;
  readonly promptArgv: readonly string[];
  readonly modelFlag: string;
  readonly effort: EffortStyle;
  /** 이벤트 스트림을 켜는 인자. codex 는 `--output-format` 이 아예 없고 `--json` 이다 (SPEC §0.1-6). */
  readonly streamArgv: readonly string[];
  readonly streamFormat: 'claude' | 'codex';
  readonly variant?: { readonly default: 'thinking' | 'plain'; readonly fastOptIn: boolean };
  /**
   * primary 슬롯에 파일 쓰기를 허용하는 인자 (D-025). 선언이 없는 엔진에 쓰기를 요청하면 **던진다** —
   * 읽기 전용으로 조용히 떨어뜨리면 "실행했다"가 거짓이 된다.
   */
  readonly write?: {
    readonly argv: readonly string[];
    /** 지금은 `workspace` 뿐이다. 워크스페이스 밖까지 여는 값은 선언하지 않는다. */
    readonly scope: 'workspace';
    readonly note: string;
  };
}

/** 해당 엔진이 그 모델을 아예 제공하지 않으면 `null` 이다 — 말없는 치환의 자리가 아니다 (D-004). */
export type Availability = {
  readonly id?: string;
  readonly idTemplate?: string;
  readonly efforts: readonly Effort[];
  readonly thinking?: boolean;
  /** `-fast` 변형이 이 모델에 **존재하는가** (D-023 실측). 없으면 fast 요청은 던진다. */
  readonly fast?: boolean;
} | null;

export interface ModelSpec {
  readonly defaultEngine: EngineName;
  readonly availability: Readonly<Record<EngineName, Availability>>;
}

export interface Engines {
  readonly efforts: readonly Effort[];
  readonly engines: Readonly<Record<EngineName, EngineSpec>>;
  readonly models: Readonly<Record<ModelKey, ModelSpec>>;
}

const ENGINES_PATH = path.resolve(import.meta.dirname, '..', '..', 'data', 'engines.json');

let cached: Engines | undefined;

export function loadEngines(): Engines {
  cached ??= JSON.parse(readFileSync(ENGINES_PATH, 'utf8')) as Engines;
  return cached;
}
