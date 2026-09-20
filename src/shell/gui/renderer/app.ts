/**
 * Electron 렌더러 (D-021).
 *
 * Node 를 못 본다 — `window.orc`(preload)가 유일한 통로다.
 * TUI 와 같은 이유로 **JSX 를 쓰지 않는다**(D-019): 번들러가 있어도 두 셸의 화면 코드가
 * 같은 모양이어야 v1↔v2 이식이 눈으로 대조된다.
 */
import { createElement as h, useCallback, useEffect, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

const SCREENS = ['Run', 'Dashboard', 'Sessions', 'Reviews', 'Debug'] as const;
type Screen = (typeof SCREENS)[number];

interface Bridge {
  plan(payload: { task: string; write: boolean }): Promise<RunView>;
  run(payload: { task: string; verify: string[]; write: boolean }): Promise<RunResult>;
  sessions(): Promise<Probe<SessionRow>[]>;
  reviews(): Promise<Probe<ReviewRow>>;
  dashboard(): Promise<DashboardView>;
  debug(): Promise<DebugInfo>;
  crashTest(): Promise<string>;
}
interface RunView {
  title: { text: string };
  lines: string[];
  cost: { line: string; badge: { grade: string; text: string }; disclaimer: string } | null;
  awaitingApproval: boolean;
}
interface EvidenceReport { satisfied: boolean; missing: string[]; rejected: { why: string }[]; summary: string }
interface RunResult { ok: boolean; text: string; outcome?: string; report?: EvidenceReport; budget?: string; journal?: string; view?: RunView }
interface Probe<T> { rows: T[]; note: string }
interface SessionRow { source: string; name: string; status: string; provenance: string }
interface ReviewRow { ref: string; title: string; state: string }
interface DashboardView { title: { text: string }; spent: string; distribution: { model: string; count: number }[]; outcomes: { outcome: string; count: number }[]; unverified: number }
interface DebugInfo { title: { text: string }; node: string; electron: string; pid: number; cwd: string; limits: Record<string, number> }

const orc = (window as unknown as { orc: Bridge }).orc;

const text = (s: string, className?: string) => h('div', className ? { className } : null, s);

function RunScreen(): ReactElement {
  const [task, setTask] = useState('');
  const [verify, setVerify] = useState('');
  const [write, setWrite] = useState(false);
  const [view, setView] = useState<RunView | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!task.trim()) { setView(null); return; }
    let live = true;
    void orc.plan({ task, write }).then((v) => { if (live) setView(v); });
    return () => { live = false; };
  }, [task, write]);

  const approve = useCallback(() => {
    setBusy(true);
    setResult(null);
    void orc
      .run({ task, verify: verify.split('\n').map((v) => v.trim()).filter(Boolean), write })
      .then(setResult)
      .finally(() => setBusy(false));
  }, [task, verify, write]);

  return h(
    'div',
    null,
    h('h1', null, '작업'),
    h('input', { value: task, placeholder: '예) 이 아키텍처 설계 검토해줘', onChange: (e: { target: { value: string } }) => setTask(e.target.value) }),
    h('h1', { style: { marginTop: 16 } }, '검증 명령 (한 줄에 하나 — 증거가 없으면 완료로 닫지 않는다)'),
    h('textarea', { rows: 2, value: verify, placeholder: 'npm test', onChange: (e: { target: { value: string } }) => setVerify(e.target.value) }),
    h('label', { style: { display: 'block', marginTop: 12 } },
      h('input', { type: 'checkbox', checked: write, onChange: (e: { target: { checked: boolean } }) => setWrite(e.target.checked) }),
      ' primary 슬롯 파일 쓰기 허용 (--write) · reviewer는 항상 읽기 전용',
    ),
    view ? h('div', { style: { marginTop: 16 } }, ...view.lines.map((l) => text(l))) : null,
    view?.cost
      ? h(
          'div',
          { className: 'cost' },
          text(`비용 ${view.cost.line}`),
          h('div', null, h('span', { className: 'badge' }, view.cost.badge.grade), ' ', h('span', { className: 'dim' }, view.cost.badge.text)),
          text(view.cost.disclaimer, 'dim'),
        )
      : null,
    view?.awaitingApproval
      ? h('button', { className: 'primary', disabled: busy, onClick: approve }, busy ? '실행 중…' : '승인하고 실행')
      : null,
    result
      ? h(
          'div',
          { style: { marginTop: 16 } },
          h('pre', null, result.text),
          result.report ? text(`증거   ${result.report.summary}`, result.report.satisfied ? undefined : 'warn') : null,
          ...(result.report?.missing ?? []).map((m) => text(`  - 없음: ${m}`, 'warn')),
          result.outcome ? text(`결정   outcome=${result.outcome}`, 'dim') : null,
          result.budget ? text(`누적   ${result.budget}`, 'dim') : null,
          result.journal ? h('pre', { className: 'dim' }, result.journal) : null,
        )
      : null,
  );
}

function useAsync<T>(load: () => Promise<T>): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => { let live = true; void load().then((v) => { if (live) setValue(v); }); return () => { live = false; }; }, []);
  return value;
}

const SessionsScreen = (): ReactElement => {
  const probes = useAsync(() => orc.sessions());
  if (!probes) return text('불러오는 중…', 'dim');
  const rows = probes.flatMap((p) => p.rows.slice(0, 6));
  return h(
    'div',
    null,
    h('table', null, h('tbody', null, ...rows.map((s) =>
      h('tr', { key: `${s.source}${s.name}` },
        h('td', { className: 'dim' }, s.source), h('td', null, s.name),
        h('td', { className: 'dim' }, s.status), h('td', { className: 'dim' }, `[${s.provenance}]`)),
    ))),
    ...probes.filter((p) => p.note).map((p) => text(p.note, 'dim')),
  );
};

const ReviewsScreen = (): ReactElement => {
  const probe = useAsync(() => orc.reviews());
  if (!probe) return text('불러오는 중…', 'dim');
  return h('div', null,
    h('table', null, h('tbody', null, ...probe.rows.map((r) =>
      h('tr', { key: r.ref }, h('td', { className: 'dim' }, r.ref), h('td', { className: 'dim' }, r.state), h('td', null, r.title))))),
    text(probe.note, 'dim'));
};

const DashboardScreen = (): ReactElement => {
  const view = useAsync(() => orc.dashboard());
  if (!view) return text('불러오는 중…', 'dim');
  return h('div', null,
    text(`누적 비용 ${view.spent}`),
    text(`배정 분포 ${view.distribution.map((d) => `${d.model}×${d.count}`).join(' ') || '없음'}`),
    text(`결과     ${view.outcomes.map((o) => `${o.outcome}×${o.count}`).join(' ') || '없음'}`),
    view.unverified > 0
      ? text(`검증 기록이 빈 사이클 ${view.unverified}건 — "통과"가 아니다`, 'warn')
      : text('검증 누락 없음', 'dim'));
};

function DebugScreen(): ReactElement {
  const info = useAsync(() => orc.debug());
  const [crash, setCrash] = useState('');
  if (!info) return text('불러오는 중…', 'dim');
  return h('div', null,
    text(`electron ${info.electron} · node ${info.node} · pid ${info.pid}`),
    text(`cwd ${info.cwd}`),
    text(`limits 예산 $${info.limits['budgetUsd']} · 반복 ${info.limits['maxIterations']} · 노드 ${info.limits['maxNodes']}`),
    // 고의 크래시 — 설정만으로는 리포팅이 살아 있는지 알 수 없다.
    h('button', { className: 'primary', onClick: () => { void orc.crashTest().then(setCrash); } }, '고의 크래시 (리포팅 자가 검증)'),
    crash ? text(crash, 'warn') : null);
}

function App(): ReactElement {
  const [screen, setScreen] = useState<Screen>('Run');
  const [title, setTitle] = useState('hs-orchestrator');
  useEffect(() => { void orc.debug().then((d) => setTitle(d.title.text.replace(' Debug', ''))); }, []);

  const body =
    screen === 'Run' ? h(RunScreen, null)
    : screen === 'Dashboard' ? h(DashboardScreen, null)
    : screen === 'Sessions' ? h(SessionsScreen, null)
    : screen === 'Reviews' ? h(ReviewsScreen, null)
    : h(DebugScreen, null);

  return h('div', null,
    h('nav', null, ...SCREENS.map((s) =>
      h('button', { key: s, 'aria-current': s === screen, onClick: () => setScreen(s) }, s))),
    h('main', null, h('h1', null, title), body));
}

createRoot(document.getElementById('root') as HTMLElement).render(h(App, null));
