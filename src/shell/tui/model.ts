/**
 * 화면 뷰모델 — **순수 함수다** (D-019).
 * Ink 렌더 층은 이 결과를 그리기만 한다. 그래서 화면 테스트가 터미널을 띄우지 않는다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AssignmentPlan } from '../../core/assign.ts';
import type { Journal } from '../../core/journal.ts';
import type { Budget } from '../../core/budget.ts';
import type { RouteResult } from '../../core/pipeline.ts';

export const SCREENS = ['Run', 'Tasks', 'Dashboard', 'Sessions', 'Reviews', 'Debug'] as const;
export type Screen = (typeof SCREENS)[number];

/** 근거 등급 배지 (SPEC §2.5, D-014). **섞어 표시하지 않는다.** */
export type Grade = 'INDEPENDENT' | 'VENDOR' | 'POLICY';

export interface Badge {
  readonly grade: Grade;
  readonly text: string;
}

export interface TitleInfo {
  readonly env: string;
  readonly version: string;
  readonly text: string;
}

/** 화면 타이틀에 환경 + 버전 (SPEC §7, hs-00-core 관찰가능성). */
export function titleInfo(screen: Screen, now = process.env): TitleInfo {
  const env = now['NODE_ENV'] ?? 'development';
  let version = '0.0.0';
  try {
    const pkg = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as { version?: string };
    version = pkg.version ?? version;
  } catch {
    // 버전을 못 읽어도 화면은 떠야 한다.
  }
  return { env, version, text: `hs-orchestrator ${screen} · ${env} · v${version}` };
}

export interface CostLine {
  readonly line: string;
  readonly badge: Badge;
  /** 실행 **전에** 보여야 한다 (SPEC §7). */
  readonly disclaimer: string;
}

export function costLine(plan: AssignmentPlan): CostLine {
  return {
    line: `$${plan.cost.totalUsd} = primary $${plan.cost.primaryUsd} + reviewer $${plan.cost.reviewerUsd}`,
    badge: { grade: 'INDEPENDENT', text: 'Artificial Analysis' },
    disclaimer: 'AA 벤치마크 측정치이며 실제 지출이 아니다.',
  };
}

export interface RunView {
  readonly title: TitleInfo;
  readonly lines: readonly string[];
  readonly cost: CostLine | null;
  /** 승인 대기 중인가 — 비용을 본 뒤에만 true 다. */
  readonly awaitingApproval: boolean;
}

export function runView(result: RouteResult | null, task: string): RunView {
  const title = titleInfo('Run');
  if (result === null) return { title, lines: [`작업: ${task || '(입력 대기)'}`], cost: null, awaitingApproval: false };

  if (result.stage === 'unclassified') {
    return { title, lines: ['분류: 해당 없음 — 임의 배정하지 않는다', result.message], cost: null, awaitingApproval: false };
  }
  if (result.stage === 'direct') {
    return {
      title,
      lines: ['판정: ② 유지 — §1 하한선에 걸렸다. 엔진을 띄우지 않는다.', ...result.reasons.map((r) => `· ${r}`)],
      cost: null,
      awaitingApproval: false,
    };
  }

  const { plan } = result;
  const { primary, reviewer } = plan.slots;
  return {
    title,
    lines: [
      `분류 ${plan.assignment.id} ${plan.assignment.task}  (${result.reason})`,
      `primary  ${primary.label} · ${primary.effort} → ${primary.engine} / ${primary.modelId}`,
      `reviewer ${reviewer.label} · ${reviewer.effort} → ${reviewer.engine} / ${reviewer.modelId}`,
      `기준 ${plan.assignment.operatingCriterion}`,
    ],
    cost: costLine(plan),
    awaitingApproval: true,
  };
}

export interface DashboardView {
  readonly title: TitleInfo;
  readonly spent: string;
  readonly distribution: readonly { readonly model: string; readonly count: number }[];
  readonly outcomes: readonly { readonly outcome: string; readonly count: number }[];
  readonly unverified: number;
}

export function dashboardView(journal: Journal, budget: Budget): DashboardView {
  const tally = <T extends string>(keys: readonly T[]): { key: T; count: number }[] => {
    const map = new Map<T, number>();
    for (const k of keys) map.set(k, (map.get(k) ?? 0) + 1);
    return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
  };

  return {
    title: titleInfo('Dashboard'),
    spent: budget.summary(),
    distribution: tally(journal.records.map((r) => r.model)).map((t) => ({ model: t.key, count: t.count })),
    outcomes: tally(journal.records.map((r) => r.outcome)).map((t) => ({ outcome: t.key, count: t.count })),
    // 빈 검증란은 "통과"가 아니다 — 화면에서 따로 센다.
    unverified: journal.unverified.length,
  };
}
