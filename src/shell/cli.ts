/**
 * v1 셸의 최소판 (PLAN S1~S3). TUI 는 S5다.
 *
 *   node src/shell/cli.ts "<작업>" [--task R01] [--effort high] [--reviewer-effort high]
 *        [--gate irreversibleChange] [--classify-llm] [--run] [--timeout 600] [--raw]
 *
 * 기본은 **배정 제시까지**다 (SPEC §4-4 승인 게이트). 실제 실행은 `--run` 으로만 한다.
 */
import { loadMatrix } from '../data/matrix.ts';
import { loadEngines } from '../data/engines.ts';
import { createAdapter } from '../adapters/engine.ts';
import { GATE_CHECKS, parseGateCheck, type GateSignals } from '../core/gatekeeper.ts';
import { classifyWithModel } from '../core/classify-llm.ts';
import { route } from '../core/pipeline.ts';
import type { Effort } from '../data/matrix.ts';

interface Parsed {
  task: string;
  taskId?: string;
  primaryEffort?: Effort;
  reviewerEffort?: Effort;
  gate: GateSignals;
  classifyLlm: boolean;
  run: boolean;
  raw: boolean;
  timeoutMs: number;
}

const USAGE = `사용법: node src/shell/cli.ts "<작업>" [--task R01] [--effort high] [--reviewer-effort high]
       [--gate <${GATE_CHECKS.join('|')}>]... [--classify-llm] [--run] [--timeout 600] [--raw]`;

function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const parsed: Parsed = { task: '', gate: {}, classifyLlm: false, run: false, raw: false, timeoutMs: 900_000 };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg ?? ''} 에 값이 없다.`);
      i += 1;
      return next;
    };

    switch (arg) {
      case '--task': parsed.taskId = value(); break;
      case '--effort': parsed.primaryEffort = value() as Effort; break;
      case '--reviewer-effort': parsed.reviewerEffort = value() as Effort; break;
      case '--gate': parsed.gate[parseGateCheck(value())] = true; break;
      case '--classify-llm': parsed.classifyLlm = true; break;
      case '--run': parsed.run = true; break;
      case '--raw': parsed.raw = true; break;
      case '--timeout': parsed.timeoutMs = Number(value()) * 1000; break;
      default: if (arg !== undefined) positional.push(arg);
    }
  }

  parsed.task = positional.join(' ').trim();
  if (!parsed.task) throw new Error(`작업 문자열이 없다.\n  ${USAGE}`);
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const matrix = loadMatrix();
  const catalog = loadEngines();

  const options = {
    ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
    ...(args.primaryEffort !== undefined ? { primaryEffort: args.primaryEffort } : {}),
    ...(args.reviewerEffort !== undefined ? { reviewerEffort: args.reviewerEffort } : {}),
    gate: args.gate,
  };

  let result = route(matrix, catalog, args.task, options);

  // 규칙으로 못 붙었을 때만 저비용 모델에 분류만 시킨다 (PLAN S3-6).
  if (result.stage === 'unclassified' && args.classifyLlm) {
    process.stderr.write('분류   규칙 무매치 → Haiku·low 로 분류만 재시도\n');
    const guessed = await classifyWithModel(matrix, catalog, args.task);
    if (guessed) {
      result = route(matrix, catalog, args.task, { ...options, taskId: guessed.id, reasonLabel: 'Haiku·low 분류' });
    }
  }

  if (result.stage === 'unclassified') {
    process.stderr.write(`${result.message}\n  --classify-llm 으로 저비용 모델 분류를 시도할 수 있다.\n`);
    process.exitCode = 1;
    return;
  }

  if (result.stage === 'direct') {
    process.stderr.write(
      ['판정   ② 유지 — §1 하한선에 걸렸다. 엔진을 띄우지 않는다.', ...result.reasons.map((r) => `       · ${r}`), ''].join('\n'),
    );
    return;
  }

  const { plan, reason } = result;
  const { primary, reviewer } = plan.slots;
  process.stderr.write(
    [
      `업무   ${plan.assignment.id} ${plan.assignment.task}  (${reason})`,
      `배정   primary  ${primary.label} · ${primary.effort}  → ${primary.engine} / ${primary.modelId}`,
      `       reviewer ${reviewer.label} · ${reviewer.effort}  → ${reviewer.engine} / ${reviewer.modelId}`,
      `기준   ${plan.assignment.operatingCriterion}`,
      `비용   $${plan.cost.totalUsd} = primary $${plan.cost.primaryUsd} + reviewer $${plan.cost.reviewerUsd}  [${plan.cost.grade.toUpperCase()}]`,
      `       ${plan.cost.note}`,
      '',
    ].join('\n'),
  );

  if (!args.run) {
    process.stderr.write('제시만 했다. 실제 실행은 --run 이다 (승인 게이트).\n');
    return;
  }

  // S3 범위에서는 primary 슬롯만 실제로 돌린다 — reviewer 왕복은 S4 ModeRunner 다.
  const adapter = createAdapter(primary.engine, catalog);
  const handle = adapter.start(
    { model: primary.model, effort: primary.effort, prompt: args.task, cwd: process.cwd(), timeoutMs: args.timeoutMs },
    (event) => {
      if (event.kind === 'notice') process.stderr.write(`[${event.level}] ${event.message}\n`);
      if (event.kind === 'unparsed') process.stderr.write(`[unparsed] ${event.line.slice(0, 120)}\n`);
    },
  );
  process.on('SIGINT', () => handle.cancel());

  const run = await handle.result;
  process.stdout.write(`${args.raw ? run.rawStdout : run.text}\n`);
  process.stderr.write(
    `\n결과   ${run.outcome} · ${run.durationMs}ms` +
      (run.usage ? ` · in ${run.usage.inputTokens} / out ${run.usage.outputTokens}` : '') +
      (run.costUsd !== undefined ? ` · $${run.costUsd.toFixed(4)}` : '') +
      (run.unparsedLines.length ? ` · 파싱 실패 ${run.unparsedLines.length}줄` : '') +
      `\nreviewer ${reviewer.label} 왕복은 S4에서 붙는다.\n`,
  );
  if (run.outcome !== 'ok') process.exitCode = 1;
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
