/**
 * `/graph` — graph-engineering (SPEC §6.3).
 *
 * - 노드마다 **독립적으로 배정**된다. 한 그래프에 Luna 노드와 Fable 노드가 공존한다.
 * - **순환 검출은 실행 전 필수**다. 순환이면 한 노드도 실행하지 않는다.
 * - 병렬은 **쓰기 대상 파일이 겹치지 않을 때만**. 불확실하면 순차로 떨어뜨린다.
 * - 부분 실패 전파는 노드마다 선언한다: fail-fast / skip-dependents / continue.
 */
import type { Matrix } from '../../data/matrix.ts';
import { Budget, BudgetExceeded } from '../budget.ts';
import { Journal } from '../journal.ts';
import { estimateUsd, type SlotExecutor } from '../executor.ts';
import { assign, type AssignmentPlan } from '../assign.ts';
import type { Engines } from '../../data/engines.ts';

export type Propagation = 'fail-fast' | 'skip-dependents' | 'continue';

export interface GraphNode {
  readonly id: string;
  readonly prompt: string;
  readonly plan: AssignmentPlan;
  readonly dependsOn: readonly string[];
  /** 이 노드가 쓰는 파일. **비어 있으면 "모른다"로 보고 병렬에서 뺀다.** */
  readonly writes: readonly string[];
  readonly onFailure: Propagation;
}

export class GraphError extends Error {
  override name = 'GraphError';
}

/** `--graph <nodes.json>` 의 파일 형식. 커밋된 예제는 `examples/graph-nodes.json` 이다. */
export interface GraphSpec {
  readonly nodes: readonly {
    readonly id: string;
    readonly prompt: string;
    /** 매트릭스 행 id (R01~R11). **노드마다 독립 배정**이라 그래프 안에서 모델이 섞인다. */
    readonly task: string;
    readonly dependsOn?: readonly string[];
    readonly writes?: readonly string[];
    readonly onFailure?: Propagation;
  }[];
}

/**
 * 스펙 JSON → 배정이 끝난 노드. **셸이 아니라 여기가 이 형식의 소유자다** —
 * 셸에 두면 형식을 테스트로 고정할 수가 없고, 실제로 커밋된 예제가 없었다(PLAN S9 후속).
 */
export function parseGraphSpec(matrix: Matrix, catalog: Engines, spec: GraphSpec): GraphNode[] {
  // 입력은 파일에서 온 JSON 이라 타입을 믿을 수 없다. 형태를 확인한 뒤 타입을 되붙인다
  // (`Array.isArray` 는 readonly 배열을 any[] 로 좁혀 버려 이후가 전부 unsafe 가 된다).
  const raw: unknown = (spec as { nodes?: unknown } | undefined)?.nodes;
  if (!Array.isArray(raw) || raw.length === 0) throw new GraphError('그래프 스펙에 nodes 배열이 없다.');
  const nodes = raw as unknown as GraphSpec['nodes'];

  const seen = new Set<string>();
  return nodes.map((n) => {
    if (!n.id || !n.prompt || !n.task) throw new GraphError(`노드에 id·prompt·task 가 다 있어야 한다: ${JSON.stringify(n)}`);
    if (seen.has(n.id)) throw new GraphError(`노드 id 가 겹친다: ${n.id}`);
    seen.add(n.id);
    const row = matrix.assignments.find((a) => a.id === n.task);
    if (!row) throw new GraphError(`${n.id}: 그런 업무 행이 없다: ${n.task}`);
    return {
      id: n.id,
      prompt: n.prompt,
      plan: assign(matrix, catalog, row),
      dependsOn: n.dependsOn ?? [],
      writes: n.writes ?? [],
      onFailure: n.onFailure ?? 'skip-dependents',
    };
  });
}

export type GraphStopReason = 'completed' | 'max-nodes' | 'budget-exceeded' | 'failed-fast';

export interface GraphResult {
  readonly stopReason: GraphStopReason;
  readonly journal: Journal;
  readonly budget: Budget;
  readonly skipped: readonly string[];
  /** 실제로 병렬로 묶여 돈 묶음들. 순차로 떨어진 노드는 크기 1 묶음이다. */
  readonly batches: readonly (readonly string[])[];
}

export interface GraphOptions {
  readonly maxNodes: number;
  readonly budgetUsd: number;
}

/** 위상 정렬. 순환이면 던진다 — 실행 전에 부른다. */
export function topoSort(nodes: readonly GraphNode[]): GraphNode[][] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!byId.has(dep)) throw new GraphError(`${node.id} 가 없는 노드에 의존한다: ${dep}`);
    }
  }

  const remaining = new Map(nodes.map((n) => [n.id, new Set(n.dependsOn)]));
  const layers: GraphNode[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (ready.length === 0) {
      throw new GraphError(`순환을 검출했다: ${[...remaining.keys()].join(' → ')} — 한 노드도 실행하지 않는다.`);
    }
    layers.push(ready.map((id) => byId.get(id) as GraphNode));
    for (const id of ready) remaining.delete(id);
    for (const deps of remaining.values()) for (const id of ready) deps.delete(id);
  }
  return layers;
}

/**
 * 한 레이어를 병렬 묶음으로 쪼갠다.
 * 쓰기 대상이 겹치거나 **선언되지 않은** 노드는 자기 혼자 도는 묶음이 된다.
 */
export function partitionByWrites(layer: readonly GraphNode[]): GraphNode[][] {
  const batches: GraphNode[][] = [];
  let current: GraphNode[] = [];
  let claimed = new Set<string>();

  for (const node of layer) {
    const unknownWrites = node.writes.length === 0;
    const overlaps = node.writes.some((w) => claimed.has(w));
    if (unknownWrites || overlaps) {
      if (current.length > 0) batches.push(current);
      batches.push([node]); // 불확실하면 순차로 떨어뜨린다.
      current = [];
      claimed = new Set();
      continue;
    }
    current.push(node);
    for (const w of node.writes) claimed.add(w);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export async function runGraph(
  matrix: Matrix,
  nodes: readonly GraphNode[],
  execute: SlotExecutor,
  options: GraphOptions,
): Promise<GraphResult> {
  if (nodes.length > options.maxNodes) {
    throw new GraphError(`최대 노드 수 초과: ${nodes.length} > ${options.maxNodes}`);
  }

  // 실행 전 필수 검사. 여기서 던지면 한 노드도 돌지 않는다.
  const layers = topoSort(nodes);

  const journal = new Journal();
  const budget = new Budget(options.budgetUsd);
  const skipped: string[] = [];
  const batches: string[][] = [];
  const failed = new Set<string>();
  let index = 0;
  let stopReason: GraphStopReason = 'completed';

  const dependsOnFailed = (node: GraphNode): boolean =>
    node.dependsOn.some((dep) => failed.has(dep) || skipped.includes(dep));

  outer: for (const layer of layers) {
    for (const batch of partitionByWrites(layer)) {
      const runnable = batch.filter((node) => {
        if (dependsOnFailed(node)) {
          skipped.push(node.id);
          journal.append({
            index: (index += 1), unit: '노드', model: node.plan.slots.primary.label,
            effort: node.plan.slots.primary.effort, outcome: 'skipped',
            evidence: `선행 노드 실패: ${node.dependsOn.join(', ')}`, change: '', verification: '',
          });
          return false;
        }
        return true;
      });
      if (runnable.length === 0) continue;

      try {
        budget.assertCanContinue();
      } catch (error) {
        if (error instanceof BudgetExceeded) {
          stopReason = 'budget-exceeded';
          break outer;
        }
        throw error;
      }

      // **병렬 묶음은 사전 추정으로 자른다.** 배치 시작 전 1회만 검사하면
      // 비싼 노드 6개가 동시에 떠서 상한을 훌쩍 넘긴 뒤에야 알게 된다 — 돈은 이미 나갔다.
      const affordable: GraphNode[] = [];
      let projected = budget.spentUsd;
      for (const node of runnable) {
        const next = projected + estimateUsd(matrix, node.plan.slots.primary);
        if (affordable.length > 0 && next > budget.limitUsd) break;
        affordable.push(node);
        projected = next;
        if (projected >= budget.limitUsd) break;
      }
      const trimmed = affordable.length < runnable.length;
      if (trimmed) stopReason = 'budget-exceeded';

      batches.push(affordable.map((n) => n.id));

      const runs = await Promise.all(
        affordable.map(async (node) => ({ node, run: await execute(node.plan.slots.primary, node.prompt) })),
      );

      for (const { node, run } of runs) {
        const charge = budget.charge(
          `${node.id} ${node.plan.slots.primary.label}`,
          run.actualUsd,
          estimateUsd(matrix, node.plan.slots.primary),
          run.meteredUsd,
        );
        journal.append({
          index: (index += 1), unit: '노드', model: node.plan.slots.primary.label,
          effort: node.plan.slots.primary.effort, outcome: run.ok ? 'ok' : 'failed',
          evidence: node.prompt.slice(0, 120), change: run.text.slice(0, 200), verification: '', charge,
        });

        if (!run.ok) {
          failed.add(node.id);
          if (node.onFailure === 'fail-fast') {
            stopReason = 'failed-fast';
            break outer;
          }
          // 'continue' 는 후속을 막지 않으므로 실패 집합에서 뺀다.
          if (node.onFailure === 'continue') failed.delete(node.id);
        }
      }

      // 예산 때문에 잘렸다면 이 묶음까지만 돌고 끝낸다.
      if (trimmed) break outer;
    }
  }

  return { stopReason, journal, budget, skipped, batches };
}
