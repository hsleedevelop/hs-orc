/**
 * Electron 렌더러 (D-021).
 *
 * Node 를 못 본다 — `window.orc`(preload)가 유일한 통로다.
 * TUI 와 같은 이유로 **JSX 를 쓰지 않는다**(D-019): 번들러가 있어도 두 셸의 화면 코드가
 * 같은 모양이어야 v1↔v2 이식이 눈으로 대조된다.
 *
 * 화면이 지키는 것 세 가지:
 *   1. **작업 폴더가 항상 보인다.** 엔진이 어디서 도는지 모르는 채로 --write 를 켜면 안 된다.
 *   2. **전송은 명시적이다.** 타이핑이 곧 호출이면 분류 폴백(D-026)이 키 입력마다 돈다.
 *   3. **승인은 화면에 찍힌 그 작업으로만 간다.** 입력을 고친 뒤 누른 승인은 막는다.
 */
import { createElement as h, useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

const SCREENS = ['Run', 'Dashboard', 'Sessions', 'Reviews', 'Debug'] as const;
type Screen = (typeof SCREENS)[number];

type DepStatus =
  | { kind: 'unknown' }
  | { kind: 'missing'; manifest: string; install: string }
  | { kind: 'ready'; manifest: string };
interface ProjectInfo { dir: string; name: string; short: string; git: boolean; exists: boolean; deps: DepStatus }
interface ProjectState { current: ProjectInfo; recent: ProjectInfo[] }
interface WorktreeInfo { dir: string; branch: string | null; head: string; main: boolean; locked: boolean }
interface WorktreeState { repo: string | null; items: WorktreeInfo[]; current: string }

interface Bridge {
  plan(payload: { task: string; write: boolean; taskId?: string }): Promise<RunView>;
  run(payload: { task: string; verify: string[]; write: boolean; taskId?: string }): Promise<RunResult>;
  tasks(): Promise<TaskRow[]>;
  projects(): Promise<ProjectState>;
  pickProject(): Promise<ProjectState | null>;
  useProject(dir: string): Promise<ProjectState>;
  worktrees(): Promise<WorktreeState>;
  createWorktree(payload: { name: string }): Promise<ProjectState>;
  removeWorktree(dir: string): Promise<{ project: ProjectState; worktrees: WorktreeState; note: string }>;
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
  stage: 'input' | 'unclassified' | 'direct' | 'assigned';
}
interface TaskRow { id: string; task: string }
interface EvidenceReport { satisfied: boolean; missing: string[]; rejected: { why: string }[]; summary: string }
interface RunResult {
  ok: boolean; text: string; outcome?: string; report?: EvidenceReport;
  verdict?: 'pass' | 'fail' | 'unknown'; review?: string;
  budget?: string; journal?: string; view?: RunView;
}
interface Probe<T> { rows: T[]; note: string }
interface SessionRow { source: string; name: string; status: string; provenance: string }
interface ReviewRow { ref: string; title: string; state: string }
interface DashboardView { title: { text: string }; spent: string; distribution: { model: string; count: number }[]; outcomes: { outcome: string; count: number }[]; unverified: number }
interface DebugInfo { title: { text: string }; node: string; electron: string; pid: number; cwd: string; limits: Record<string, number> }

const orc = (window as unknown as { orc: Bridge }).orc;

const text = (s: string, className?: string) => h('div', className ? { className } : null, s);
const card = (label: string | null, ...children: ReactNode[]) =>
  h('section', { className: 'card' }, label ? h('span', { className: 'label' }, label) : null, ...children);

/**
 * 긴 경로는 **앞을** 자른다 — 뒤가 지금 있는 폴더다.
 * CSS 로 하지 않는 이유: `direction: rtl` 은 `~/Library/...` 의 `~` 를 문자열 끝으로 옮겨
 * 존재하지 않는 경로를 화면에 찍는다 (실측으로 확인).
 */
const elide = (s: string, max = 58): string => (s.length <= max ? s : `…${s.slice(-(max - 1))}`);

/** IPC 거절을 화면에 올린다. 조용히 삼키면 폴더 전환 실패가 "아무 일도 없음"으로 보인다. */
const why = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ── 배정 줄 ────────────────────────────────────────────────
// 뷰모델(`tui/model.ts`)이 만든 문자열을 **다시 해석하지 않는다.** 앞 라벨만 떼어 정렬·색만 준다.
const LABELS = ['분류', 'primary', 'reviewer', '기준', '쓰기', '비용'] as const;

function planLine(line: string, key: number): ReactElement {
  const label = LABELS.find((l) => line.startsWith(`${l} `));
  if (label === undefined) return h('div', { key, className: 'planline' }, h('div', { className: 'v dim' }, line));
  const value = line.slice(label.length).trim();
  const tone =
    label === 'primary' ? ' primary'
    : label === 'reviewer' ? ' reviewer'
    : label === '쓰기' && !value.startsWith('꺼짐') ? ' write-on'
    : '';
  return h('div', { key, className: `planline${tone}` }, h('div', { className: 'k' }, label), h('div', { className: 'v' }, value));
}

// ── 프로젝트 바 ────────────────────────────────────────────
const worktreeLabel = (w: WorktreeInfo): string => {
  const ref = w.branch ?? `(detached ${w.head})`;
  return `${ref}${w.main ? '  · 본체' : ''}${w.locked ? '  · 잠김' : ''}`;
};

function ProjectBar(props: { state: ProjectState | null; onChange: (s: ProjectState) => void; onError: (m: string) => void }): ReactElement {
  const { state, onChange, onError } = props;
  const [busy, setBusy] = useState(false);
  const [worktrees, setWorktrees] = useState<WorktreeState | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  /** 삭제는 두 번 누르게 한다 — 되돌릴 수 없는 버튼이 한 번 클릭에 붙어 있으면 안 된다. */
  const [confirming, setConfirming] = useState('');
  const [note, setNote] = useState('');
  const current = state?.current;

  // 폴더가 바뀌면 워크트리 목록도 다른 저장소의 것이다. 이전 목록을 남겨 두면 남의 브랜치를 고르게 된다.
  useEffect(() => {
    if (!current) return;
    setWorktrees(null);
    setConfirming('');
    orc.worktrees().then(setWorktrees, (e: unknown) => onError(why(e)));
  }, [current?.dir]);

  const pick = useCallback(() => {
    setBusy(true);
    orc.pickProject().then((s) => { if (s) onChange(s); }, (e: unknown) => onError(why(e))).finally(() => setBusy(false));
  }, [onChange, onError]);

  const choose = useCallback((dir: string) => {
    if (!dir) return;
    setBusy(true);
    orc.useProject(dir).then(onChange, (e: unknown) => onError(why(e))).finally(() => setBusy(false));
  }, [onChange, onError]);

  const create = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    orc.createWorktree({ name: trimmed })
      .then((s) => { onChange(s); setNaming(false); setName(''); }, (e: unknown) => onError(why(e)))
      .finally(() => setBusy(false));
  }, [name, onChange, onError]);

  const remove = useCallback((dir: string) => {
    setBusy(true);
    setNote('');
    orc.removeWorktree(dir)
      .then((r) => { setConfirming(''); setWorktrees(r.worktrees); setNote(r.note); onChange(r.project); },
        (e: unknown) => { setConfirming(''); onError(why(e)); })
      .finally(() => setBusy(false));
  }, [onChange, onError]);

  const inWorktree = worktrees?.items.find((w) => w.dir === worktrees.current);
  const removable = inWorktree && !inWorktree.main ? inWorktree : null;

  return h(
    'div',
    { className: 'projectbar' },
    h('div', { className: 'pb-row' },
      h('span', { className: 'project-name' }, current?.name ?? '…'),
      h('span', { className: 'project-path', title: current?.dir ?? '' }, elide(current?.short ?? '')),
      current ? h('span', { className: `chip ${current.git ? 'git' : 'nogit'}` }, current.git ? 'git' : 'git 아님') : null,
      inWorktree && !inWorktree.main ? h('span', { className: 'chip wt' }, inWorktree.branch ?? '워크트리') : null,
      h('div', { className: 'spacer' }),
      // 최근 목록은 **선택지일 뿐** 현재 폴더를 대신 고르지 않는다 — 항상 현재 폴더에 고정해 둔다.
      state && state.recent.length > 0
        ? h('select', {
            value: current?.dir ?? '',
            disabled: busy,
            title: '최근 프로젝트',
            onChange: (e: { target: { value: string } }) => choose(e.target.value),
          },
          ...(state.recent.some((r) => r.dir === current?.dir) ? [] : [h('option', { key: 'cur', value: current?.dir ?? '' }, elide(current?.short ?? '', 44))]),
          ...state.recent.map((r) => h('option', { key: r.dir, value: r.dir }, r.exists ? elide(r.short, 44) : `${elide(r.short, 36)} (없음)`)))
        : null,
      h('button', { className: 'btn', disabled: busy, onClick: pick }, '폴더 선택…')),

    // 워크트리는 git 저장소일 때만 뜬다. 저장소가 아니면 만들 수 있다고 거짓말하지 않는다.
    worktrees?.repo
      ? h('div', { className: 'pb-row' },
          h('span', { className: 'lead' }, '워크트리'),
          h('select', {
            value: worktrees.current,
            disabled: busy,
            onChange: (e: { target: { value: string } }) => choose(e.target.value),
          },
          ...(worktrees.current ? [] : [h('option', { key: 'none', value: '' }, '(이 저장소의 워크트리가 아님)')]),
          ...worktrees.items.map((w) => h('option', { key: w.dir, value: w.dir }, worktreeLabel(w)))),
          naming
            ? h('input', {
                type: 'text',
                className: 'code wt-name',
                autoFocus: true,
                value: name,
                placeholder: '이름 (영문·숫자·. _ -)',
                onChange: (e: { target: { value: string } }) => setName(e.target.value),
                onKeyDown: (e: { key: string; preventDefault: () => void }) => {
                  if (e.key === 'Enter') { e.preventDefault(); create(); }
                  if (e.key === 'Escape') { setNaming(false); setName(''); }
                },
              })
            : null,
          naming
            ? h('button', { className: 'btn accent', disabled: busy || !name.trim(), onClick: create, title: `브랜치 hs-orc/${name.trim()}` }, busy ? '만드는 중…' : '만들기')
            : h('button', { className: 'btn', disabled: busy, onClick: () => setNaming(true) }, '＋ 새 워크트리'),
          naming ? h('button', { className: 'btn', disabled: busy, onClick: () => { setNaming(false); setName(''); } }, '취소') : null,
          naming ? h('span', { className: 'hint' }, `브랜치 hs-orc/${name.trim() || '…'}`) : null,
          // 삭제는 **선택된 워크트리**를 지운다. 본체는 대상이 아니다.
          !naming && removable
            ? h('button', {
                className: 'btn danger',
                disabled: busy,
                title: removable.dir,
                onClick: () => (confirming === removable.dir ? remove(removable.dir) : setConfirming(removable.dir)),
              },
              busy ? '지우는 중…' : confirming === removable.dir ? '정말 지운다 · 되돌릴 수 없다' : '삭제')
            : null,
          !naming && removable && confirming === removable.dir
            ? h('button', { className: 'btn', disabled: busy, onClick: () => setConfirming('') }, '취소')
            : null,
          h('div', { className: 'spacer' }),
          h('span', { className: note ? 'hint good' : 'hint' },
            note || '쓰기를 켜고 돌릴 때 본체 작업 트리를 건드리지 않는다'))
      : null,

    // 의존성이 없으면 검증 명령이 성립하지 않는다 — **돌리기 전에** 알려야 한다.
    current?.deps.kind === 'missing'
      ? h('div', { className: 'pb-row' },
          h('span', { className: 'chip nogit' }, '의존성 없음'),
          h('span', { className: 'hint' }, '검증 명령이 여기서는 성립하지 않는다. 새 워크트리는 node_modules 가 따라오지 않는다.'),
          h('code', { className: 'inline-cmd' }, `${current.deps.install}`),
          h('button', {
            className: 'btn',
            title: '명령을 클립보드로',
            onClick: () => { void navigator.clipboard?.writeText(current.deps.kind === 'missing' ? current.deps.install : ''); },
          }, '복사'))
      : null,
  );
}

// ── Run ────────────────────────────────────────────────────
/** `taskId` 가 있으면 사용자가 고른 행이다 — 승인할 때 run 에도 같은 행을 보낸다. */
interface Planned { task: string; write: boolean; taskId?: string; view: RunView }

function RunScreen(props: { projectDir: string | undefined }): ReactElement {
  const [draft, setDraft] = useState('');
  const [verify, setVerify] = useState('');
  const [write, setWrite] = useState(false);
  const [planned, setPlanned] = useState<Planned | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState('');
  const [planning, setPlanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<TaskRow[]>([]);
  /** 배정·결과가 새로 뜨면 그 자리로 옮긴다 — 입력 아래 카드들에 가려 "아무 일 없음"으로 보이지 않게. */
  const outcomeRef = useRef<HTMLDivElement>(null);

  useEffect(() => { orc.tasks().then(setRows, (e: unknown) => setError(why(e))); }, []);
  useEffect(() => { outcomeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [planned, result]);

  // 폴더가 바뀌면 이전 배정·결과는 **다른 프로젝트의 것이다.** 남겨 두면 잘못된 폴더로 승인하게 된다.
  useEffect(() => { setPlanned(null); setResult(null); setError(''); }, [props.projectDir]);

  const plan = useCallback((task: string, w: boolean, taskId?: string) => {
    if (!task.trim()) { setPlanned(null); return; }
    setPlanning(true);
    setError('');
    setResult(null);
    orc.plan({ task, write: w, ...(taskId ? { taskId } : {}) })
      .then((view) => setPlanned({ task, write: w, ...(taskId ? { taskId } : {}), view }), (e: unknown) => setError(why(e)))
      .finally(() => setPlanning(false));
  }, []);

  const toggleWrite = useCallback((next: boolean) => {
    setWrite(next);
    // 쓰기 여부는 배정 화면에 찍히는 값이다 — 이미 배정을 봤다면 그 자리에서 다시 받는다.
    if (planned) plan(planned.task, next, planned.taskId);
  }, [planned, plan]);

  const approve = useCallback(() => {
    if (!planned) return;
    setBusy(true);
    setResult(null);
    setError('');
    // **화면에 찍힌 그 작업**을 보낸다. 입력창의 최신 글자가 아니다.
    orc.run({
      task: planned.task,
      verify: verify.split('\n').map((v) => v.trim()).filter(Boolean),
      write: planned.write,
      ...(planned.taskId ? { taskId: planned.taskId } : {}),
    })
      .then(setResult, (e: unknown) => setError(why(e)))
      .finally(() => setBusy(false));
  }, [planned, verify]);

  const stale = planned !== null && draft.trim() !== planned.task.trim();
  const view = planned?.view ?? null;

  return h(
    'div',
    { className: 'stack' },
    error ? h('div', { className: 'banner error' }, error) : null,

    card('작업',
      h('textarea', {
        rows: 3,
        value: draft,
        placeholder: '예) 이 아키텍처 설계 검토해줘',
        onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
        onKeyDown: (e: { key: string; metaKey: boolean; ctrlKey: boolean; preventDefault: () => void }) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); plan(draft, write); }
        },
      }),
      h('div', { className: 'row', style: { marginTop: 10 } },
        h('span', { className: 'hint' }, planning ? '분류 중…' : stale ? '작업이 바뀌었다 — 다시 전송해야 배정이 갱신된다' : ''),
        h('div', { className: 'spacer' }),
        h('span', { className: 'hint' }, h('span', { className: 'kbd' }, '⌘'), h('span', { className: 'kbd' }, '↵')),
        h('button', { className: 'btn accent', disabled: planning || !draft.trim(), onClick: () => plan(draft, write) },
          planning ? '분류 중…' : '전송'))),

    card('검증 명령 · 한 줄에 하나',
      h('textarea', { className: 'code', rows: 2, value: verify, placeholder: 'npm test', onChange: (e: { target: { value: string } }) => setVerify(e.target.value) }),
      h('div', { className: 'hint', style: { marginTop: 8 } }, '증거가 없으면 완료로 닫지 않는다 — 결과는 unverified 로 남는다.')),

    card(null,
      h('label', { className: 'toggle' },
        h('input', { type: 'checkbox', checked: write, onChange: (e: { target: { checked: boolean } }) => toggleWrite(e.target.checked) }),
        h('span', { className: 'track' }),
        h('span', { className: 'text' },
          write ? h('b', null, 'primary 슬롯이 이 폴더의 파일을 고칠 수 있다') : 'primary 슬롯 파일 쓰기 (--write)',
          h('span', { className: 'dim' }, ' · reviewer 는 언제나 읽기 전용')))),

    h('div', { ref: outcomeRef, className: 'stack', style: { padding: 0, width: '100%' } },
    view ? card('배정', ...view.lines.map((l, i) => planLine(l, i))) : null,

    // 승인 버튼이 없는 분기는 **왜 없는지와 다음 행동**을 말한다. 말없이 멈추면 고장처럼 보인다.
    view?.stage === 'unclassified'
      ? h('div', { className: 'banner note' }, '분류되지 않아 실행할 배정이 없다 — 아래에서 업무 행을 직접 고르면 배정과 비용이 나온다.')
      : null,
    view?.stage === 'direct'
      ? h('div', { className: 'banner note' }, '하한선 판정 — 엔진을 띄울 작업이 아니다. 승인할 실행이 없다.')
      : null,

    // `--task` 의 GUI 판. 한 번 고른 뒤에도 남겨 두어 다른 행으로 바꿀 수 있게 한다.
    planned && (view?.stage === 'unclassified' || planned.taskId)
      ? card('업무 행 직접 지정',
          h('div', { className: 'row' },
            h('select', {
              value: planned.taskId ?? '',
              disabled: planning || busy || stale,
              onChange: (e: { target: { value: string } }) => { if (e.target.value) plan(planned.task, planned.write, e.target.value); },
            },
            h('option', { key: 'none', value: '' }, '행을 고른다…'),
            ...rows.map((r) => h('option', { key: r.id, value: r.id }, `${r.id} · ${r.task}`))),
            h('span', { className: 'hint' }, stale ? '작업이 바뀌었다 — 먼저 다시 전송' : '분류를 건너뛴다 (CLI --task 와 같다)')))
      : null,

    view?.cost
      ? h('section', { className: 'card accented' },
          h('span', { className: 'label' }, '비용'),
          h('div', { className: 'row' },
            h('span', { className: 'cost-figure' }, view.cost.line),
            h('span', { className: 'chip grade' }, view.cost.badge.grade),
            h('span', { className: 'hint' }, view.cost.badge.text)),
          h('div', { className: 'hint', style: { marginTop: 6 } }, view.cost.disclaimer))
      : null,

    view?.awaitingApproval
      ? h('button', { className: 'btn accent wide', disabled: busy || stale, onClick: approve },
          busy ? '실행 중…' : stale ? '작업이 바뀌었다 — 다시 전송' : `승인하고 실행 · 두 슬롯${planned?.write ? ' · 쓰기 켜짐' : ''}`)
      : null,

    result ? ResultCards(result) : null),
  );
}

function ResultCards(result: RunResult): ReactElement {
  const verdict = result.verdict ?? 'unknown';
  const report = result.report;
  return h(
    'div',
    { className: 'stack', style: { padding: 0 } },
    card('primary 출력', h('pre', null, result.text || '(빈 출력)')),

    h('section', { className: 'card' },
      h('span', { className: 'label' }, 'reviewer 판정'),
      h('div', { className: 'row' },
        h('span', { className: `chip ${verdict}` }, verdict.toUpperCase()),
        h('span', { className: 'hint' }, '교차 벤더 독립 검증 — reviewer 는 파일을 고치지 못한다')),
      result.review ? h('pre', { style: { marginTop: 10 } }, result.review) : null),

    report
      ? card('증거',
          text(report.summary, report.satisfied ? 'good mono' : 'warn mono'),
          ...report.missing.map((m, i) => h('div', { key: `m${i}`, className: 'bad mono' }, `없음: ${m}`)),
          ...report.rejected.map((r, i) => h('div', { key: `r${i}`, className: 'warn mono' }, `거절: ${r.why}`)))
      : null,

    card('기록',
      result.outcome ? text(`outcome = ${result.outcome}`, result.outcome === 'ok' ? 'good mono' : 'warn mono') : null,
      result.budget ? text(result.budget, 'dim mono') : null,
      result.journal ? h('pre', { className: 'plain', style: { marginTop: 8 } }, result.journal) : null),
  );
}

// ── 나머지 화면 ────────────────────────────────────────────
function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => { let live = true; void load().then((v) => { if (live) setValue(v); }); return () => { live = false; }; }, deps);
  return value;
}

const SessionsScreen = (): ReactElement => {
  const probes = useAsync(() => orc.sessions());
  if (!probes) return text('불러오는 중…', 'dim');
  const rows = probes.flatMap((p) => p.rows.slice(0, 6));
  return h('div', { className: 'stack' },
    card('세션',
      h('table', null, h('tbody', null, ...rows.map((s) =>
        h('tr', { key: `${s.source}${s.name}` },
          h('td', { className: 'mono dim' }, s.source), h('td', null, s.name),
          h('td', { className: 'mono dim' }, s.status), h('td', { className: 'mono dim' }, `[${s.provenance}]`)))))),
    ...probes.filter((p) => p.note).map((p) => h('div', { key: p.note, className: 'banner note' }, p.note)));
};

const ReviewsScreen = (): ReactElement => {
  const probe = useAsync(() => orc.reviews());
  if (!probe) return text('불러오는 중…', 'dim');
  return h('div', { className: 'stack' },
    card('리뷰',
      h('table', null, h('tbody', null, ...probe.rows.map((r) =>
        h('tr', { key: r.ref }, h('td', { className: 'mono dim' }, r.ref), h('td', { className: 'mono dim' }, r.state), h('td', null, r.title)))))),
    probe.note ? h('div', { className: 'banner note' }, probe.note) : null);
};

const DashboardScreen = (): ReactElement => {
  const view = useAsync(() => orc.dashboard());
  if (!view) return text('불러오는 중…', 'dim');
  return h('div', { className: 'stack' },
    h('section', { className: 'card accented' },
      h('span', { className: 'label' }, '누적 비용'),
      h('div', { className: 'cost-figure' }, view.spent)),
    card('배정 분포', text(view.distribution.map((d) => `${d.model} × ${d.count}`).join('   ') || '없음', 'mono')),
    card('결과', text(view.outcomes.map((o) => `${o.outcome} × ${o.count}`).join('   ') || '없음', 'mono')),
    view.unverified > 0
      ? h('div', { className: 'banner error' }, `검증 기록이 빈 사이클 ${view.unverified}건 — "통과"가 아니다`)
      : h('div', { className: 'banner note' }, '검증 누락 없음'));
};

function DebugScreen(): ReactElement {
  const info = useAsync(() => orc.debug());
  const [crash, setCrash] = useState('');
  if (!info) return text('불러오는 중…', 'dim');
  return h('div', { className: 'stack' },
    card('런타임',
      text(`electron ${info.electron} · node ${info.node} · pid ${info.pid}`, 'mono'),
      text(`cwd ${info.cwd}`, 'mono dim'),
      text(`limits 예산 $${info.limits['budgetUsd']} · 반복 ${info.limits['maxIterations']} · 노드 ${info.limits['maxNodes']}`, 'mono dim')),
    // 고의 크래시 — 설정만으로는 리포팅이 살아 있는지 알 수 없다.
    card('크래시 리포팅 자가 검증',
      h('button', { className: 'btn danger', onClick: () => { void orc.crashTest().then(setCrash); } }, '고의 크래시'),
      crash ? h('pre', { style: { marginTop: 10 } }, crash) : null));
}

// ── 셸 ─────────────────────────────────────────────────────
function App(): ReactElement {
  const [screen, setScreen] = useState<Screen>('Run');
  const [title, setTitle] = useState('hs-orchestrator');
  const [meta, setMeta] = useState('');
  const [projects, setProjects] = useState<ProjectState | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void orc.debug().then((d) => {
      const parts = d.title.text.split(' · ');
      setTitle(parts[0]?.replace(' Debug', '') ?? 'hs-orchestrator');
      setMeta(parts.slice(1).join(' · '));
    });
    orc.projects().then(setProjects, (e: unknown) => setError(why(e)));
  }, []);

  // Run 은 **숨기기만 한다.** 언마운트하면 입력·배정·진행 중인 실행 결과가 탭 이동 한 번에 사라진다.
  // 나머지 화면은 읽기 전용 조회라 들어올 때마다 다시 불러오는 편이 맞다(실행 뒤 대시보드가 낡지 않게).
  const run = h('div', { key: 'run', hidden: screen !== 'Run' },
    h(RunScreen, { projectDir: projects?.current.dir, key: projects?.current.dir ?? 'none' }));
  const body =
    screen === 'Run' ? null
    : screen === 'Dashboard' ? h(DashboardScreen, null)
    : screen === 'Sessions' ? h(SessionsScreen, null)
    : screen === 'Reviews' ? h(ReviewsScreen, null)
    : h(DebugScreen, null);

  return h('div', { className: 'shell' },
    h('header', { className: 'titlebar' },
      h('span', { className: 'name' }, title),
      h('span', { className: 'meta' }, meta)),
    h(ProjectBar, { state: projects, onChange: setProjects, onError: setError }),
    h('nav', { className: 'tabs' }, ...SCREENS.map((s) =>
      h('button', { key: s, 'aria-current': s === screen, onClick: () => setScreen(s) }, s))),
    h('main', null,
      error ? h('div', { className: 'stack' }, h('div', { className: 'banner error' }, error)) : null,
      run,
      body));
}

createRoot(document.getElementById('root') as HTMLElement).render(h(App, null));
