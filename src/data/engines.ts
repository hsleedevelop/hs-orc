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
  /**
   * git 저장소 밖에서 돌 때 필요한 인자. codex exec 는 없으면 거절한다.
   * **스크래치 세션에만** 붙인다 — 쓰기가 꺼진 자리라 git 검사가 지키던 것이 없다 (SPEC §6.4.1).
   */
  readonly nonGitArgv?: readonly string[];
  /**
   * 쓰기를 요청하지 **않았을 때** 붙이는 읽기 전용 인자 (D-051). 엔진 기본값에 기대지 않는다 —
   * codex 는 신뢰된 폴더에서 기본 sandbox 가 쓰기 가능이라, 인자가 없으면 "읽기 전용" 위임이 파일을 고친다.
   * resume 경로에도 붙으므로 resume 이 받는 형식(codex `-c`)이어야 한다.
   * claude 의 `--disallowedTools` 는 가변 인자라 값을 쉼표로 묶은 한 토큰으로 둔다 — 뒤에 플래그만 온다 (D-052).
   */
  readonly readOnlyArgv?: readonly string[];
  /**
   * 비대화 resume (SPEC §3.8, 2026-09-23 Q10 실측). claude·cursor 는 플래그, codex 는 `exec resume <id>` 서브커맨드다.
   * 선언이 없는 엔진에 resume 을 요청하면 **던진다** — 맥락 없는 새 실행으로 조용히 떨어지지 않는다.
   * `write: false` 면 이 엔진의 resume 경로는 쓰기 인자를 받지 못한다는 뜻이다 (실측 근거는 `$evidence.resume`).
   * resume·write 를 동시에 요청하면 **던진다** — 쓰기를 조용히 빼고 읽기 전용으로 잇지 않는다.
   */
  readonly resume?:
    | { readonly kind: 'flag'; readonly flag: string; readonly write?: false }
    | { readonly kind: 'subcommand'; readonly argv: readonly string[]; readonly write?: false };
  /**
   * 사용자 전역 hook·설정·MCP·skills 를 싣지 않게 막는 argv (D-032 B1). **지휘자 역할에만** 쓴다
   * (직접 답·요약·분류 폴백) — primary·reviewer 는 격리하지 않는다, 사용자의 작업 규칙이
   * 위임 품질의 일부다. 선언이 없는 엔진에 격리를 요청하면 격리 없이 조용히 돌리지 않고 던진다.
   */
  readonly isolateArgv?: readonly string[];
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
