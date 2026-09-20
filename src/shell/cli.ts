/**
 * v1 셸의 최소판 (PLAN S1). TUI 는 S5다 — 지금은 인자 → 계획 → 프로세스 → stdout 패스스루.
 *
 *   node src/shell/cli.ts "이 타입 에러 고쳐줘" [--task R01] [--engine codex] [--effort high] [--dry-run]
 */
import { spawn } from 'node:child_process';
import { loadMatrix } from '../data/matrix.ts';
import { loadEngines } from '../data/engines.ts';
import { resolveBinary } from '../adapters/resolve.ts';
import { planPrimary } from '../core/route.ts';

interface Args {
  readonly task: string;
  readonly options: { taskId?: string; engine?: 'claude' | 'codex' | 'cursor'; effort?: string };
  readonly dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const options: { taskId?: string; engine?: 'claude' | 'codex' | 'cursor'; effort?: string } = {};
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg ?? ''} 에 값이 없다.`);
      i += 1;
      return next;
    };

    switch (arg) {
      case '--dry-run':
        dryRun = true;
        break;
      case '--task':
        options.taskId = value();
        break;
      case '--engine':
        options.engine = value() as 'claude' | 'codex' | 'cursor';
        break;
      case '--effort':
        options.effort = value();
        break;
      default:
        if (arg !== undefined) positional.push(arg);
    }
  }

  const task = positional.join(' ').trim();
  if (!task) throw new Error('작업 문자열이 없다.\n  사용법: node src/shell/cli.ts "<작업>" [--task R01] [--engine codex] [--effort high] [--dry-run]');
  return { task, options, dryRun };
}

function main(): void {
  const { task, options, dryRun } = parseArgs(process.argv.slice(2));
  const plan = planPrimary(loadMatrix(), loadEngines(), task, options);
  const { assignment, invocation } = plan;

  // 배정 근거를 먼저 보여준다 — 관찰가능성은 UI가 아니라 기본값이다.
  process.stderr.write(
    [
      `업무   ${assignment.id} ${assignment.task}  (${plan.reason})`,
      `배정   primary ${assignment.primary.label} · ${invocation.effort}  → ${invocation.engine} / ${invocation.modelId}`,
      `기준   ${assignment.operatingCriterion}`,
      `reviewer ${assignment.reviewer.label} 은 S3에서 붙는다 (이 단계는 primary 슬롯만).`,
      '',
    ].join('\n'),
  );

  const bin = resolveBinary(loadEngines().engines[invocation.engine]);
  process.stderr.write(`실행   ${bin} ${invocation.argv.join(' ')}\n\n`);
  if (dryRun) return;

  const child = spawn(bin, [...invocation.argv], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
