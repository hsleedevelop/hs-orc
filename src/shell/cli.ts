/**
 * v1 셸의 최소판 (PLAN S1~S3). TUI 는 S5다.
 *
 *   hs-orc "<작업>" [--task R01] [--effort high] [--reviewer-effort high]
 *        [--gate irreversibleChange] [--no-classify-llm] [--run] [--write] [--timeout 600] [--raw]
 *
 * 기본은 **배정 제시까지**다 (SPEC §4-4 승인 게이트). 실제 실행은 `--run` 으로만 한다.
 */
import { readFileSync } from 'node:fs';
import { loadMatrix } from '../data/matrix.ts';
import { loadEngines } from '../data/engines.ts';
import { loadLimits } from '../data/limits.ts';
import { createExecutor } from '../core/executor.ts';
import { PingpongSession } from '../core/modes/pingpong.ts';
import { runLoop } from '../core/modes/loop.ts';
import { parseGraphSpec, runGraph, type GraphSpec } from '../core/modes/graph.ts';
import { appendDecision, decisionLogPath } from '../core/decision-log.ts';
import { firstLine, secondLine } from '../core/decide.ts';
import { storeRun } from '../core/run-store.ts';
import { reportError, reportNotice } from '../core/report.ts';
import { collect, type Evidence } from '../core/evidence.ts';
import { readUnclassified, recordUnclassified, suggestRows } from '../core/unclassified.ts';
import { defaultVerify } from '../data/verify.ts';
import { depStatus } from './deps.ts';
import { parseVerdict, reviewPrompt, runDuo } from '../core/duo.ts';
import { Budget } from '../core/budget.ts';
import { changedFiles, loadEvidenceFile, runCommand } from '../core/evidence-gather.ts';
import { GATE_CHECKS, parseGateCheck, type GateSignals } from '../core/gatekeeper.ts';
import { routeWithFallback } from '../core/pipeline.ts';
import type { Effort } from '../data/matrix.ts';

type Mode = 'once' | 'pingpong' | 'loop' | 'graph';

interface Parsed {
  task: string;
  mode: Mode;
  maxIterations?: number;
  budgetUsd?: number;
  /** 이 실행 한정 토큰 상한. 없으면 `limits.tokenBudget` (D-035) — 조용히 커지는 상한은 없다. */
  tokenBudget?: number;
  graphFile?: string;
  verify: { cmd: string; phase?: string }[];
  evidenceFile?: string;
  crashTest: boolean;
  skipReviewer: boolean;
  side: 'primary' | 'reviewer';
  taskId?: string;
  primaryEffort?: Effort;
  reviewerEffort?: Effort;
  gate: GateSignals;
  classifyLlm: boolean;
  run: boolean;
  write: boolean;
  raw: boolean;
  timeoutMs: number;
}

const USAGE = `사용법: hs-orc "<작업>" [--task R01] [--effort high] [--reviewer-effort high]
       [--gate <${GATE_CHECKS.join('|')}>]... [--no-classify-llm] [--run] [--write] [--timeout 600] [--raw]
       [--mode once|pingpong|loop|graph] [--max-iterations N] [--budget 20] [--token-budget N] [--graph <nodes.json>]
       (그래프 스펙 예제: examples/graph-nodes.json · --token-budget 0 = 토큰 상한 없음, D-035)
       [--verify "[phase:]<명령>"]... [--evidence <file.json>] [--crash-test]
       [--no-reviewer] [--side primary|reviewer]`;

function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const parsed: Parsed = { task: '', mode: 'once', gate: {}, verify: [], crashTest: false, skipReviewer: false, side: 'primary', classifyLlm: true, run: false, write: false, raw: false, timeoutMs: 900_000 };

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
      case '--token-budget': {
        // 조용히 커지는 상한은 없다(D-035) — 잘못된 값은 그 자리에서 던진다.
        // `Number("")` 도 `Number("  ")` 도 0 이다 — 빈 값이 조용히 "상한 없음"으로 통과하면
        // D-035 가 막으려는 fail-open 그 자체다. 변환 전에 원본 문자열을 정규식으로 먼저 본다:
        // 순수 10진 정수만 통과한다(공백·부호·소수점·지수 표기 전부 거절).
        const v = value();
        if (!/^\d+$/.test(v)) {
          throw new Error(`--token-budget 은 0 이상의 정수여야 한다: ${v}`);
        }
        parsed.tokenBudget = Number(v);
        break;
      }
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
      case '--no-reviewer': parsed.skipReviewer = true; break;
      case '--side': parsed.side = value() as 'primary' | 'reviewer'; break;
      case '--task': parsed.taskId = value(); break;
      case '--effort': parsed.primaryEffort = value() as Effort; break;
      case '--reviewer-effort': parsed.reviewerEffort = value() as Effort; break;
      case '--gate': parsed.gate[parseGateCheck(value())] = true; break;
      // Q8/D-026: 자동 폴백이 기본이다. 옛 플래그는 계속 받는다 — 지우면 스크립트에서
      // 그 낱말이 **작업 문자열로 섞여 들어간다**(조용한 오작동).
      case '--classify-llm': parsed.classifyLlm = true; break;
      case '--no-classify-llm': parsed.classifyLlm = false; break;
      case '--run': parsed.run = true; break;
      case '--write': parsed.write = true; break;
      case '--raw': parsed.raw = true; break;
      case '--timeout': parsed.timeoutMs = Number(value()) * 1000; break;
      default:
        if (arg === undefined) break;
        // `--오타` 가 조용히 **작업 문자열**이 되던 자리다. 던진다 (hs-00-core 조용한 폴백 금지).
        if (arg.startsWith('--')) throw new Error(`모르는 옵션이다: ${arg}\n  ${USAGE}`);
        positional.push(arg);
    }
  }

  parsed.task = positional.join(' ').trim();
  if (!parsed.task) throw new Error(`작업 문자열이 없다.\n  ${USAGE}`);
  return parsed;
}

/**
 * 토큰 쪽이 막았을 때만 --token-budget 을 안내한다 — $ 상한이 막았으면 --budget 얘기다 (D-035).
 * once·pingpong·loop·graph 네 자리가 전부 같은 문구를 썼다 — 여기 하나로 합친다.
 */
function printTokenCapHint(budget: Budget): void {
  if (budget.tokensExceeded()) {
    process.stderr.write(`안내   토큰 상한(${budget.limitTokens})에 닿았다 — 이번 실행만 올리려면 --token-budget N.\n`);
  }
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

  // D-034: 분류 전에 이 실행의 예산을 만든다 — 분류 폴백부터 진행 방식까지 **같은 예산에 합산**한다.
  // D-035: 토큰 상한은 진행 방식과 무관하게 같은 값을 쓴다 — pingpong·loop·graph 도 once 와 같다.
  // once 만 상한을 받던 D-034 의 빈틈을 여기서 닫는다. 올리거나 내리는 것은 --token-budget 으로만,
  // 조용히 커지는 상한은 없다.
  const limits = loadLimits();
  const budgetUsd = args.budgetUsd ?? limits.budgetUsd;
  const tokenBudget = args.tokenBudget ?? limits.tokenBudget;
  const budget = new Budget(budgetUsd, tokenBudget);

  // 분류·하한선·배정 + LLM 폴백. 순서의 소유자는 Core 다 (SPEC §4, D-026).
  const routed = await routeWithFallback(matrix, catalog, args.task, { ...options, classifyLlm: args.classifyLlm, budget });
  const result = routed.result;
  // 폴백이 돌았으면 **반드시 보여준다** — 말없이 도는 유료 호출은 없다.
  if (routed.fallback) {
    const line = `분류   ${routed.fallback.line}`;
    process.stderr.write(
      routed.fallback.outcome === 'failed' || routed.fallback.outcome === 'skipped'
        ? `${reportNotice('pipeline', 'classify-fallback', routed.fallback.line).display}\n`
        : `${line}\n`,
    );
  }

  if (result.stage === 'unclassified') {
    // 정상 비즈니스 상태다 — notice 로 내린다 (PLAN S6-4).
    const note = reportNotice('pipeline', 'unclassified', result.message);
    process.stderr.write(
      `${note.display}\n  ${args.classifyLlm ? 'LLM 폴백도 맞는 행을 고르지 못했다.' : 'LLM 폴백은 --no-classify-llm 으로 꺼져 있다.'}\n`,
    );

    // 누적만 한다. 행 추가는 원본 편집으로만 (D-022).
    recordUnclassified(args.task);
    for (const s of suggestRows(readUnclassified())) process.stderr.write(`\n${s.message}\n`);

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
  const deps = depStatus(process.cwd());
  process.stderr.write(
    [
      `업무   ${plan.assignment.id} ${plan.assignment.task}  (${reason})`,
      `배정   primary  ${primary.label} · ${primary.effort}  → ${primary.engine} / ${primary.modelId}`,
      `       reviewer ${reviewer.label} · ${reviewer.effort}  → ${reviewer.engine} / ${reviewer.modelId}`,
      `기준   ${plan.assignment.operatingCriterion}`,
      `비용   $${plan.cost.totalUsd} = primary $${plan.cost.primaryUsd} + reviewer $${plan.cost.reviewerUsd}  [${plan.cost.grade.toUpperCase()}]`,
      `       ${plan.cost.note}`,
      // 외부 쓰기는 승인 **전에** 보여준다 — 비용과 같은 이유다 (PLAN "사람에게 올리는 조건").
      args.write
        ? `쓰기   primary ${primary.label} 이 ${process.cwd()} 안의 파일을 고칠 수 있다 (--write). reviewer 는 읽기 전용이다.`
        : `쓰기   꺼짐 — 두 슬롯 다 읽기 전용이다. 파일을 고치게 하려면 --write 다.`,
      // 의존성이 없으면 검증 명령도, primary 가 스스로 돌리는 test 도 성립하지 않는다.
      // **실행 전에** 알려야 한다 — 모르고 돌리면 시간과 돈을 태우고 나서야 막힌다 (첫 실사용).
      ...(deps.kind === 'missing'
        ? [`의존성 없음 — ${deps.manifest} 는 있는데 node_modules 가 없다. 검증은 \`${deps.install}\` 뒤에 의미가 있다.`]
        : []),
      '',
    ].join('\n'),
  );

  if (!args.run) {
    process.stderr.write('제시만 했다. 실제 실행은 --run 이다 (승인 게이트).\n');
    return;
  }

  const execute = createExecutor(catalog, process.cwd(), args.timeoutMs, { write: args.write });

  if (args.mode === 'pingpong') {
    // 자율 실행이 아니다 (D-015). 한 턴만 돌리고 다음 제안을 남긴 뒤 사용자에게 돌려준다.
    // 분류 폴백이 이미 과금한 같은 budget 을 넘긴다 — 합산이다 (D-034).
    const session = new PingpongSession(matrix, plan, execute, budgetUsd, 0, budget);
    const turn = await session.turn({ prompt: args.task, side: args.side });
    process.stdout.write(`${turn.text}\n`);
    process.stderr.write(`\n${session.journal.render()}\n누적   ${turn.budget}\n제안   ${turn.suggestion}\n`);
    printTokenCapHint(budget);
    return;
  }

  if (args.mode === 'loop') {
    const maxIterations = args.maxIterations ?? limits.maxIterations;
    // 위에 찍힌 비용은 **1사이클**이다. 루프는 최대 maxIterations 번 돈다 —
    // 실행 전에 최악값을 보여주지 않으면 "실행 전 비용 표시"가 거짓말이 된다.
    const worst = Math.min(plan.cost.totalUsd * maxIterations, budgetUsd);
    process.stderr.write(
      `상한   최대 ${maxIterations}사이클 · 최악 $${worst.toFixed(2)}(추정, 상한 $${budgetUsd} 에서 강제 중단)` +
        ` · 토큰 ${tokenBudget} (0 = 없음)\n\n`,
    );
    // reviewer 실행 자체가 죽으면 재시도하지 않는다 — 망가진 엔진에 primary 를 반복해 태우지 않는다 (D-036).
    let reviewerBroken = false;
    const result = await runLoop(
      matrix,
      plan,
      execute,
      {
        // 재시도면 직전 reviewer 의 지적을 싣는다 — 사유 없는 재시도는 같은 실수를 반복한다 (D-036).
        plan: (ctx) =>
          ctx.feedback === undefined
            ? args.task
            : `${args.task}\n\n직전 사이클은 독립 검증을 통과하지 못했다. 검증자의 지적:\n${ctx.feedback}\n\n이 지적을 반영해 다시 수행하라.`,
        // Evaluator 는 reviewer 슬롯이 돈다 (D-003). 형식·판정은 once 의 독립 리뷰와 같다 —
        // 마지막 줄 PASS/FAIL, 못 읽으면 unknown 이고 통과로 봐주지 않는다.
        evaluate: async (_ctx, output) => {
          const check = await execute(plan.slots.reviewer, reviewPrompt(plan, args.task, output));
          reviewerBroken = !check.ok;
          const verdict = check.ok ? parseVerdict(check.text) : 'unknown';
          return {
            passed: verdict === 'pass',
            verification:
              `reviewer ${plan.slots.reviewer.label} → ${verdict.toUpperCase()}` +
              (check.ok ? '' : ` (실행 실패: ${check.text.slice(0, 80)})`),
            ...(verdict === 'pass' || !check.ok ? {} : { reason: check.text.slice(0, 4000) }),
            cost: check,
          };
        },
        stop: (_ctx, verdict) => verdict.passed,
        recover: () => (reviewerBroken ? 'escalate' : 'retry'),
      },
      // 분류 폴백이 이미 과금한 같은 budget 을 넘긴다 — 합산이다 (D-034).
      { goal: args.task, maxIterations, budgetUsd, budget },
    );
    process.stderr.write(
      `\n${result.journal.render()}\n중단   ${result.stopReason} · ${result.iterations}회\n누적   ${result.budget.summary()}\n`,
    );
    if (result.journal.unverified.length > 0) {
      process.stderr.write(`경고   검증 기록이 빈 사이클 ${result.journal.unverified.length}건 — "통과"가 아니다.\n`);
    }
    printTokenCapHint(result.budget);
    if (result.stopReason !== 'goal-reached') process.exitCode = 1;
    return;
  }

  if (args.mode === 'graph') {
    if (!args.graphFile) throw new Error('--mode graph 에는 --graph <nodes.json> 이 필요하다.');
    // 형식의 소유자는 Core 다. 예제는 examples/graph-nodes.json.
    const nodes = parseGraphSpec(matrix, catalog, JSON.parse(readFileSync(args.graphFile, 'utf8')) as GraphSpec);
    // 그래프의 비용은 위에 찍힌 분류 결과가 아니라 **노드별 배정의 합**이다.
    // 실행 전에 노드별로 보여준다 (SPEC §7).
    const total = nodes.reduce((sum, n) => sum + n.plan.cost.primaryUsd, 0);
    process.stderr.write(
      [
        '그래프 노드별 예상 비용 (primary 슬롯 기준, AA 추정):',
        ...nodes.map((n) => `       ${n.id.padEnd(10)} ${n.plan.assignment.id} ${n.plan.slots.primary.label}·${n.plan.slots.primary.effort}  $${n.plan.cost.primaryUsd}`),
        `       ${'합계'.padEnd(10)} $${total.toFixed(2)} (상한 $${budgetUsd} 에서 강제 중단) · 토큰 ${tokenBudget} (0 = 없음)`,
        '',
      ].join('\n'),
    );

    // 분류 폴백이 이미 과금한 같은 budget 을 넘긴다 — 합산이다 (D-034).
    const result = await runGraph(matrix, nodes, execute, { maxNodes: limits.maxNodes, budgetUsd, budget });
    process.stderr.write(
      `\n${result.journal.render()}\n묶음   ${result.batches.map((b) => b.join('+')).join(' → ')}\n` +
        `건너뜀 ${result.skipped.join(', ') || '없음'}\n중단   ${result.stopReason}\n누적   ${result.budget.summary()}\n`,
    );
    printTokenCapHint(result.budget);
    if (result.stopReason !== 'completed') process.exitCode = 1;
    return;
  }

  // --mode once (기본): primary 슬롯 1회. reviewer 왕복은 --mode pingpong|loop 다.
  // 1차 결정 로그 — 배정을 확정한 **이 시점에** 남긴다 (SPEC §8).
  const decision = firstLine(matrix, plan, args.task, reason);
  appendDecision(decision);
  process.stderr.write(`결정   ${decision.id} ${decision.branch}/${decision.tier} → ${decisionLogPath()}\n`);

  // **두 슬롯을 실제로 돌린다** (D-009). primary 만 돌리면 이 제품은 단일 엔진 선택기다.
  // 분류 폴백이 이미 과금한 같은 budget 을 그대로 쓴다 — 합산이다 (D-034).
  const duo = await runDuo(matrix, plan, execute, args.task, budget, { skipReviewer: args.skipReviewer });
  const run = {
    outcome: duo.primary.ok ? ('ok' as const) : ('error' as const),
    text: duo.primary.text,
    exitCode: null,
    durationMs: duo.primary.durationMs,
    rawStdout: duo.primary.text,
    rawStderr: '',
    costUsd: duo.primary.actualUsd,
    unparsedLines: [] as string[],
  };

  if (args.skipReviewer) {
    process.stderr.write(`검증   reviewer ${reviewer.label} 생략됨 (--no-reviewer) — 독립 검증 없이 닫는다\n`);
  } else if (duo.review) {
    process.stderr.write(
      `\n검증   reviewer ${reviewer.label}·${reviewer.effort} → ${duo.verdict.toUpperCase()}\n` +
        `${duo.review.text.slice(0, 600)}\n`,
    );
  } else if (duo.primary.ok) {
    process.stderr.write(`검증   reviewer 를 시작하지 못했다 (비용 상한 또는 primary 실패)\n`);
  }
  // 어느 분기를 탔든 상관없이 본다 — reviewer 가 실제로 돌아서 그 토큰이 합산 후에야 상한을
  // 넘긴 경우(duo.review 분기)도 있다. self-gates on tokensExceeded() 라 중복 호출도 안전하다.
  printTokenCapHint(budget);

  // 원시 로그를 먼저 보존한다 — 이후 단계가 터져도 원본은 남는다.
  let stored = '';
  try {
    stored = storeRun(decision.id, 1, primary.label, {
      rawStdout: duo.primary.rawStdout,
      rawStderr: duo.primary.rawStderr,
      meta: { slot: 'primary', outcome: run.outcome, durationMs: duo.primary.durationMs, costUsd: duo.primary.actualUsd, modelId: primary.modelId },
    }).dir;
    // reviewer 산출물도 실행별로 남긴다 — 독립 검증 기록이 사라지면 "검증했다"를 증명할 수 없다.
    if (duo.review) {
      storeRun(decision.id, 2, reviewer.label, {
        rawStdout: duo.review.rawStdout,
        rawStderr: duo.review.rawStderr,
        meta: { slot: 'reviewer', verdict: duo.verdict, durationMs: duo.review.durationMs, costUsd: duo.review.actualUsd, modelId: reviewer.modelId },
      });
    }
  } catch (error) {
    // catch 후 무동작 금지 — 실패에는 사용자에게 보이는 상태가 있어야 한다.
    process.stderr.write(`${reportError('run-store', 'persist', error).display}\n`);
  }

  // 증거 수집 (SPEC §5). 운영 기준이 요구하는 증거가 모였을 때만 완료다 (PRD G4).
  // 프로젝트가 선언한 기본 검증 + 이번 실행의 --verify. 추론은 없다 (SPEC §5).
  const declared = defaultVerify(plan.assignment.id);
  const verify = [...declared, ...args.verify];
  if (declared.length > 0) {
    process.stderr.write(`검증   data/verify.json 선언 ${declared.length}건: ${declared.map((v) => v.cmd).join(' · ')}\n`);
  }
  const evidence: Evidence[] = [...duo.evidence];
  for (const v of verify) evidence.push(runCommand(v.cmd, process.cwd(), v.phase));
  if (verify.length > 0) evidence.push(changedFiles());
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
      (run.costUsd !== undefined ? ` · $${run.costUsd.toFixed(4)}` : '') +
      (run.unparsedLines.length ? ` · 파싱 실패 ${run.unparsedLines.length}줄` : '') +
      `\n누적   ${budget.summary()}` +
      `\n결정   ${decision.id} 2차 append 완료 (outcome=${outcome})` +
      (stored ? `\n원본   ${stored}` : '') +
      '\n',
  );
  if (run.outcome !== 'ok') process.exitCode = 1;
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
