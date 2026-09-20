/**
 * 매트릭스 데이터 접근 (SPEC §2·§9).
 * `data/matrix.json` 은 생성물이다 — 원본 HTML이 진실이고 수기 편집하지 않는다 (D-013).
 * 이 계층은 Core·Adapters·Shell 을 import하지 않는다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** 정규 effort 어휘 (SPEC §3.3). codex의 `ultra`는 매트릭스에 없으므로 넣지 않는다. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export type Vendor = 'openai' | 'anthropic';
export type ModelKey = 'luna' | 'terra' | 'sol' | 'astra' | 'haiku' | 'sonnet' | 'opus' | 'fable';

export interface Slot {
  readonly model: ModelKey;
  readonly vendor: Vendor;
  /** 원본이 `xHigh/Max` 처럼 범위를 주면 낮은 쪽이 기본, 뒤쪽이 상향값이다. */
  readonly efforts: readonly Effort[];
  readonly label: string;
}

export interface Assignment {
  readonly id: string;
  readonly task: string;
  /** 운영 기준 = 완료의 정의 (D-010). */
  readonly operatingCriterion: string;
  readonly primary: Slot;
  readonly reviewer: Slot;
  readonly detail: string;
}

export interface Economics {
  readonly model: ModelKey;
  readonly vendor: Vendor;
  /** 벤치마크 측정치이며 실제 지출이 아니다 (SPEC §2.3). UI에 그대로 표기한다. */
  readonly aa: number;
  readonly taskCostUsd: number;
  readonly firstChunkSec: number;
  readonly inputScope: string;
  readonly note: string | null;
}

export interface LadderStep {
  readonly level: string;
  readonly primary: { readonly model: ModelKey; readonly effort: Effort };
  readonly reviewer: { readonly model: ModelKey; readonly effort: Effort };
  readonly independentReview: boolean;
}

export interface Matrix {
  readonly $generated: { readonly source: string; readonly sourceSha256: string };
  readonly tiers: Readonly<Record<Vendor, readonly ModelKey[]>>;
  readonly assignments: readonly Assignment[];
  readonly economics: readonly Economics[];
  readonly ladder: readonly LadderStep[];
}

const MATRIX_PATH = path.resolve(import.meta.dirname, '..', '..', 'data', 'matrix.json');

let cached: Matrix | undefined;

export function loadMatrix(): Matrix {
  cached ??= JSON.parse(readFileSync(MATRIX_PATH, 'utf8')) as Matrix;
  return cached;
}

/** INV-1: vendor(primary) ≠ vendor(reviewer) (D-009). 위반은 데이터 손상이다. */
export function crossesVendors(assignment: Assignment): boolean {
  return assignment.primary.vendor !== assignment.reviewer.vendor;
}
