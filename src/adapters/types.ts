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
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
}

/** 세 엔진의 서로 다른 이벤트를 이 어휘로 정규화한다. */
export type RunEvent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'notice'; readonly level: 'warn' | 'error'; readonly message: string }
  | { readonly kind: 'usage'; readonly usage: Usage }
  | { readonly kind: 'done'; readonly ok: boolean; readonly text: string; readonly costUsd?: number }
  /** 파싱 실패한 줄. **버리지 않는다** — 한 줄 실패가 실행 전체를 죽이지 않게 하되 침묵하지도 않는다. */
  | { readonly kind: 'unparsed'; readonly line: string; readonly reason: string };

export type RunOutcome = 'ok' | 'error' | 'timeout' | 'cancelled';

export interface RunResult {
  readonly outcome: RunOutcome;
  readonly text: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly usage?: Usage;
  readonly costUsd?: number;
  readonly durationMs: number;
  /** 파싱과 무관하게 보존한다 (SPEC §3.7) — 파싱 실패가 원본 손실로 이어지면 안 된다. */
  readonly rawStdout: string;
  readonly rawStderr: string;
  readonly unparsedLines: readonly string[];
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
