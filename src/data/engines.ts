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

export interface EngineSpec {
  /** 앞에서부터 탐색한다. cursor 는 `cursor-cli` → `cursor-agent` 폴백 (D-005). */
  readonly binaries: readonly string[];
  readonly promptArgv: readonly string[];
  readonly modelFlag: string;
  readonly effort: EffortStyle;
  /** 이벤트 스트림을 켜는 인자. codex 는 `--output-format` 이 아예 없고 `--json` 이다 (SPEC §0.1-6). */
  readonly streamArgv: readonly string[];
  readonly streamFormat: 'claude' | 'codex';
  readonly variant?: { readonly default: 'thinking' | 'plain'; readonly fastOptIn: boolean };
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
