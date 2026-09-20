/**
 * v1 셸의 최소판 (PLAN S1~S2). TUI 는 S5다.
 *
 *   node src/shell/cli.ts "<작업>" [--task R01] [--engine codex] [--effort high]
 *                                 [--timeout 600] [--dry-run] [--raw]
 */
import { loadMatrix } from '../data/matrix.ts';
import { loadEngines } from '../data/engines.ts';
import { createAdapter } from '../adapters/engine.ts';
import { planPrimary, toRunRequest } from '../core/route.ts';

type EngineName = 'claude' | 'codex' | 'cursor';

interface Options {
  taskId?: string;
  engine?: EngineName;
  effort?: string;
}

function parseArgs(argv: readonly string[]): { task: string; options: Options; dryRun: boolean; raw: boolean; timeoutMs: number } {
  const positional: string[] = [];
  const options: Options = {};
  let dryRun = false;
  let raw = false;
  let timeoutMs = 900_000;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg ?? ''} 에 값이 없다.`);
      i += 1;
      return next;
    };

    switch (arg) {
      case '--dry-run': dryRun = true; break;
      case '--raw': raw = true; break;
      case '--task': options.taskId = value(); break;
      case '--engine': options.engine = value() as EngineName; break;
      case '--effort': options.effort = value(); break;
      case '--timeout': timeoutMs = Number(value()) * 1000; break;
      default: if (arg !== undefined) positional.push(arg);
    }
  }

  const task = positional.join(' ').trim();
  if (!task) {
    throw new Error('작업 문자열이 없다.\n  사용법: node src/shell/cli.ts "<작업>" [--task R01] [--engine codex] [--effort high] [--timeout 600] [--dry-run] [--raw]');
  }
  return { task, options, dryRun, raw, timeoutMs };
}

async function main(): Promise<void> {
  const { task, options, dryRun, raw, timeoutMs } = parseArgs(process.argv.slice(2));
  const catalog = loadEngines();
  const plan = planPrimary(loadMatrix(), catalog, task, options);
  const { assignment } = plan;

  // 배정 근거를 먼저 보여준다 — 관찰가능성은 UI 기능이 아니라 기본값이다.
  process.stderr.write(
    [
      `업무   ${assignment.id} ${assignment.task}  (${plan.reason})`,
      `배정   primary ${assignment.primary.label} · ${plan.effort}  → ${plan.engine} / ${plan.modelId}`,
      `기준   ${assignment.operatingCriterion}`,
      `reviewer ${assignment.reviewer.label} 은 S3에서 붙는다 (이 단계는 primary 슬롯만).`,
      '',
    ].join('\n'),
  );

  const adapter = createAdapter(plan.engine, catalog);
  const request = toRunRequest(plan, task, process.cwd(), timeoutMs);

  if (dryRun) {
    process.stderr.write(`argv   ${adapter.buildArgv(request).join(' ')}\n`);
    return;
  }

  const handle = adapter.start(request, (event) => {
    if (event.kind === 'notice') process.stderr.write(`[${event.level}] ${event.message}\n`);
    if (event.kind === 'unparsed') process.stderr.write(`[unparsed] ${event.line.slice(0, 120)}\n`);
  });
  process.on('SIGINT', () => handle.cancel());

  const result = await handle.result;
  process.stdout.write(`${raw ? result.rawStdout : result.text}\n`);
  process.stderr.write(
    `\n결과   ${result.outcome} · ${result.durationMs}ms` +
      (result.usage ? ` · in ${result.usage.inputTokens} / out ${result.usage.outputTokens}` : '') +
      (result.costUsd !== undefined ? ` · $${result.costUsd.toFixed(4)}` : '') +
      (result.unparsedLines.length ? ` · 파싱 실패 ${result.unparsedLines.length}줄` : '') +
      '\n',
  );
  if (result.outcome !== 'ok') process.exitCode = 1;
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
