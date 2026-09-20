/**
 * v1 셸의 최소판 (PLAN S1~S3). TUI 는 S5다.
 *
 *   node src/shell/cli.ts "<작업>" [--task R01] [--effort high] [--reviewer-effort high]
 *        [--gate irreversibleChange] [--classify-llm] [--run] [--timeout 600] [--raw]
 *
 * 기본은 **배정 제시까지**다 (SPEC §4-4 승인 게이트). 실제 실행은 `--run` 으로만 한다.
 */
import { readFileSync } from 'node:fs';
import { loadMatrix } from '../data/matrix.ts';
import { loadEngines } from '../data/engines.ts';
import { loadLimits } from '../data/limits.ts';
import { createAdapter } from '../adapters/engine.ts';
import { createExecutor } from '../core/executor.ts';
import { PingpongSession } from '../core/modes/pingpong.ts';
import { runLoop } from '../core/modes/loop.ts';
import { runGraph, type GraphNode } from '../core/modes/graph.ts';
import { assign } from '../core/assign.ts';
import { appendDecision, decisionLogPath } from '../core/decision-log.ts';
import { firstLine, secondLine } from '../core/decide.ts';
import { storeRun } from '../core/run-store.ts';
import { reportError, reportNotice } from '../core/report.ts';
import { collect, type Evidence } from '../core/evidence.ts';
import { changedFiles, loadEvidenceFile, runCommand } from '../core/evidence-gather.ts';
import { GATE_CHECKS, parseGateCheck, type GateSignals } from '../core/gatekeeper.ts';
import { classifyWithModel } from '../core/classify-llm.ts';
import { route } from '../core/pipeline.ts';
import type { Effort } from '../data/matrix.ts';

type Mode = 'once' | 'pingpong' | 'loop' | 'graph';

interface Parsed {
  task: string;
  mode: Mode;
  maxIterations?: number;
  budgetUsd?: number;
  graphFile?: string;
  verify: { cmd: string; phase?: string }[];
  evidenceFile?: string;
  crashTest: boolean;
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
       [--gate <${GATE_CHECKS.join('|')}>]... [--classify-llm] [--run] [--timeout 600] [--raw]
       [--mode once|pingpong|loop|graph] [--max-iterations N] [--budget 20] [--graph <nodes.json>]
       [--verify "[phase:]<명령>"]... [--evidence <file.json>] [--crash-test]`;

function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const parsed: Parsed = { task: '', mode: 'once', gate: {}, verify: [], crashTest: false, classifyLlm: false, run: false, raw: false, timeoutMs: 900_000 };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg ?? ''} 에 값이 없다.`);
      i += 1;
      return next;
    };

    switch (arg) {
      case '--mode': parsed.mode = value() as Mode; break;
      case '--max-iterations': parsed.maxIterations = Number(value()); break;
      case '--budget': parsed.budgetUsd = Number(value()); break;
      case '--graph': parsed.graphFile = value(); break;
      case '--verify': {
        // `phase:명령` 이면 단계를 붙인다 (R05 before/after, R06 reproduce/fix/regress 용).
        const v = value();
        const [head, ...rest] = v.split(':');
        parsed.verify.push(
          rest.length > 0 && head !== undefined && /^[a-z-]+$/.test(head)
            ? { cmd: rest.join(':'), phase: head }
            : { cmd: v },
        );
        break;
      }
      case '--evidence': parsed.evidenceFile = value(); break;
      case '--crash-test': parsed.crashTest = true; break;
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

  // 크래시 리포터 자가 검증 — 디버그 경로는 프로덕션 빌드에도 남긴다 (hs-00-core 관찰가능성).
  if (args.crashTest) {
    const r = reportError('cli', 'crash-test', new Error('의도적 크래시 — 리포팅 경로 자가 검증'));
    process.stderr.write(`${r.display}\n크래시 리포팅 경로가 살아 있다 (severity=${r.severity}).\n`);
    process.exitCode = 3;
    return;
  }
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
    // 정상 비즈니스 상태다 — notice 로 내린다 (PLAN S6-4).
    const note = reportNotice('pipeline', 'unclassified', result.message);
    process.stderr.write(`${note.display}\n  --classify-llm 으로 저비용 모델 분류를 시도할 수 있다.\n`);
    process.exitCode = 1;
    return;
  }

  if (result.stage === 'direct') {
    // 그냥 "직접"으로 간 기본 경로는 **결정 로그에 남기지 않는다** (SPEC §8).
    const note = reportNotice('gatekeeper', 'gate-direct', '§1 하한선에 걸렸다. 엔진을 띄우지 않는다.');
    process.stderr.write(
      [`판정   ② 유지 — ${note.message}`, ...result.reasons.map((r) => `       · ${r}`), ''].join('\n'),
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

  const limits = loadLimits();
  const budgetUsd = args.budgetUsd ?? limits.budgetUsd;
  const execute = createExecutor(catalog, process.cwd(), args.timeoutMs);

  if (args.mode === 'pingpong') {
    // 자율 실행이 아니다 (D-015). 한 턴만 돌리고 다음 제안을 남긴 뒤 사용자에게 돌려준다.
    const session = new PingpongSession(matrix, plan, execute, budgetUsd);
    const turn = await session.turn({ prompt: args.task, side: 'primary' });
    process.stdout.write(`${turn.text}\n`);
    process.stderr.write(`\n${session.journal.render()}\n누적   ${turn.budget}\n제안   ${turn.suggestion}\n`);
    return;
  }

  if (args.mode === 'loop') {
    const maxIterations = args.maxIterations ?? limits.maxIterations;
    // 위에 찍힌 비용은 **1사이클**이다. 루프는 최대 maxIterations 번 돈다 —
    // 실행 전에 최악값을 보여주지 않으면 "실행 전 비용 표시"가 거짓말이 된다.
    const worst = Math.min(plan.cost.totalUsd * maxIterations, budgetUsd);
    process.stderr.write(
      `상한   최대 ${maxIterations}사이클 · 최악 $${worst.toFixed(2)}(추정, 상한 $${budgetUsd} 에서 강제 중단)\n\n`,
    );
    const result = await runLoop(
      matrix,
      plan,
      execute,
      {
        plan: (ctx) => (ctx.iteration === 1 ? args.task : `${args.task} — 직전 사이클의 지적을 반영하라`),
        // Evaluator 는 reviewer 슬롯이 돈다 (D-003). 판정은 기계적으로 읽는다.
        evaluate: async (_ctx, output) => {
          const check = await execute(
            plan.slots.reviewer,
            `다음 산출물이 목표 "${args.task}" 를 충족하면 PASS, 아니면 FAIL 만 한 줄로 답하라.\n\n${output}`,
          );
          return { passed: /\bPASS\b/i.test(check.text), verification: `reviewer ${plan.slots.reviewer.label}: ${check.text.slice(0, 80)}` };
        },
        stop: (_ctx, verdict) => verdict.passed,
        recover: () => 'abort',
      },
      { goal: args.task, maxIterations, budgetUsd },
    );
    process.stderr.write(
      `\n${result.journal.render()}\n중단   ${result.stopReason} · ${result.iterations}회\n누적   ${result.budget.summary()}\n`,
    );
    if (result.journal.unverified.length > 0) {
      process.stderr.write(`경고   검증 기록이 빈 사이클 ${result.journal.unverified.length}건 — "통과"가 아니다.\n`);
    }
    if (result.stopReason !== 'goal-reached') process.exitCode = 1;
    return;
  }

  if (args.mode === 'graph') {
    if (!args.graphFile) throw new Error('--mode graph 에는 --graph <nodes.json> 이 필요하다.');
    const spec = JSON.parse(readFileSync(args.graphFile, 'utf8')) as {
      nodes: { id: string; prompt: string; task: string; dependsOn?: string[]; writes?: string[]; onFailure?: GraphNode['onFailure'] }[];
    };
    const nodes: GraphNode[] = spec.nodes.map((n) => {
      const row = matrix.assignments.find((a) => a.id === n.task);
      if (!row) throw new Error(`${n.id}: 그런 업무 행이 없다: ${n.task}`);
      return {
        id: n.id,
        prompt: n.prompt,
        plan: assign(matrix, catalog, row),
        dependsOn: n.dependsOn ?? [],
        writes: n.writes ?? [],
        onFailure: n.onFailure ?? 'skip-dependents',
      };
    });
    // 그래프의 비용은 위에 찍힌 분류 결과가 아니라 **노드별 배정의 합**이다.
    // 실행 전에 노드별로 보여준다 (SPEC §7).
    const total = nodes.reduce((sum, n) => sum + n.plan.cost.primaryUsd, 0);
    process.stderr.write(
      [
        '그래프 노드별 예상 비용 (primary 슬롯 기준, AA 추정):',
        ...nodes.map((n) => `       ${n.id.padEnd(10)} ${n.plan.assignment.id} ${n.plan.slots.primary.label}·${n.plan.slots.primary.effort}  $${n.plan.cost.primaryUsd}`),
        `       ${'합계'.padEnd(10)} $${total.toFixed(2)} (상한 $${budgetUsd} 에서 강제 중단)`,
        '',
      ].join('\n'),
    );

    const result = await runGraph(matrix, nodes, execute, { maxNodes: limits.maxNodes, budgetUsd });
    process.stderr.write(
      `\n${result.journal.render()}\n묶음   ${result.batches.map((b) => b.join('+')).join(' → ')}\n` +
        `건너뜀 ${result.skipped.join(', ') || '없음'}\n중단   ${result.stopReason}\n누적   ${result.budget.summary()}\n`,
    );
    if (result.stopReason !== 'completed') process.exitCode = 1;
    return;
  }

  // --mode once (기본): primary 슬롯 1회. reviewer 왕복은 --mode pingpong|loop 다.
  // 1차 결정 로그 — 배정을 확정한 **이 시점에** 남긴다 (SPEC §8).
  const decision = firstLine(matrix, plan, args.task, reason);
  appendDecision(decision);
  process.stderr.write(`결정   ${decision.id} ${decision.branch}/${decision.tier} → ${decisionLogPath()}\n`);

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

  // 원시 로그를 먼저 보존한다 — 이후 단계가 터져도 원본은 남는다.
  let stored = '';
  try {
    stored = storeRun(decision.id, 1, primary.label, {
      rawStdout: run.rawStdout,
      rawStderr: run.rawStderr,
      meta: { outcome: run.outcome, exitCode: run.exitCode, durationMs: run.durationMs, usage: run.usage, costUsd: run.costUsd, modelId: primary.modelId },
    }).dir;
  } catch (error) {
    // catch 후 무동작 금지 — 실패에는 사용자에게 보이는 상태가 있어야 한다.
    process.stderr.write(`${reportError('run-store', 'persist', error).display}\n`);
  }

  // 증거 수집 (SPEC §5). 운영 기준이 요구하는 증거가 모였을 때만 완료다 (PRD G4).
  const evidence: Evidence[] = [];
  for (const v of args.verify) evidence.push(runCommand(v.cmd, process.cwd(), v.phase));
  if (args.verify.length > 0) evidence.push(changedFiles());
  if (args.evidenceFile) {
    try {
      evidence.push(...loadEvidenceFile(args.evidenceFile));
    } catch (error) {
      process.stderr.write(`${reportError('evidence', 'load', error).display}\n`);
    }
  }
  const report = collect(plan.assignment, evidence);

  process.stderr.write(
    [
      '',
      `증거   ${report.summary}`,
      ...report.accepted.map((e) => `       + ${e.kind}${e.kind === 'command' ? ` \`${e.cmd}\` exit=${e.exitCode}` : ''}`),
      ...report.missing.map((m) => `       - 없음: ${m}`),
      ...report.rejected.map((r) => `       ! 거절(${r.evidence.kind}): ${r.why}`),
    ].join('\n') + '\n',
  );

  // 2차 결정 로그 — **같은 id 로 append** 한다. 갱신이 아니다.
  // 증거가 모였을 때만 ok 다. "성공했습니다"는 증거가 아니다 (SPEC §5).
  const outcome = run.outcome !== 'ok' ? 'wrong' : report.satisfied ? 'ok' : 'unverified';
  appendDecision(
    secondLine(
      decision,
      outcome,
      [
        stored ? `원시 로그 ${stored}` : '',
        `운영 기준: ${plan.assignment.operatingCriterion}`,
        report.satisfied ? `증거 ${report.accepted.length}건 충족` : `증거 미충족: ${report.missing.join(' / ')}`,
      ]
        .filter(Boolean)
        .join(' · '),
    ),
  );
  process.stdout.write(`${args.raw ? run.rawStdout : run.text}\n`);
  process.stderr.write(
    `\n결과   ${run.outcome} · ${run.durationMs}ms` +
      (run.usage ? ` · in ${run.usage.inputTokens} / out ${run.usage.outputTokens}` : '') +
      (run.costUsd !== undefined ? ` · $${run.costUsd.toFixed(4)}` : '') +
      (run.unparsedLines.length ? ` · 파싱 실패 ${run.unparsedLines.length}줄` : '') +
      `\n결정   ${decision.id} 2차 append 완료 (outcome=${outcome})` +
      (stored ? `\n원본   ${stored}` : '') +
      `\nreviewer ${reviewer.label} 왕복이 필요하면 --mode pingpong 또는 --mode loop 다.\n`,
  );
  if (run.outcome !== 'ok') process.exitCode = 1;
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
