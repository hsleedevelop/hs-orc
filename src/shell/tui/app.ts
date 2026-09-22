/**
 * Ink 렌더 층 (D-018 Ink 7 + React 19, D-019 JSX 없음).
 *
 * **이 파일은 얇게 유지한다.** 판단은 전부 `model.ts`(순수 함수)에 있고 여기서는 그린다.
 * `createElement` 중첩이 읽기 어려워지면 그건 렌더 층이 두꺼워졌다는 신호다 (D-019).
 */
import { createElement as h, useCallback, useEffect, useState, type ReactElement } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { loadLimits } from '../../data/limits.ts';
import { routeWithFallback, type RouteResult } from '../../core/pipeline.ts';
import { createExecutor } from '../../core/executor.ts';
import { runDuo } from '../../core/duo.ts';
import { appendDecision } from '../../core/decision-log.ts';
import { firstLine, secondLine } from '../../core/decide.ts';
import { storeRun } from '../../core/run-store.ts';
import { reportError } from '../../core/report.ts';
import { Budget } from '../../core/budget.ts';
import { Journal } from '../../core/journal.ts';
import { claudeSessions, codexSessions, reviews, type Probe, type SessionRow } from '../integrations.ts';
import { SCREENS, dashboardView, runView, titleInfo, type Screen } from './model.ts';

const row = (...children: (ReactElement | string | null)[]) =>
  h(Box, { flexDirection: 'column' }, ...children.map((c) => (typeof c === 'string' ? h(Text, null, c) : c)));

const badge = (grade: string, text: string) =>
  h(Text, null, h(Text, { inverse: true }, ` ${grade} `), h(Text, { dimColor: true }, ` ${text}`));

function Header({ screen, keys }: { screen: Screen; keys: boolean }): ReactElement {
  return h(
    Box,
    { flexDirection: 'column', marginBottom: 1 },
    h(Text, { bold: true }, titleInfo(screen).text),
    h(
      Text,
      { dimColor: true },
      SCREENS.map((s, i) => `${i + 1}:${s}${s === screen ? '*' : ''}`).join('  ') + (keys ? '   q:종료' : '   (키 입력 없음 — --screen 으로 고른다)'),
    ),
  );
}

function RunScreen({
  task,
  journal,
  budget,
  keys,
  write,
}: {
  task: string;
  journal: Journal;
  budget: Budget;
  keys: boolean;
  write: boolean;
}): ReactElement {
  // 분류 폴백이 async 라 라우팅을 렌더 중에 못 한다 (D-026).
  // CLI 에만 폴백이 있으면 같은 입력이 셸마다 다르게 동작한다 — 그래서 여기도 같은 Core 함수를 쓴다.
  const [routed, setRouted] = useState<{ result: RouteResult | null; notes: string[] }>({ result: null, notes: [] });
  useEffect(() => {
    if (!task) { setRouted({ result: null, notes: [] }); return; }
    let live = true;
    void routeWithFallback(loadMatrix(), loadEngines(), task).then((r) => {
      if (live) setRouted({ result: r.result, notes: r.fallback ? [r.fallback.line] : [] });
    });
    return () => { live = false; };
  }, [task]);

  const result = routed.result;
  const view = runView(result, task, { write, notes: routed.notes });
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [output, setOutput] = useState('');
  const [, bump] = useState(0);

  const approve = useCallback(() => {
    if (phase !== 'idle' || result === null || result.stage !== 'assigned') return;
    setPhase('running');
    const matrix = loadMatrix();
    const slot = result.plan.slots.primary;
    const execute = createExecutor(loadEngines(), process.cwd(), loadLimits().runTimeoutMs, { write });

    // 1차 결정 로그 — 배정을 확정한 이 시점에 남긴다 (SPEC §8).
    const decision = firstLine(matrix, result.plan, task, result.reason);
    appendDecision(decision);

    // **두 슬롯을 실제로 돌린다** (D-009).
    void runDuo(matrix, result.plan, execute, task, budget).then((duo) => {
      const run = duo.primary;
      const charge = budget.charges.at(-1);
      journal.append({
        index: journal.records.length + 1,
        unit: '실행',
        model: slot.label,
        effort: slot.effort,
        outcome: run.ok ? 'ok' : 'failed',
        // 운영 기준이 완료의 정의다 (D-010). 무엇을 요구했는지 기록에 남긴다.
        evidence: `운영 기준: ${result.plan.assignment.operatingCriterion}`,
        change: run.text.slice(0, 200),
        // reviewer 판정이 있으면 그것이 검증이다. 없으면 빈 칸이고 "통과"가 아니다.
        verification: duo.verdict === 'unknown' ? '' : `reviewer ${result.plan.slots.reviewer.label}: ${duo.verdict.toUpperCase()}`,
        ...(charge ? { charge } : {}),
      });
      // 원시 로그를 먼저 보존하고, 실패해도 화면에 보이는 상태로 남긴다.
      let stored = '';
      try {
        stored = storeRun(decision.id, journal.records.length, slot.label, {
          rawStdout: run.rawStdout, rawStderr: run.rawStderr, meta: { outcome: run.ok ? 'ok' : 'failed', durationMs: run.durationMs, modelId: slot.modelId },
        }).dir;
      } catch (error) {
        setOutput(reportError('run-store', 'persist', error).display);
      }
      // 2차 — 같은 id 로 append. 자동 증거가 없으므로 unverified 다 (SPEC §5).
      appendDecision(secondLine(decision, run.ok ? 'unverified' : 'wrong', stored ? `원시 로그 ${stored}` : ''));

      setOutput(duo.review ? `${run.text}\n\n--- reviewer ${result.plan.slots.reviewer.label} → ${duo.verdict.toUpperCase()} ---\n${duo.review.text}` : run.text);
      setPhase('done');
      bump((n) => n + 1);
    });
  }, [phase, result, task, journal, budget]);

  useInput((input, key) => (input === 'y' || key.return ? approve() : undefined), {
    isActive: keys && phase === 'idle' && view.awaitingApproval,
  });

  return row(
    ...view.lines,
    view.cost
      ? h(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          h(Text, null, `비용 ${view.cost.line}`),
          badge(view.cost.badge.grade, view.cost.badge.text),
          h(Text, { dimColor: true }, view.cost.disclaimer),
        )
      : null,
    view.awaitingApproval && phase === 'idle'
      ? h(Text, { color: 'yellow' }, `\n승인: y 또는 Enter${keys ? '' : ' (키 입력 없음)'} — 비용은 실행 전에 확정된다.`)
      : null,
    phase === 'running' ? h(Text, { color: 'cyan' }, '\n실행 중…') : null,
    phase === 'done'
      ? h(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          h(Text, null, output.slice(0, 400)),
          h(Text, { dimColor: true }, `\n${journal.render()}`),
          h(Text, null, `누적 ${budget.summary()}`),
          journal.unverified.length > 0
            ? h(Text, { color: 'red' }, `검증 기록이 빈 사이클 ${journal.unverified.length}건 — "통과"가 아니다 (자동 검증은 S6)`)
            : null,
        )
      : null,
  );
}

function SessionsScreen(): ReactElement {
  const probes: Probe<SessionRow>[] = [claudeSessions(), codexSessions()];
  // 출처별로 잘라 둘 다 보이게 한다 — 한쪽이 많다고 다른 쪽을 밀어내면 "통합 조회"가 아니다.
  const rows = probes.flatMap((p) => p.rows.slice(0, 6));
  return row(
    ...rows.map((s) => `${s.source.padEnd(6)} ${s.name.slice(0, 32).padEnd(32)} ${s.status.slice(0, 22)}  [${s.provenance}]`),
    ...probes.filter((p) => p.note).map((p) => h(Text, { dimColor: true }, p.note)),
  );
}

function ReviewsScreen(): ReactElement {
  const probe = reviews();
  return row(...probe.rows.map((r) => `${r.ref} ${r.state.padEnd(8)} ${r.title}`), h(Text, { dimColor: true }, probe.note));
}

function DashboardScreen({ journal, budget }: { journal: Journal; budget: Budget }): ReactElement {
  const view = dashboardView(journal, budget);
  return row(
    `누적 비용 ${view.spent}`,
    `배정 분포 ${view.distribution.map((d) => `${d.model}×${d.count}`).join(' ') || '없음'}`,
    `결과     ${view.outcomes.map((o) => `${o.outcome}×${o.count}`).join(' ') || '없음'}`,
    view.unverified > 0
      ? h(Text, { color: 'red' }, `검증 기록이 빈 사이클 ${view.unverified}건 — "통과"가 아니다`)
      : h(Text, { dimColor: true }, '검증 누락 없음'),
  );
}

function DebugScreen({ keys }: { keys: boolean }): ReactElement {
  const limits = loadLimits();
  const catalog = loadEngines();
  const [crash, setCrash] = useState('');

  // **고의 크래시 버튼** — 크래시 리포팅은 자가 검증으로만 살아 있음을 확인할 수 있다
  // (hs-engineering: "크래시 리포터는 디버그 메뉴의 고의 크래시 버튼으로 자가 검증한다").
  useInput(
    (input) => {
      if (input !== 'c') return;
      try {
        throw new Error('의도적 크래시 — 리포팅 경로 자가 검증');
      } catch (error) {
        setCrash(reportError('tui/debug', 'crash-test', error).display);
      }
    },
    { isActive: keys },
  );

  // 디버그 화면은 프로덕션 빌드에도 싣는다 (hs-00-core 관찰가능성, SPEC §7).
  return row(
    `node ${process.version} · pid ${process.pid}`,
    `cwd ${process.cwd()}`,
    `limits 예산 $${limits.budgetUsd} · 반복 ${limits.maxIterations} · 노드 ${limits.maxNodes}`,
    `engines ${Object.keys(catalog.engines).join(', ')} · models ${Object.keys(catalog.models).length}`,
    crash ? h(Text, { color: 'red' }, crash) : h(Text, { dimColor: true }, keys ? 'c: 고의 크래시 (리포팅 자가 검증)' : '(키 입력 없음)'),
  );
}

export function App({ task, initialScreen, write = false }: { task: string; initialScreen?: Screen; write?: boolean }): ReactElement {
  const [screen, setScreen] = useState<Screen>(initialScreen ?? 'Run');
  const { exit } = useApp();
  // 파이프·CI 처럼 stdin 이 TTY 가 아니면 raw mode 가 없고, 가드하지 않으면 **화면이 통째로 죽는다**(실측).
  // ink 의 `useStdin().isRawModeSupported` 는 파이프에서 `false` 가 아니라 `undefined` 라
  // `isActive` 로 그대로 넘기면 가드가 되지 않는다 — TTY 여부를 직접 본다.
  const keysAvailable = process.stdin.isTTY === true;
  // S5 범위에서 Tasks/Dashboard 는 이 세션의 기록만 본다. 영속화는 S6 이다.
  const [journal] = useState(() => new Journal());
  const [budget] = useState(() => new Budget(loadLimits().budgetUsd));

  useInput(
    (input) => {
      if (input === 'q') exit();
      const index = Number(input);
      const picked = SCREENS[index - 1];
      if (picked) setScreen(picked);
    },
    { isActive: keysAvailable },
  );

  const body =
    screen === 'Run' ? h(RunScreen, { task, journal, budget, keys: keysAvailable, write })
    : screen === 'Sessions' ? h(SessionsScreen, null)
    : screen === 'Reviews' ? h(ReviewsScreen, null)
    : screen === 'Dashboard' ? h(DashboardScreen, { journal, budget })
    : screen === 'Debug' ? h(DebugScreen, { keys: keysAvailable })
    : row('기록 없음 — 이 세션에서 실행한 작업이 여기 쌓인다 (영속화는 S6).');

  return h(Box, { flexDirection: 'column' }, h(Header, { screen, keys: keysAvailable }), body);
}
