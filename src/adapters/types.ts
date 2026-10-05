/** EngineAdapter 의 공개 계약 (SPEC §3.1). Core 는 CLI 플래그가 아니라 이 타입만 본다. */
import type { Effort, ModelKey } from '../data/matrix.ts';
import type { EngineName } from '../data/engines.ts';

export interface RunRequest {
  readonly model: ModelKey;
  readonly effort: Effort;
  readonly prompt: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  /** 파일 쓰기 허용 (D-025). 기본(생략)은 읽기 전용이다. */
  readonly write?: boolean;
  /** 스크래치 세션 — git 저장소 밖이다. 엔진이 선언한 `nonGitArgv` 를 붙인다. */
  readonly nonGit?: boolean;
  /** 이어 붙일 엔진 세션 id (SPEC §3.8). */
  readonly resume?: string;
  /** 사용자 전역 hook·설정·MCP·skills 를 싣지 않는다 (D-032 B1). 지휘자 역할에만 켠다. */
  readonly isolate?: boolean;
  /** 1M 컨텍스트 창 (D-087). 지휘자 자리에만 켠다 — 선언이 없는 엔진·모델이면 argv 생성이 던진다. */
  readonly longContext?: boolean;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  /**
   * 엔진 보고에 캐시 읽기 칸 자체가 없었다 (D-070). 그때 `cachedInputTokens` 의 0 은 "읽지 않았다" 가 아니라 "모른다" 다 —
   * 셈은 그대로 두고 표시만 한다. 칸이 있으면(0 이라도) 생략한다.
   */
  readonly cachedInputUnreported?: true;
}

/**
 * claude `result.usage.cache_creation` 의 TTL 별 캐시 쓰기 (D-062). **관측 전용** — Budget 셈(D-060)에 들지 않는다.
 * `result.usage` 범위라 이번 실행 본 대화 호출의 합이다: resume 해도 누적이 아니고, 보조 호출 몫은 빠진다.
 */
export interface CacheWrite {
  readonly ephemeral1hTokens: number;
  readonly ephemeral5mTokens: number;
}

/** 세 엔진의 서로 다른 이벤트를 이 어휘로 정규화한다. */
export type RunEvent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'notice'; readonly level: 'warn' | 'error'; readonly message: string }
  | { readonly kind: 'usage'; readonly usage: Usage }
  | { readonly kind: 'cacheWrite'; readonly cacheWrite: CacheWrite }
  | { readonly kind: 'done'; readonly ok: boolean; readonly text: string; readonly costUsd?: number }
  /** 파싱 실패한 줄. **버리지 않는다** — 한 줄 실패가 실행 전체를 죽이지 않게 하되 침묵하지도 않는다. */
  | { readonly kind: 'unparsed'; readonly line: string; readonly reason: string }
  | { readonly kind: 'session'; readonly id: string }
  | { readonly kind: 'compact'; readonly compaction: EngineCompaction }
  /** 엔진이 도는 중 한 일 한 줄 (D-084) — 중간 답 글·도구 호출. 화면 표시 전용이라 결과 `text` 에 들지 않는다. */
  | { readonly kind: 'progress'; readonly text: string };

/**
 * 엔진이 실행 중 맥락을 압축했다 (D-058). claude 스트림의 `system`·`compact_boundary` 에서 읽는다
 * (2026-09-26 실측, `compact_metadata`). 토큰 칸은 엔진이 안 주면 없다 — 0 으로 채우지 않는다.
 */
export interface EngineCompaction {
  /** `manual`(`/compact`) · `auto` — 엔진이 준 문자열 그대로다. */
  readonly trigger: string;
  readonly preTokens?: number;
  readonly postTokens?: number;
}

export type RunOutcome = 'ok' | 'error' | 'timeout' | 'cancelled';

export interface RunResult {
  readonly outcome: RunOutcome;
  readonly text: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly usage?: Usage;
  /** 엔진이 캐시 쓰기 TTL 내역을 줬으면 그 값 (D-062). 없으면 필드가 없다. */
  readonly cacheWrite?: CacheWrite;
  readonly costUsd?: number;
  readonly durationMs: number;
  /** 파싱과 무관하게 보존한다 (SPEC §3.7) — 파싱 실패가 원본 손실로 이어지면 안 된다. */
  readonly rawStdout: string;
  readonly rawStderr: string;
  readonly unparsedLines: readonly string[];
  /** 스트림에서 읽은 엔진 세션 id. 못 읽으면 없다 — 지어내지 않는다. */
  readonly sessionId?: string;
  /** 이 실행 중 엔진이 한 압축 (D-058). 없으면 필드가 없다. */
  readonly compactions?: readonly EngineCompaction[];
}

export interface RunHandle {
  readonly result: Promise<RunResult>;
  cancel(): void;
}

export interface EngineAdapter {
  readonly id: EngineName;
  /** 이 어댑터가 (model, effort) 조합을 실행할 수 있는가. 못 하면 대체하지 않고 false 다. */
  supports(model: ModelKey, effort: string): boolean;
  /** 실행 전 검증. 실패하면 던진다 — 조용한 폴백 금지. */
  buildArgv(req: RunRequest): string[];
  start(req: RunRequest, onEvent?: (event: RunEvent) => void): RunHandle;
}
