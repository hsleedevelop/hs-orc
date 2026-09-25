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
import { FAILING_PHASES, collect, contradiction, notRun, outcomeOf, type Evidence } from '../core/evidence.ts';
import { readUnclassified, recordUnclassified, suggestRows } from '../core/unclassified.ts';
import { declaredTests, defaultVerify } from '../data/verify.ts';
import { depStatus } from './deps.ts';
import { parseVerdict, reviewPrompt, runDuo } from '../core/duo.ts';
import { Budget } from '../core/budget.ts';
import { changedFiles, loadEvidenceFile, runCommand, snapshotTests, testChanges, type TestSnapshot } from '../core/evidence-gather.ts';
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
  /** 작업 전부터 실패하는 검증 명령까지 고치는 것을 범위에 넣는다 (D-042). 없으면 기준선 실패는 사람에게 올린다. */
  fixRedBaseline: boolean;
  raw: boolean;
  timeoutMs: number;
}

const USAGE = `사용법: hs-orc "<작업>" [--task R01] [--effort high] [--reviewer-effort high]
       [--gate <${GATE_CHECKS.join('|')}>]... [--no-classify-llm] [--run] [--write] [--timeout 600] [--raw]
       [--mode once|pingpong|loop|graph] [--max-iterations N] [--budget 20] [--token-budget N] [--graph <nodes.json>]
       (그래프 스펙 예제: examples/graph-nodes.json · --token-budget 0 = 토큰 상한 없음, D-035)
       [--verify "[phase:]<명령>"]... [--evidence <file.json>] [--crash-test]
       [--no-reviewer] [--side primary|reviewer] [--fix-red-baseline]`;

function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const parsed: Parsed = { task: '', mode: 'once', gate: {}, verify: [], crashTest: false, skipReviewer: false, side: 'primary', classifyLlm: true, run: false, write: false, fixRedBaseline: false, raw: false, timeoutMs: 900_000 };

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
      case '--fix-red-baseline': parsed.fixRedBaseline = true; break;
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
  // 기준선은 --write loop 에서만 돈다 — 다른 자리에서 조용히 무시되는 플래그는 두지 않는다.
  if (parsed.fixRedBaseline && !(parsed.mode === 'loop' && parsed.write)) {
    throw new Error('--fix-red-baseline 은 --mode loop --write 에서만 의미가 있다.');
  }
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
    // 상한은 사이클을 **시작하기 전에** 본다 — 상한 직전에 시작한 사이클 하나만큼은 넘을 수 있다 (D-036 리뷰).
    const worst = Math.min(plan.cost.totalUsd * maxIterations, budgetUsd + plan.cost.totalUsd);
    process.stderr.write(
      `상한   최대 ${maxIterations}사이클 · 최악 $${worst.toFixed(2)}(추정, 상한 $${budgetUsd} 을 넘으면 다음 사이클을 시작하지 않는다)` +
        ` · 토큰 ${tokenBudget} (0 = 없음)\n`,
    );
    // D-040: reviewer 는 읽기 전용이라 테스트를 못 돌린다 — 선언된 검증 명령은 Core 가 돌린다(once 와 같은 선언).
    // 읽기 전용이면 primary 의 diff 가 적용되지 않아 원본을 검사하게 되므로 돌리지 않고, 그렇다고 적는다.
    const verifyCmds = [...defaultVerify(plan.assignment.id), ...args.verify];
    const cmdLabel = (v: { cmd: string; phase?: string }): string => (v.phase ? `${v.phase}:${v.cmd}` : v.cmd);
    const verifyList = verifyCmds.map(cmdLabel).join(' · ');
    // D-045: phase 는 **언제** 돌리는가다. before·reproduce 는 변경 전의 사실이라 기준선에서 한 번(실패 기대),
    // 나머지(phase 없음·after·fix·regress…)는 변경 후의 사실이라 매 사이클 게이트(통과 기대)다.
    // 기대 exit 판단은 once 와 같은 contradiction() 이다 (D-043) — 표를 어느 시점에 대는지만 loop 가 정한다.
    const isPre = (v: { phase?: string }): boolean => v.phase !== undefined && FAILING_PHASES.has(v.phase);
    const preCmds = verifyCmds.filter(isPre);
    const postCmds = verifyCmds.filter((v) => !isPre(v));
    if (verifyCmds.length > 0) {
      process.stderr.write(
        args.write
          ? [
              ...(preCmds.length > 0 ? [`검증   변경 전(기준선) 1회: ${preCmds.map(cmdLabel).join(' · ')} — 실패해야 한다(재현)\n`] : []),
              ...(postCmds.length > 0
                ? [`검증   매 사이클 primary 뒤: ${postCmds.map(cmdLabel).join(' · ')} — 실패하면 reviewer 판정과 무관하게 FAIL\n`]
                : []),
            ].join('')
          : `검증   읽기 전용이라 검증 명령(${verifyList})을 실행하지 않는다 — PASS 는 테스트 미검증이다. 실행하려면 --write.\n`,
      );
    }
    // D-042: phase 없는 명령을 작업 **전에** 한 번 돌린다. 이미 실패하면 그 실패를 고치는 것이 작업 범위인지
    // 제품은 판단할 수 없다 — 엔진을 띄우기 전에 사람에게 올린다. 범위에 넣으려면 --fix-red-baseline.
    // after·fix·regress 는 변경 전에 실패하는 것이 정상이라 여기서 보지 않는다 (D-045).
    // D-048: 의존성이 없으면 검증 명령은 exit 1 로 "테스트 실패" 처럼 보인다 — after·fix·regress 는 기준선에서
    // 돌지 않아 사이클마다 FAIL → 재시도로 샌다. 이미 기계적으로 아는 사실이니 엔진 전에 멈춘다. 설치하면 풀린다.
    if (args.write && verifyCmds.length > 0 && deps.kind === 'missing') {
      process.stderr.write(
        [
          `중단   의존성 없음 — ${deps.manifest} 는 있는데 node_modules 가 없다. 검증 명령이 환경 오류로 실패한다. 엔진을 띄우지 않았다.`,
          `안내   \`${deps.install}\` 뒤에 다시 실행한다.`,
          '',
        ].join('\n'),
      );
      process.exitCode = 1;
      return;
    }
    const plainCmds = postCmds.filter((v) => v.phase === undefined);
    let reproduced = '';
    if (args.write && plainCmds.length + preCmds.length > 0) {
      const baseline = [...plainCmds, ...preCmds]
        .map((v) => runCommand(v.cmd, process.cwd(), v.phase))
        .flatMap((e) => (e.kind === 'command' ? [e] : []));
      process.stderr.write(`기준선 ${baseline.map((c) => `\`${cmdLabel(c)}\` exit=${c.exitCode}`).join(', ')}\n`);
      // D-046: 돌지 못한 명령(126·127·시그널·시간 초과)은 환경 문제다 — 모델도 --fix-red-baseline 도 고치지 못한다.
      const unrunnable = baseline.filter((c) => notRun(c.exitCode) !== null);
      if (unrunnable.length > 0) {
        process.stderr.write(
          [
            `중단   검증 명령을 실행할 수 없다 — 테스트 실패가 아니라 환경 문제다. 엔진을 띄우지 않았다.`,
            ...unrunnable.map((c) => `$ ${cmdLabel(c)} → exit ${c.exitCode} (${notRun(c.exitCode)})\n${c.output.slice(-1500)}`),
            `안내   PATH·설치·시간 제한을 확인한다.`,
            '',
          ].join('\n'),
        );
        process.exitCode = 1;
        return;
      }
      // D-045: 재현되지 않는 버그를 고치라고 시키는 것은 추측이다 — 우회 플래그 없이 사람에게 올린다.
      const notReproduced = baseline.filter((c) => c.phase !== undefined && contradiction(c) !== null);
      if (notReproduced.length > 0) {
        process.stderr.write(
          [
            `중단   재현되지 않는다 — 변경 전에 실패해야 하는 단계가 통과했다. 엔진을 띄우지 않았다.`,
            ...notReproduced.map((c) => `$ ${cmdLabel(c)} → exit ${c.exitCode}\n${c.output.slice(-1500)}`),
            `안내   재현 명령을 고친다 — 재현되지 않는 버그는 고칠 대상을 알 수 없다.`,
            '',
          ].join('\n'),
        );
        process.exitCode = 1;
        return;
      }
      reproduced = baseline
        .filter((c) => c.phase !== undefined)
        .map((c) => `$ ${cmdLabel(c)} (기준선 — 변경 전)\nexit=${c.exitCode}\n${c.output.slice(-1500)}`)
        .join('\n\n');
      const red = baseline.filter((c) => c.phase === undefined && c.exitCode !== 0);
      if (red.length > 0 && !args.fixRedBaseline) {
        process.stderr.write(
          [
            `중단   기준선 실패 — 작업 전부터 검증 명령이 실패한다. 엔진을 띄우지 않았다.`,
            ...red.map((c) => `$ ${c.cmd} → exit ${c.exitCode}\n${c.output.slice(-1500)}`),
            `안내   이 실패를 고치는 것까지 작업 범위면 --fix-red-baseline. 아니면 먼저 고치거나 검증 명령을 바꾼다.`,
            '',
          ].join('\n'),
        );
        process.exitCode = 1;
        return;
      }
      if (red.length > 0) process.stderr.write('       --fix-red-baseline — 기존 실패까지 고치는 것을 작업 범위로 둔다.\n');
    }
    // D-047: 선언된 기존 테스트는 줄 추가만 허용한다 — 게이트를 통과시키려는 약화를 막는다.
    const loopTestGlobs = declaredTests();
    let loopTestsBefore: TestSnapshot | undefined;
    if (args.write) {
      if (loopTestGlobs.length > 0) {
        loopTestsBefore = snapshotTests(loopTestGlobs);
        process.stderr.write(`검증   기존 테스트(${loopTestGlobs.join(' · ')})는 줄 추가만 허용 — 바뀌거나 지워지면 FAIL\n`);
      } else {
        process.stderr.write('검증   테스트 경로 선언이 없다(verify.json tests) — 기존 테스트 약화를 막지 않는다\n');
      }
    }
    process.stderr.write('\n');
    // reviewer 가 죽으면 망가진 엔진에 primary 를 반복해 태우지 않고 사람에게 올린다 (D-036).
    // primary 가 죽은 경우는 Core 가 채점 없이 올린다 (D-039).
    let reviewerBroken = false;
    // 사이클 중 검증 명령이 돌지 못하면 primary 가 고칠 수 없다 — 재시도로 상한까지 태우지 않고 올린다 (D-046).
    let verifyBroken = false;
    // D-049: 약화로 FAIL 한 다음 사이클도 기계적 FAIL(약화·명령 실패)이면 과제와 기존 테스트가 충돌하는 것이다 —
    // 모델은 약화 없이 풀 수 없다. 재시도로 상한까지 태우지 않고 사람에게 올린다. 첫 약화는 한 번 재시도한다(형식만 바꾼 실수일 수 있다).
    let weakenedLastCycle = false;
    let testConflict = false;
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
          const ran = args.write
            ? postCmds.map((v) => runCommand(v.cmd, process.cwd(), v.phase)).flatMap((e) => (e.kind === 'command' ? [e] : []))
            : [];
          const failed = ran.filter((c) => contradiction(c) !== null);
          const checks = args.write
            ? [ran.map((c) => `$ ${cmdLabel(c)}\nexit=${c.exitCode}\n${c.output.slice(-1500)}`).join('\n\n'), reproduced]
                .filter(Boolean)
                .join('\n\n') || undefined
            : verifyCmds.length > 0
              ? `primary 의 변경은 작업 트리에 적용되지 않았고 검증 명령(${verifyList})도 실행되지 않았다. 테스트가 통과한다고 가정하지 마라.`
              : undefined;
          const unrunnable = ran.filter((c) => notRun(c.exitCode) !== null);
          if (unrunnable.length > 0) {
            verifyBroken = true;
            return {
              passed: false,
              verification:
                `reviewer ${plan.slots.reviewer.label} 생략 — 검증 명령을 실행할 수 없다(환경)` +
                ` · ${unrunnable.map((c) => `\`${cmdLabel(c)}\` exit=${c.exitCode} (${notRun(c.exitCode)})`).join(', ')}`,
              reason: unrunnable.map((c) => `$ ${cmdLabel(c)} → exit ${c.exitCode}\n${c.output.slice(-1500)}`).join('\n\n').slice(0, 4000),
              reviewerSkipped: true,
            };
          }
          const tests = loopTestsBefore ? testChanges(loopTestsBefore, loopTestGlobs) : undefined;
          const weakened = tests?.weakened ?? [];
          const addedNote = tests && tests.added.length > 0 ? ` · 테스트 추가(허용): ${tests.added.join(', ')}` : '';
          // 명령 실패로 FAIL 이 이미 정해졌으면 reviewer 를 돌리지 않는다 — 사이클당 약 24만 토큰(D-036 실측)을 아낀다 (D-041).
          // 다음 사이클 지적은 명령 출력만으로 충분하다: 무엇이 깨졌는지가 기계적으로 나와 있다.
          if (failed.length > 0 || weakened.length > 0) {
            if (weakenedLastCycle) testConflict = true;
            weakenedLastCycle = weakened.length > 0;
            const failedBlock = failed.map((c) => `$ ${cmdLabel(c)} → exit ${c.exitCode}\n${c.output.slice(-1500)}`).join('\n\n');
            // 약화를 앞에 둔다 — 4000자 자르기에 먼저 잘리지 않게, 그리고 "테스트를 고쳐 통과" 가 답이 아님을 먼저 말한다.
            const weakBlock = weakened.length > 0
              ? `기존 테스트를 약하게 만들지 말고 코드를 고쳐라 (줄 추가만 허용):\n${weakened.map((w) => `- ${w}`).join('\n')}`
              : '';
            return {
              passed: false,
              verification:
                `reviewer ${plan.slots.reviewer.label} 생략 — ` +
                [weakened.length > 0 ? `기존 테스트 약화: ${weakened.join(', ')}` : '', failed.length > 0 ? '검증 명령 실패' : '']
                  .filter(Boolean)
                  .join(' · ') +
                (ran.length > 0 ? ` · 검증 명령 ${ran.map((c) => `\`${cmdLabel(c)}\` exit=${c.exitCode}`).join(', ')}` : '') +
                addedNote +
                (testConflict ? ' · 과제가 기존 테스트와 충돌한다 — 재시도하지 않는다' : ''),
              // 있는 블록만 빈 줄 하나로 잇는다 — 약화만 있을 때 지적 끝에 빈 줄이 겹치던 자리다 (D-047 실측).
              reason: [weakBlock, failedBlock ? `Core 가 실행한 검증 명령이 실패했다:\n${failedBlock}` : '']
                .filter(Boolean)
                .join('\n\n')
                .slice(0, 4000),
              reviewerSkipped: true,
            };
          }
          weakenedLastCycle = false; // 기계적 FAIL 이 끊겼다 — "연속" 이 아니다.
          const check = await execute(plan.slots.reviewer, reviewPrompt(plan, args.task, output, checks));
          if (!check.ok) reviewerBroken = true;
          const verdict = check.ok ? parseVerdict(check.text) : 'unknown';
          const passed = verdict === 'pass';
          return {
            passed,
            verification:
              `reviewer ${plan.slots.reviewer.label} → ${verdict.toUpperCase()}` +
              (check.ok ? '' : ` (실행 실패: ${check.text.slice(0, 80)})`) +
              (ran.length > 0
                ? ` · 검증 명령 ${ran.map((c) => `\`${cmdLabel(c)}\` exit=${c.exitCode}`).join(', ')}`
                : !args.write && verifyCmds.length > 0
                  ? ' · 테스트 미실행(읽기 전용)'
                  : '') +
              addedNote,
            ...(passed || !check.ok ? {} : { reason: check.text.slice(0, 4000) }),
            cost: check,
          };
        },
        stop: (_ctx, verdict) => verdict.passed,
        recover: () => (reviewerBroken || verifyBroken || testConflict ? 'escalate' : 'retry'),
      },
      // 분류 폴백이 이미 과금한 같은 budget 을 넘긴다 — 합산이다 (D-034).
      { goal: args.task, maxIterations, budgetUsd, budget },
    );
    // once·pingpong 처럼 산출물은 stdout 이다 — journal(stderr)은 앞 200자만 남긴다.
    if (result.lastOutput !== undefined) process.stdout.write(`${result.lastOutput}\n`);
    process.stderr.write(
      `\n${result.journal.render()}\n중단   ${result.stopReason} · ${result.iterations}회\n누적   ${result.budget.summary()}\n`,
    );
    if (testConflict) {
      process.stderr.write('안내   과제가 기존 테스트와 충돌한다 — 테스트를 직접 고치거나 과제를 바꾼 뒤 다시 실행한다 (D-049).\n');
    }
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
  // 기존 테스트의 작업 전 내용 — 쓰기일 때만 바뀔 수 있다 (D-047).
  const testGlobs = declaredTests();
  const testsBefore = args.write && testGlobs.length > 0 ? snapshotTests(testGlobs) : undefined;
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
  const tests = testsBefore ? testChanges(testsBefore, testGlobs) : undefined;
  if (tests) evidence.push(tests);
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
      ...report.contradictions.map((c) => `       ✗ 불일치: ${c}`),
      ...(tests && tests.added.length > 0 ? [`       + 테스트 추가(허용): ${tests.added.join(' · ')}`] : []),
    ].join('\n') + '\n',
  );

  // 2차 결정 로그 — **같은 id 로 append** 한다. 갱신이 아니다.
  // 증거가 모이고 나쁜 결과(기대와 다른 exit·reviewer FAIL)가 없을 때만 ok 다 (SPEC §5, D-043).
  const outcome = outcomeOf(run.outcome === 'ok', report);
  appendDecision(
    secondLine(
      decision,
      outcome,
      [
        stored ? `원시 로그 ${stored}` : '',
        `운영 기준: ${plan.assignment.operatingCriterion}`,
        report.contradictions.length > 0
          ? `불일치: ${report.contradictions.join(' / ')}`
          : report.satisfied
            ? `증거 ${report.accepted.length}건 충족`
            : `증거 미충족: ${report.missing.join(' / ')}`,
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
  // 완료가 아니면 1 이다 — 실행 실패(wrong)와 나쁜 결과의 증거(rework). loop·기준선과 같은 규칙이다 (D-044).
  // unverified 는 0 이다: 자동으로 못 모으는 증거(문서 절·측정값)가 많아 once 의 정상 결과다.
  if (outcome === 'wrong' || outcome === 'rework') process.exitCode = 1;
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
