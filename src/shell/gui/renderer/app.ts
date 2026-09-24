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

const SCREENS = ['Session', 'Dashboard', 'Agents', 'Reviews', 'Debug'] as const;
type Screen = (typeof SCREENS)[number];

type DepStatus =
  | { kind: 'unknown' }
  | { kind: 'missing'; manifest: string; install: string }
  | { kind: 'ready'; manifest: string };
interface ProjectInfo { dir: string; name: string; short: string; git: boolean; exists: boolean; deps: DepStatus }
interface ProjectState { current: ProjectInfo; recent: ProjectInfo[] }
interface WorktreeInfo { dir: string; branch: string | null; head: string; main: boolean; locked: boolean }
interface WorktreeState { repo: string | null; items: WorktreeInfo[]; current: string }

type SessionKind = 'project' | 'scratch';
type SessionState = 'waiting_input' | 'working' | 'blocked';
type Rec =
  | { kind: 'user'; turn: number; text: string }
  | { kind: 'direct'; turn: number; text: string; suggest: string | null; cost: string; notes: string[] }
  | { kind: 'plan'; turn: number; taskId: string; title: string; reason: string; primary: string; reviewer: string; estimateUsd: number; notes: string[] }
  | { kind: 'approval'; turn: number; approved: boolean; write: boolean }
  | { kind: 'result'; turn: number; outcome: string; verdict: string; text: string; review: string; evidence: string; decisionId: string }
  | { kind: 'summary'; turn: number; text: string; next: string }
  | { kind: 'error'; turn: number; text: string };
interface SessionView { id: string; kind: SessionKind; dir: string; state: SessionState; records: Rec[]; broken: number; budget: string; appBudget: string; interrupted: boolean }
interface SessionSummary { id: string; dir: string; kind: SessionKind; lastAt: string; preview: string }

interface Bridge {
  convList(): Promise<SessionSummary[]>;
  convStart(kind: SessionKind): Promise<SessionView>;
  convOpen(payload: { kind: SessionKind; dir: string; id: string }): Promise<SessionView>;
  convView(): Promise<SessionView>;
  convSend(text: string): Promise<SessionView>;
  convPlanAs(taskId: string): Promise<SessionView>;
  convApprove(payload: { verify: string[]; write: boolean }): Promise<SessionView>;
  convReject(): Promise<SessionView>;
  convAsk(): Promise<SessionView>;
  convClose(): Promise<void>;
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
interface TaskRow { id: string; task: string }
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

// ── 세션 ───────────────────────────────────────────────────
const lines = (s: string): string[] => s.split('\n').map((v) => v.trim()).filter(Boolean);

function SessionList(props: { onOpen: (v: SessionView) => void; onError: (m: string) => void }): ReactElement {
  const list = useAsync(() => orc.convList());
  const [busy, setBusy] = useState(false);
  const start = (kind: SessionKind) => {
    setBusy(true);
    orc.convStart(kind).then(props.onOpen, (e: unknown) => props.onError(why(e))).finally(() => setBusy(false));
  };
  const open = (s: SessionSummary) => {
    orc.convOpen({ kind: s.kind, dir: s.dir, id: s.id }).then(props.onOpen, (e: unknown) => props.onError(why(e)));
  };
  return h('div', { className: 'stack' },
    card('새 세션',
      h('div', { className: 'row' },
        h('button', { className: 'btn accent', disabled: busy, onClick: () => start('project') }, '이 폴더에서 시작'),
        h('button', { className: 'btn', disabled: busy, onClick: () => start('scratch') }, '스크래치'),
        h('span', { className: 'hint' }, '스크래치는 폴더 없이 시작한다 — 쓰기를 켤 수 없다'))),
    card('최근 세션',
      !list ? text('불러오는 중…', 'dim')
      : list.length === 0 ? text('아직 없다', 'dim')
      : h('table', null, h('tbody', null, ...list.map((s) =>
          h('tr', { key: `${s.dir}/${s.id}`, className: 'clickable', onClick: () => open(s) },
            h('td', { className: 'mono dim' }, s.kind === 'scratch' ? '스크래치' : elide(s.dir, 30)),
            h('td', null, s.preview || '(빈 세션)'),
            h('td', { className: 'mono dim' }, s.lastAt.slice(0, 16).replace('T', ' '))))))));
}

function SessionScreen(props: { view: SessionView; rows: TaskRow[]; onChange: (v: SessionView) => void; onClose: () => void }): ReactElement {
  const { view, onChange } = props;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState('');
  const [verify, setVerify] = useState('');
  const [write, setWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  // 새 기록·진행 표시가 뜨면 그 자리로 간다 — 입력 아래에 가려 "아무 일 없음"으로 보이지 않게.
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [view.records.length, busy]);

  const act = (p: Promise<SessionView>) => {
    setBusy(true);
    setError('');
    // 거절돼도 서비스 쪽 상태는 바뀌었을 수 있다 — 낡은 뷰(예: blocked 카드)를 남기지 않게 다시 받는다.
    p.then(onChange, (e: unknown) => {
      setError(why(e));
      orc.convView().then(onChange, (e2: unknown) => setError(`${why(e)} · 다시 불러오지 못했다: ${why(e2)}`));
    }).finally(() => { setBusy(false); setSending(''); });
  };
  const send = () => {
    const t = draft.trim();
    if (!t) return;
    setDraft('');
    setSending(t);
    act(orc.convSend(t));
  };

  const last = view.records.at(-1);
  const canType = view.state === 'waiting_input' && !busy;

  const planCard = (r: Extract<Rec, { kind: 'plan' }>, i: number, active: boolean): ReactNode =>
    h('section', { key: i, className: 'card' },
      h('span', { className: 'label' }, `배정 · ${r.taskId}`),
      ...r.notes.map((n, j) => h('div', { key: `n${j}`, className: 'hint' }, n)),
      planLine(`분류 ${r.taskId} ${r.title}  (${r.reason})`, 0),
      planLine(`primary  ${r.primary}`, 1),
      planLine(`reviewer ${r.reviewer}`, 2),
      planLine(`비용 예상 $${r.estimateUsd}`, 3),
      active
        ? h('div', { className: 'stack', style: { padding: 0, width: '100%', marginTop: 10 } },
            h('div', { className: 'row' },
              // 행을 바꾸면 이 배정을 거절하고 새 행으로 다시 받는다 — 승인은 화면에 찍힌 그 배정으로만 간다.
              h('select', {
                value: r.taskId,
                disabled: busy,
                onChange: (e: { target: { value: string } }) => act(orc.convReject().then(() => orc.convPlanAs(e.target.value))),
              }, ...props.rows.map((row) => h('option', { key: row.id, value: row.id }, `${row.id} · ${row.task}`))),
              h('span', { className: 'hint' }, '업무 행 직접 지정')),
            h('textarea', {
              className: 'code', rows: 2, value: verify, placeholder: '검증 명령 · 한 줄에 하나 (예: npm test)',
              onChange: (e: { target: { value: string } }) => setVerify(e.target.value),
            }),
            h('label', { className: 'toggle' },
              h('input', {
                type: 'checkbox', checked: write && view.kind !== 'scratch', disabled: view.kind === 'scratch',
                onChange: (e: { target: { checked: boolean } }) => setWrite(e.target.checked),
              }),
              h('span', { className: 'track' }),
              h('span', { className: 'text' },
                view.kind === 'scratch' ? '스크래치는 쓰기를 켤 수 없다'
                : write ? h('b', null, 'primary 슬롯이 이 폴더의 파일을 고칠 수 있다')
                : 'primary 슬롯 파일 쓰기 (--write)',
                h('span', { className: 'dim' }, ' · reviewer 는 언제나 읽기 전용'))),
            h('div', { className: 'row' },
              h('button', {
                className: 'btn accent', disabled: busy,
                onClick: () => act(orc.convApprove({ verify: lines(verify), write: write && view.kind !== 'scratch' })),
              }, busy ? '실행 중…' : `승인하고 실행 · 두 슬롯${write && view.kind !== 'scratch' ? ' · 쓰기 켜짐' : ''}`),
              h('button', { className: 'btn', disabled: busy, onClick: () => act(orc.convReject()) }, '거절'),
              // 규칙이 대화성 후속을 작업 행으로 잡았을 때 — 거절하고 같은 메시지를 지휘자가 답한다 (D-038).
              h('button', { className: 'btn', disabled: busy, onClick: () => act(orc.convAsk()) }, '지휘자에게 묻기')))
        : null);

  const record = (r: Rec, i: number): ReactNode => {
    switch (r.kind) {
      case 'user':
        return h('div', { key: i, className: 'bubble user' }, r.text);
      case 'direct': {
        const suggest = r.suggest;
        return h('div', { key: i, className: 'bubble orc' },
          ...r.notes.map((n, j) => h('div', { key: `n${j}`, className: 'hint' }, n)),
          h('div', null, r.text),
          h('div', { className: 'hint' }, `직접 답 · 지휘자 Haiku·low · ${r.cost}`),
          suggest && r === last && view.state === 'waiting_input'
            ? h('button', { className: 'btn accent', disabled: busy, onClick: () => act(orc.convPlanAs(suggest)) }, `${suggest} 로 위임`)
            : null);
      }
      case 'plan':
        return planCard(r, i, r === last && view.state === 'blocked');
      case 'approval':
        return h('div', { key: i, className: 'hint' }, r.approved ? `승인${r.write ? ' · 쓰기 켜짐' : ''}` : '거절');
      case 'result':
        return h('section', { key: i, className: 'card' },
          h('span', { className: 'label' }, `위임 결과 · ${r.decisionId}`),
          h('div', { className: 'row' },
            h('span', { className: `chip ${r.verdict}` }, r.verdict.toUpperCase()),
            h('span', { className: r.outcome === 'ok' ? 'good mono' : 'warn mono' }, `outcome = ${r.outcome}`)),
          h('div', { className: r.outcome === 'ok' ? 'good mono' : 'warn mono' }, r.evidence),
          h('pre', { style: { marginTop: 10 } }, r.text || '(빈 출력)'),
          r.review ? h('pre', { style: { marginTop: 10 } }, r.review) : null);
      case 'summary':
        return h('div', { key: i, className: 'bubble orc' },
          r.text ? h('div', null, r.text) : null,
          r.next ? h('div', { className: 'warn' }, r.next) : null);
      case 'error':
        return h('div', { key: i, className: 'banner error' }, r.text);
    }
  };

  return h('div', { className: 'stack' },
    h('div', { className: 'row' },
      h('span', { className: 'mono dim' }, view.kind === 'scratch' ? `스크래치 · ${elide(view.dir, 50)}` : elide(view.dir, 60)),
      h('div', { className: 'spacer' }),
      h('span', { className: 'dim mono' }, view.budget),
      h('span', { className: 'dim mono' }, view.appBudget),
      h('button', { className: 'btn', onClick: props.onClose }, '세션 목록')),
    view.broken > 0 ? h('div', { className: 'banner error' }, `기록에 깨진 줄 ${view.broken}개 — 건너뛰고 보여준다`) : null,
    view.interrupted ? h('div', { className: 'banner error' }, '승인한 위임의 결과가 기록되지 않았다 — 실행 중 앱이 끊겼다. 결정 로그 1차 줄만 남아 있을 수 있다.') : null,
    ...view.records.map(record),
    sending ? h('div', { className: 'bubble user dim' }, sending) : null,
    busy ? text(view.state === 'blocked' || last?.kind === 'plan' ? '실행 중…' : '생각 중…', 'dim') : null,
    error ? h('div', { className: 'banner error' }, error) : null,
    h('div', { ref: endRef }),
    card(null,
      h('textarea', {
        rows: 3, value: draft, disabled: !canType,
        placeholder: view.state === 'blocked' ? '배정을 승인하거나 거절해야 다음 메시지를 받는다' : '메시지 · ⌘↵ 전송',
        onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
        onKeyDown: (e: { key: string; metaKey: boolean; ctrlKey: boolean; preventDefault: () => void }) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
        },
      }),
      h('div', { className: 'row', style: { marginTop: 10 } },
        h('div', { className: 'spacer' }),
        h('button', { className: 'btn accent', disabled: !canType || !draft.trim(), onClick: send }, '전송'))));
}

// ── 나머지 화면 ────────────────────────────────────────────
function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => { let live = true; void load().then((v) => { if (live) setValue(v); }); return () => { live = false; }; }, deps);
  return value;
}

const AgentsScreen = (): ReactElement => {
  const probes = useAsync(() => orc.sessions());
  if (!probes) return text('불러오는 중…', 'dim');
  const rows = probes.flatMap((p) => p.rows.slice(0, 6));
  return h('div', { className: 'stack' },
    card('에이전트 세션',
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
  const [screen, setScreen] = useState<Screen>('Session');
  const [title, setTitle] = useState('hs-orchestrator');
  const [meta, setMeta] = useState('');
  const [projects, setProjects] = useState<ProjectState | null>(null);
  const [error, setError] = useState('');
  const [conv, setConv] = useState<SessionView | null>(null);
  const [rows, setRows] = useState<TaskRow[]>([]);
  useEffect(() => { orc.tasks().then(setRows, (e: unknown) => setError(why(e))); }, []);

  useEffect(() => {
    void orc.debug().then((d) => {
      const parts = d.title.text.split(' · ');
      setTitle(parts[0]?.replace(' Debug', '') ?? 'hs-orchestrator');
      setMeta(parts.slice(1).join(' · '));
    });
    orc.projects().then(setProjects, (e: unknown) => setError(why(e)));
  }, []);

  // Session 은 **숨기기만 한다.** 언마운트하면 입력·배정·진행 중인 실행 결과가 탭 이동 한 번에 사라진다.
  // 나머지 화면은 읽기 전용 조회라 들어올 때마다 다시 불러오는 편이 맞다(실행 뒤 대시보드가 낡지 않게).
  const session = h('div', { key: 'session', hidden: screen !== 'Session' },
    conv
      ? h(SessionScreen, {
          view: conv,
          rows,
          onChange: setConv,
          onClose: () => { orc.convClose().then(() => setConv(null), (e: unknown) => setError(why(e))); },
        })
      : h(SessionList, {
          // 폴더가 바뀌면 목록을 새로 만든다 — 옛 폴더의 세션을 열면 폴더가 되돌아간다.
          key: projects?.current.dir ?? '',
          // project 세션을 열면 서비스가 그 폴더로 옮긴다 (Task 8) — 프로젝트 바도 따라가야 폴더가 거짓말하지 않는다.
          onOpen: (v: SessionView) => { setConv(v); orc.projects().then(setProjects, (e: unknown) => setError(why(e))); },
          onError: setError,
        }));
  const body =
    screen === 'Session' ? null
    : screen === 'Dashboard' ? h(DashboardScreen, null)
    : screen === 'Agents' ? h(AgentsScreen, null)
    : screen === 'Reviews' ? h(ReviewsScreen, null)
    : h(DebugScreen, null);

  return h('div', { className: 'shell' },
    h('header', { className: 'titlebar' },
      h('span', { className: 'name' }, title),
      h('span', { className: 'meta' }, meta)),
    h(ProjectBar, {
      state: projects,
      onChange: (s: ProjectState) => {
        setProjects(s);
        setConv((c) => (c && c.kind === 'project' && c.dir !== s.current.dir ? null : c));
      },
      onError: setError,
    }),
    h('nav', { className: 'tabs' }, ...SCREENS.map((s) =>
      h('button', { key: s, 'aria-current': s === screen, onClick: () => setScreen(s) }, s))),
    h('main', null,
      error ? h('div', { className: 'stack' }, h('div', { className: 'banner error' }, error)) : null,
      session,
      body));
}

createRoot(document.getElementById('root') as HTMLElement).render(h(App, null));
