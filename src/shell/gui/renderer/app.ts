/**
 * Electron 렌더러 (D-021).
 *
 * Node 를 못 본다 — `window.orc`(preload)가 유일한 통로다.
 * **JSX 를 쓰지 않는다**(D-019): 번들러가 있어도 메인 프로세스·뷰모델과 같은 `.ts` 모양을 유지한다.
 * (원래 근거였던 TUI 와의 대조는 TUI 제거(D-077)로 없어졌다 — 규칙은 그대로 둔다.)
 *
 * 화면이 지키는 것 세 가지:
 *   1. **작업 폴더가 항상 보인다.** 엔진이 어디서 도는지 모르는 채로 --write 를 켜면 안 된다.
 *   2. **전송은 명시적이다.** 타이핑이 곧 호출이면 분류 폴백(D-026)이 키 입력마다 돈다.
 *   3. **승인은 화면에 찍힌 그 작업으로만 간다.** 입력을 고친 뒤 누른 승인은 막는다.
 */
import { createElement as h, useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { compactLines, cutLine, lastEvent, ladderLines, retryLines, statusLabel } from '../../transcript-lines.ts';

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
type ApprovalMode = 'manual' | 'auto-ask' | 'auto';
// `terminal.ts` 의 TERMINALS 와 같은 id — 렌더러는 node 모듈을 못 싣는다. 모르는 id 는 서비스가 거절한다.
const TERMINALS: { id: string; label: string }[] = [
  { id: 'default', label: '기본' },
  { id: 'ghostty', label: 'Ghostty' },
  { id: 'otty', label: 'Otty' },
];
// 고른 터미널은 이 기기의 화면 선호라 세션·프로젝트 상태에 두지 않는다.
const TERMINAL_KEY = 'hs-orc.terminal';

const MODES: { id: ApprovalMode; label: string; hint: string }[] = [
  { id: 'manual', label: 'manual', hint: '모든 배정을 묻는다' },
  { id: 'auto-ask', label: 'auto-ask', hint: '쓰기·모델이 고른 행·$10 이상·상한 근접·첫 위임만 묻는다' },
  { id: 'auto', label: 'auto', hint: '쓰기·모델이 고른 행만 묻는다' },
];
interface Cut { turns: number; chars: number }
interface Step { id: string; taskId: string; task: string; prompt: string; dependsOn: string[]; primary: string; reviewer: string; estimateUsd: number; write?: true }
interface OrchestratorChoice { model: string; effort: string }
// `conductor.ts` 의 OrchestratorOption 과 같은 모양 — 렌더러는 node 모듈을 못 싣는다.
interface OrchestratorOption { engine: string; defaults: OrchestratorChoice; models: { model: string; label: string; efforts: string[]; longContext: boolean }[] }
interface Compaction { trigger: string; preTokens?: number; postTokens?: number }
type Rec =
  | { kind: 'user'; turn: number; text: string }
  | { kind: 'direct'; turn: number; text: string; suggest: string | null; cost: string; notes: string[]; guide?: string[]; general?: true; read?: { slot: string; by: 'auto' | 'user' }; cut?: Cut; by?: string }
  | { kind: 'plan'; turn: number; taskId: string; title: string; reason: string; primary: string; reviewer: string; reviewer2?: string; estimateUsd: number; notes: string[]; guide?: string[]; mode?: ApprovalMode; asked?: { code: string; text: string }[]; write?: boolean; ladder?: { stage: string; label: string; from: string; changes: string[] }; retry?: true }
  | { kind: 'approval'; turn: number; approved: boolean; write: boolean; by?: 'user' | 'auto'; mode?: ApprovalMode }
  | { kind: 'mode'; turn: number; mode: ApprovalMode }
  | { kind: 'orchestrator'; turn: number; model: string; effort: string }
  | { kind: 'steps'; turn: number; title: string; steps: Step[]; estimateUsd: number; by: string; cost: string; cut?: Cut; write?: true; asked?: { code: string; text: string }[]; guide?: string[] }
  | { kind: 'name'; turn: number; name: string }
  | { kind: 'result'; turn: number; outcome: string; verdict: string; text: string; review: string; evidence: string; decisionId: string; cut?: Cut; compacted?: Compaction[]; step?: string }
  | { kind: 'summary'; turn: number; text: string; next: string; by?: string }
  | { kind: 'error'; turn: number; text: string };
interface Hold { pid: number; by: string; state: 'working' | 'blocked' }
interface SessionView { id: string; kind: SessionKind; dir: string; state: SessionState; records: Rec[]; broken: number; budget: string; appBudget: string; interrupted: boolean; cancellable: boolean; progress: string[]; mode: ApprovalMode; ladder: { stage: string; label: string; changes: string[] } | null; orchestrator: OrchestratorChoice & { engine: string; line: string }; stepsPending: boolean; name?: string; external: Hold | null }
interface SessionUsage { tokens: number; cacheReadTokens: number; cacheReadPartial?: true; billedUsd: number; convertedUsd: number }
type Activity = 'working' | 'blocked' | 'done' | 'interrupted' | 'idle';
interface SessionStatus { state: Activity; outcome?: string; holder?: { pid: number; by: string } }
interface SessionSummary { id: string; dir: string; kind: SessionKind; lastAt: string; preview: string; usage?: SessionUsage; name?: string; status?: SessionStatus }
interface ConversationTree { projects: { project: ProjectInfo; sessions: SessionSummary[] }[]; scratch: SessionSummary[] }

interface Bridge {
  convList(): Promise<ConversationTree>;
  convStart(kind: SessionKind): Promise<SessionView>;
  convOpen(payload: { kind: SessionKind; dir: string; id: string }): Promise<SessionView>;
  convView(): Promise<SessionView>;
  convSend(text: string, write?: boolean): Promise<SessionView>;
  convMode(mode: ApprovalMode): Promise<SessionView>;
  convOrchestrator(choice: OrchestratorChoice): Promise<SessionView>;
  convSteps(): Promise<SessionView>;
  orchestrators(): Promise<OrchestratorOption[]>;
  convPlanAs(taskId: string): Promise<SessionView>;
  convReplan(taskId: string): Promise<SessionView>;
  convRead(): Promise<SessionView>;
  convApprove(payload: { verify: string[]; write: boolean }): Promise<SessionView>;
  convCancel(): Promise<SessionView>;
  convEscalate(): Promise<SessionView>;
  convReject(): Promise<SessionView>;
  convAsk(): Promise<SessionView>;
  convTerminal(terminal: string): Promise<string>;
  convRename(name: string): Promise<SessionView>;
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
interface TaskRow { id: string; task: string; models: string }
interface Probe<T> { rows: T[]; note: string }
interface SessionRow { source: string; name: string; status: string; provenance: string }
interface ReviewRow { ref: string; title: string; state: string }
interface DashboardView { title: { text: string }; spent: string; distribution: { model: string; count: number }[]; outcomes: { outcome: string; count: number }[]; unverified: number }
interface DebugInfo { title: { text: string }; node: string; electron: string; pid: number; cwd: string; limits: Record<string, number> }

const orc = (window as unknown as { orc: Bridge }).orc;

const text = (s: string, className?: string) => h('div', className ? { className } : null, s);

/**
 * 도는 중 표시 — 스피너와 경과 초. 글자만 있으면 도는지 멈췄는지 눈으로 가릴 수 없다.
 * 초는 이 표시가 뜬 때부터 센다 — 다시 연 화면(D-063)은 실행 시작 시각을 모르므로 그 화면이 본 시간이다.
 */
function Running(props: { label: string }): ReactElement {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((now - start) / 1000);
  return h('div', { className: 'running dim', role: 'status' },
    h('span', { className: 'spinner', 'aria-hidden': true }),
    h('span', null, props.label),
    h('span', { className: 'mono' }, s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`));
}
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
// 뷰모델(`shell/view-model.ts`)이 만든 문자열을 **다시 해석하지 않는다.** 앞 라벨만 떼어 정렬·색만 준다.
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

/** 세션이 없을 때 본문. 목록은 사이드바에 있다. */
function NewSession(props: { onOpen: (v: SessionView) => void; onError: (m: string) => void }): ReactElement {
  const [busy, setBusy] = useState(false);
  const start = (kind: SessionKind) => {
    setBusy(true);
    orc.convStart(kind).then(props.onOpen, (e: unknown) => props.onError(why(e))).finally(() => setBusy(false));
  };
  return h('div', { className: 'stack' },
    card('새 세션',
      h('div', { className: 'row' },
        h('button', { className: 'btn accent', disabled: busy, onClick: () => start('project') }, '이 폴더에서 시작'),
        h('button', { className: 'btn', disabled: busy, onClick: () => start('scratch') }, '스크래치'),
        h('span', { className: 'hint' }, '스크래치는 폴더 없이 시작한다 — 쓰기를 켤 수 없다')),
      h('div', { className: 'hint', style: { marginTop: 8 } }, '지난 세션은 왼쪽 목록에서 연다')));
}

const sameSession = (a: { id: string; dir: string } | null, b: { id: string; dir: string }): boolean =>
  a !== null && a.id === b.id && a.dir === b.dir;

const kTokens = (n: number): string => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`);

/**
 * 사이드바 세션 행의 사용량 한 줄과 그 풀이(title). 줄에는 `토큰` 라벨을 빼 `환산` 이 잘리지 않게 한다 — 라벨은 title 에 있다. 구독제 환산액을 청구액처럼 보이지 않게 `환산` 을 붙인다 (D-030).
 * 캐시 읽기 내역을 모르는 보고가 섞였으면 비율은 하한이라 `≥` 를 붙이고, 아는 몫이 0 이면 비율을 뺀다 — 0% 는 거짓이다.
 */
function usageLine(u: SessionUsage): { line: string; title: string } {
  const share = u.tokens > 0 ? Math.round((u.cacheReadTokens / u.tokens) * 100) : 0;
  const cache = u.tokens === 0 || (u.cacheReadPartial && u.cacheReadTokens === 0) ? '' : ` · 캐시 ${u.cacheReadPartial ? '≥' : ''}${share}%`;
  const usd =
    u.billedUsd > 0 && u.convertedUsd > 0 ? `$${u.billedUsd.toFixed(4)} + $${u.convertedUsd.toFixed(4)} 환산`
    : u.billedUsd > 0 ? `$${u.billedUsd.toFixed(4)}`
    : `$${u.convertedUsd.toFixed(4)} 환산`;
  const title =
    `토큰 ${u.tokens.toLocaleString()} · 캐시 읽기 ${u.cacheReadTokens.toLocaleString()}${u.cacheReadPartial ? ' 이상 (내역 모르는 보고 섞임)' : ''}` +
    ` · 청구 $${u.billedUsd.toFixed(4)} · API 환산 $${u.convertedUsd.toFixed(4)} (구독제, 청구 안 됨)`;
  return { line: `${kTokens(u.tokens)}${cache} · ${usd}`, title };
}

/**
 * 프로젝트/세션 사이드바. 프로젝트 이름을 누르면 그 폴더로 옮기고, 세션을 누르면 그 세션을 연다
 * (project 세션은 서비스가 폴더도 옮긴다 — 화면의 폴더가 세션의 폴더다).
 */
function Sidebar(props: {
  current: string | undefined;
  open: SessionView | null;
  refresh: string;
  onOpen: (v: SessionView) => void;
  onProject: (s: ProjectState) => void;
  onError: (m: string) => void;
}): ReactElement {
  const { current, open, onOpen, onProject, onError } = props;
  // 다른 세션의 상태(D-085)는 다른 프로세스·도는 위임이 바꾼다 — 화면 밖 변화라 주기적으로 다시 읽는다.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 4000);
    return () => clearInterval(t);
  }, []);
  const tree = useAsync(() => orc.convList(), [props.refresh, tick]);
  const [busy, setBusy] = useState(false);
  // 접힌 묶음 키. 기본은 펼침 — 처음 보는 사람이 세션이 없다고 오해하지 않게.
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => setFolded((f) => { const n = new Set(f); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  const run = <T>(p: Promise<T>, done: (v: T) => void) => {
    setBusy(true);
    p.then(done, (e: unknown) => onError(why(e))).finally(() => setBusy(false));
  };
  const openSession = (s: SessionSummary) => {
    if (sameSession(open, s)) return;
    run(orc.convOpen({ kind: s.kind, dir: s.dir, id: s.id }), onOpen);
  };
  const useDir = (dir: string) => { if (dir !== current) run(orc.useProject(dir), onProject); };
  // 다른 폴더의 + 는 그 폴더로 옮긴 뒤 시작한다. 옮기기만 하고 실패하면 폴더는 바뀐 채 남는다 — 오류 배너로 드러난다.
  const startIn = (dir: string | null) =>
    run(
      (dir === null || dir === current ? Promise.resolve(null) : orc.useProject(dir).then((s) => { onProject(s); return s; }))
        .then(() => orc.convStart(dir === null ? 'scratch' : 'project')),
      onOpen,
    );

  const item = (s: SessionSummary): ReactElement => {
    const usage = s.usage ? usageLine(s.usage) : null;
    return h('button', {
      key: `${s.dir}::${s.id}`, className: 'sb-item', disabled: busy, title: s.dir,
      'aria-current': sameSession(open, s), onClick: () => openSession(s),
    },
    h('span', { className: 'p' }, s.preview || '(빈 세션)'),
    // 상태와 부르는 이름 (D-085) — 다른 세션·오케스트레이터가 `hs-orc session send <이 값>` 으로 부른다.
    h('span', { className: 's' },
      h('span', {
        className: `st ${s.status?.state ?? ''}${s.status?.state === 'done' && s.status.outcome !== 'ok' && s.status.outcome !== undefined ? ' bad' : ''}`,
        title: s.status?.holder ? `${s.status.holder.by} · pid ${s.status.holder.pid}` : '',
      }, statusLabel(s.status)),
      h('span', { className: 'ref', title: `id ${s.id}${s.name ? ` · 이름 ${s.name}` : ''}` }, s.name ? `${s.name} · ${s.id}` : s.id)),
    h('span', { className: 't' }, s.lastAt ? s.lastAt.slice(0, 16).replace('T', ' ') : '—'),
    usage ? h('span', { className: 'u', title: usage.title }, usage.line) : null);
  };

  // 첫 메시지 전의 세션은 기록 파일이 없어 목록에 안 잡힌다 — 열려 있는 동안은 자리를 보여 준다.
  const withOpen = (dir: string | null, sessions: SessionSummary[]): SessionSummary[] =>
    open && (dir === null ? open.kind === 'scratch' : open.kind === 'project' && open.dir === dir) && !sessions.some((s) => sameSession(open, s))
      ? [{ id: open.id, dir: open.dir, kind: open.kind, lastAt: '', preview: '(새 세션)', status: { state: 'idle' as const } }, ...sessions]
      : sessions;

  const group = (key: string, head: ReactNode, addTitle: string, addDir: string | null, sessions: SessionSummary[], extra = ''): ReactElement => {
    const shown = folded.has(key) ? [] : sessions;
    return h('div', { key, className: 'sb-group' },
      h('div', { className: `sb-head${extra}` },
        h('button', { className: 'sb-caret', 'aria-label': folded.has(key) ? '펼치기' : '접기', onClick: () => toggle(key) }, folded.has(key) ? '▸' : '▾'),
        head,
        h('span', { className: 'sb-count' }, String(sessions.length)),
        h('button', { className: 'sb-add', disabled: busy, title: addTitle, onClick: () => startIn(addDir) }, '＋')),
      ...shown.map(item),
      !folded.has(key) && sessions.length === 0 ? h('div', { className: 'sb-empty' }, '세션 없음') : null);
  };

  return h('aside', { className: 'sidebar' },
    h('div', { className: 'sb-title' }, '프로젝트'),
    !tree ? text('불러오는 중…', 'dim')
    : [
        ...tree.projects.map(({ project, sessions }) =>
          group(project.dir,
            h('button', {
              className: 'sb-name', disabled: busy || !project.exists, title: project.exists ? project.short : `${project.short} (없음)`,
              onClick: () => useDir(project.dir),
            }, project.name),
            '이 폴더에서 새 세션', project.dir, withOpen(project.dir, sessions),
            `${project.dir === current ? ' current' : ''}${project.exists ? '' : ' missing'}`)),
        group('::scratch', h('span', { className: 'sb-name static' }, '스크래치'), '새 스크래치 세션', null, withOpen(null, tree.scratch)),
      ]);
}

/** 세션 머리의 지휘자 선택 셋 — 엔진 · 모델 · effort (D-087). 선택지가 아직 없으면 지금 값 한 줄만 보인다. */
function orchestratorSelects(
  options: OrchestratorOption[],
  current: OrchestratorChoice & { engine: string; line: string },
  busy: boolean,
  pick: (choice: OrchestratorChoice) => void,
): ReactNode[] {
  const engine = options.find((o) => o.engine === current.engine);
  if (!engine) return [h('span', { key: 'orc', className: 'dim mono', title: current.line }, `지휘 · ${current.model}·${current.effort}`)];
  const model = engine.models.find((m) => m.model === current.model);
  return [
    h('select', {
      key: 'orc-engine', value: current.engine, disabled: busy, title: `지휘자 · ${current.line}`,
      onChange: (e: { target: { value: string } }) => { const o = options.find((x) => x.engine === e.target.value); if (o) pick(o.defaults); },
    }, ...options.map((o) => h('option', { key: o.engine, value: o.engine }, `지휘 · ${o.engine}`))),
    h('select', {
      key: 'orc-model', value: current.model, disabled: busy, title: current.line,
      onChange: (e: { target: { value: string } }) => {
        const m = engine.models.find((x) => x.model === e.target.value);
        // 지금 effort 를 그 모델이 받으면 유지하고, 못 받으면 그 모델의 마지막(가장 높은) effort 로 간다.
        if (m) pick({ model: m.model, effort: m.efforts.includes(current.effort) ? current.effort : (m.efforts.at(-1) ?? current.effort) });
      },
    }, ...engine.models.map((m) => h('option', { key: m.model, value: m.model }, `${m.label}${m.longContext ? ' [1m]' : ''}`))),
    h('select', {
      key: 'orc-effort', value: current.effort, disabled: busy, title: current.line,
      onChange: (e: { target: { value: string } }) => pick({ model: current.model, effort: e.target.value }),
    }, ...(model?.efforts ?? [current.effort]).map((x) => h('option', { key: x, value: x }, x))),
  ];
}

function SessionScreen(props: { view: SessionView; rows: TaskRow[]; onChange: (v: SessionView) => void; onClose: () => void }): ReactElement {
  const { onChange } = props;
  // 요청이 도는 동안 받은 뷰. 자동 승인 위임은 send 하나가 카드·승인·실행·결과를 모두 지나므로 (D-064 결정 7) 끝나기 전에는 카드도 취소 버튼(D-066)도 없다.
  const [peek, setPeek] = useState<SessionView | null>(null);
  const view = peek ?? props.view;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState('');
  const [verify, setVerify] = useState('');
  // null = 카드가 정한 대로(쓰기 위임으로 보낸 배정은 켜진 채 선다). 사람이 스위치를 만지면 그 값이 이긴다.
  const [write, setWrite] = useState<boolean | null>(null);
  const [sendWrite, setSendWrite] = useState(false);
  // 제안 없는 직접 답 아래의 행 선택 (D-079). 빈 값 = 아직 안 골랐다.
  const [pick, setPick] = useState('');
  const [terminal, setTerminal] = useState(() => localStorage.getItem(TERMINAL_KEY) ?? 'default');
  // 지휘자 선택지 (D-087) — 카탈로그라 세션 동안 바뀌지 않는다.
  const [orcOptions, setOrcOptions] = useState<OrchestratorOption[]>([]);
  useEffect(() => { orc.orchestrators().then(setOrcOptions, (e: unknown) => setError(why(e))); }, []);
  const [busy, setBusy] = useState(false);
  // 승인한 위임이 도는 동안의 화면 쪽 표시 (D-066). 요청이 안 끝났으니 `view.cancellable` 은 아직 갱신 전이다.
  const [delegation, setDelegation] = useState<'' | 'running' | 'cancelling'>('');
  const [error, setError] = useState('');
  // 이름 편집 중이면 입력값 (D-085). null = 편집 안 함.
  const [naming, setNaming] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // 요청이 도는 동안 뷰를 다시 읽는다 — 서비스의 뷰는 읽기뿐이라 도는 실행을 건드리지 않는다. 끝나면 요청이 돌려준 뷰가 이긴다.
  useEffect(() => {
    if (!busy) { setPeek(null); return; }
    let live = true;
    const t = setInterval(() => { orc.convView().then((v) => { if (live) setPeek(v); }, () => undefined); }, 400);
    return () => { live = false; clearInterval(t); };
  }, [busy]);

  // 쉬는 동안에도 뷰를 다시 읽는다 (D-085) — 다른 프로세스(`hs-orc session send`·`chat`)가 이 세션에 보내거나 쥐면 화면이 따라간다.
  // 서비스가 낡은 세션을 디스크로 다시 조립한다. 바뀐 것이 있을 때만 받는다 — 매번 받으면 입력 중 화면이 다시 그려진다.
  useEffect(() => {
    if (busy) return;
    let live = true;
    const cur = props.view;
    const t = setInterval(() => {
      orc.convView().then((v) => {
        const changed = v.records.length !== cur.records.length || v.state !== cur.state || v.name !== cur.name
          || v.external?.pid !== cur.external?.pid || v.external?.state !== cur.external?.state;
        if (live && changed) onChange(v);
      }, () => undefined);
    }, 2000);
    return () => { live = false; clearInterval(t); };
  }, [busy, props.view, onChange]);

  // 새 기록·진행 표시가 뜨면 그 자리로 간다 — 입력 아래에 가려 "아무 일 없음"으로 보이지 않게.
  // 'start' 는 맨 끝 표식에선 바닥까지 내린다. 'nearest' 는 main 아래 padding 만큼 덜 내려가 떠 있는 입력창이 최신 기록을 덮는다.
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, [view.records.length, busy]);

  const act = (p: Promise<SessionView>) => {
    setBusy(true);
    setError('');
    // 거절돼도 서비스 쪽 상태는 바뀌었을 수 있다 — 낡은 뷰(예: blocked 카드)를 남기지 않게 다시 받는다.
    p.then(onChange, (e: unknown) => {
      setError(why(e));
      orc.convView().then(onChange, (e2: unknown) => setError(`${why(e)} · 다시 불러오지 못했다: ${why(e2)}`));
    }).finally(() => { setBusy(false); setSending(''); setDelegation(''); });
  };
  const send = () => {
    const t = draft.trim();
    if (!t) return;
    setDraft('');
    setSending(t);
    act(orc.convSend(t, sendWrite && view.kind !== 'scratch'));
  };

  // 설정 줄(이름 D-085 · 승인 방식 · 지휘자 D-087)은 건너뛴다 — Core 와 같은 규칙이다.
  const last = lastEvent(view.records);
  // 다른 프로세스가 쥐었으면(D-085) 이 화면의 모든 조작을 막는다 — 눌러도 서비스가 거절한다.
  const locked = busy || !!view.external;
  // 배정 카드가 선 채 보내면 그 배정은 거절로 남는다 (D-064) — 제안 카드가 대화를 막지 않는다.
  const canType = (view.state === 'waiting_input' || view.state === 'blocked') && !busy && !view.external;

  const planCard = (r: Extract<Rec, { kind: 'plan' }>, i: number, active: boolean): ReactNode =>
    h('section', { key: i, className: 'card' },
      h('span', { className: 'label' }, `배정 · ${r.taskId}`),
      ...r.notes.map((n, j) => h('div', { key: `n${j}`, className: 'hint' }, n)),
      planLine(`분류 ${r.taskId} ${r.title}  (${r.reason})`, 0),
      planLine(`primary  ${r.primary}`, 1),
      planLine(`reviewer ${r.reviewer}`, 2),
      // 사다리 ④ 가 더한 reviewer (D-072) — 세 슬롯이고 판정은 AND 다.
      r.reviewer2 ? planLine(`reviewer ${r.reviewer2}  · 사다리 ④ 추가 — 둘 다 PASS 일 때만 PASS`, 5) : null,
      planLine(`비용 예상 $${r.estimateUsd}`, 3),
      // 다음 행동 안내 (D-074) — git 아닌 폴더의 쓰기 위임. manual 이면 H4 도 여기 실린다(묻는 이유가 비어서).
      ...(r.guide ?? []).map((g, j) => h('div', { key: `g${j}`, className: 'hint warn' }, g)),
      // 사다리 상향 카드는 무엇이 올라갔는지 보인다 (D-068) — 같은 요청을 올려 다시 위임하는 카드임을 첫 줄이 말한다.
      ...ladderLines(r.ladder).map((l, j) => h('div', { key: `l${j}`, className: j === 0 ? 'hint warn' : 'hint' }, l)),
      // 예외로 끝난 같은 배정을 다시 세운 카드다 (D-081) — 자동으로 다시 돌리지 않고 이 카드에서 다시 승인한다.
      ...retryLines(r.retry).map((l, j) => h('div', { key: `r${j}`, className: 'hint warn' }, l)),
      // 묻는 카드는 걸린 조건을 이름으로 보인다 (D-064) — 이유 없이 선 카드는 무엇을 봐야 할지 모른다.
      active && r.mode && r.mode !== 'manual' && r.asked && r.asked.length > 0
        ? h('div', { className: 'hint warn' }, `묻는 이유: ${r.asked.map((a) => a.text).join(' · ')}`)
        : null,
      active
        ? h('div', { className: 'stack', style: { padding: 0, width: '100%', marginTop: 10 } },
            h('div', { className: 'row' },
              // 행을 바꾸면 이 배정을 거절하고 새 행으로 다시 받는다 — 승인은 화면에 찍힌 그 배정으로만 간다.
              // 고른 값은 핸들러 안에서 바로 넘긴다 — controlled select 라 핸들러가 끝나면 React 가 DOM 값을 옛 행으로 되돌린다.
              h('select', {
                value: r.taskId,
                disabled: locked,
                onChange: (e: { target: { value: string } }) => act(orc.convReplan(e.target.value)),
              }, ...props.rows.map((row) => h('option', { key: row.id, value: row.id }, `${row.id} · ${row.task}`))),
              h('span', { className: 'hint' }, '업무 행 직접 지정')),
            h('textarea', {
              className: 'code', rows: 2, value: verify, placeholder: '검증 명령 · 한 줄에 하나 (예: npm test)',
              onChange: (e: { target: { value: string } }) => setVerify(e.target.value),
            }),
            h('label', { className: 'toggle' },
              h('input', {
                type: 'checkbox', checked: (write ?? r.write === true) && view.kind !== 'scratch', disabled: view.kind === 'scratch',
                onChange: (e: { target: { checked: boolean } }) => setWrite(e.target.checked),
              }),
              h('span', { className: 'track' }),
              h('span', { className: 'text' },
                view.kind === 'scratch' ? '스크래치는 쓰기를 켤 수 없다'
                : (write ?? r.write === true) ? h('b', null, 'primary 슬롯이 이 폴더의 파일을 고칠 수 있다')
                : 'primary 슬롯 파일 쓰기 (--write)',
                h('span', { className: 'dim' }, ' · reviewer 는 언제나 읽기 전용'))),
            h('div', { className: 'row' },
              h('button', {
                className: 'btn accent', disabled: locked,
                onClick: () => { setDelegation('running'); act(orc.convApprove({ verify: lines(verify), write: (write ?? r.write === true) && view.kind !== 'scratch' })); },
              }, busy ? '실행 중…' : `승인하고 실행 · ${r.reviewer2 ? '세' : '두'} 슬롯${(write ?? r.write === true) && view.kind !== 'scratch' ? ' · 쓰기 켜짐' : ''}`),
              h('button', { className: 'btn', disabled: locked, onClick: () => act(orc.convReject()) }, '거절'),
              // 규칙이 대화성 후속을 작업 행으로 잡았을 때 — 거절하고 같은 메시지를 지휘자가 답한다 (D-038).
              h('button', { className: 'btn', disabled: locked, onClick: () => act(orc.convAsk()) }, '지휘자에게 묻기'),
              // 한 행으로 안 끝날 요청이면 — 이 배정을 거절로 남기고 지휘자가 단계로 나눈다 (D-087).
              h('button', { className: 'btn', disabled: locked, onClick: () => act(orc.convSteps()) }, '단계로 나눠 계획')))
        : null);

  // 지휘자가 마지막 메시지를 위임 단계로 나눈다 (D-087). 카드만 선다 — 시작은 그 카드의 승인이다.
  const stepsButton = (): ReactNode =>
    h('div', { className: 'row', style: { whiteSpace: 'normal', marginTop: 6 } },
      h('button', { className: 'btn', disabled: locked, onClick: () => act(orc.convSteps()) }, '단계로 나눠 계획'),
      h('span', { className: 'hint' }, `${view.orchestrator.line} 가 이 요청을 위임 단계로 나눈다 — 승인하면 단계마다 차례로 위임`));

  const stepsCard = (r: Extract<Rec, { kind: 'steps' }>, i: number, active: boolean): ReactNode =>
    h('section', { key: i, className: 'card' },
      h('span', { className: 'label' }, `단계 계획 · ${r.steps.length}단계`),
      h('div', { className: 'hint' }, `계획 · ${r.by} · ${r.cost}`),
      ...r.steps.flatMap((st, j) => [
        planLine(`분류 ${st.id} · ${st.taskId} ${st.task}${st.write ? ' · 쓰기 행' : ''}${st.dependsOn.length > 0 ? `  (← ${st.dependsOn.join(', ')})` : ''}`, j * 4),
        h('div', { key: j * 4 + 1, className: 'hint', style: { whiteSpace: 'pre-wrap' } }, st.prompt),
        planLine(`primary  ${st.primary}`, j * 4 + 2),
        planLine(`reviewer ${st.reviewer}  · $${st.estimateUsd}`, j * 4 + 3),
      ]),
      planLine(`비용 예상 $${r.estimateUsd} · 단계 합 · 순서대로 하나씩 돈다`, r.steps.length * 4),
      // 다음 행동 안내 (D-074·D-086) — git 아닌 폴더의 쓰기 행 스캐폴더.
      ...(r.guide ?? []).map((g, j) => h('div', { key: `g${j}`, className: 'hint warn' }, g)),
      ...cutLine(r.cut).map((l, j) => h('div', { key: `c${j}`, className: 'hint' }, l)),
      active
        ? h('div', { className: 'stack', style: { padding: 0, width: '100%', marginTop: 10 } },
            // 묻는 조건 (D-086) — 늘 H1(지휘자가 고른 행), 쓰기면 H5(미커밋), git 밖 쓰기 행이면 H6. 옛 기록은 H1 문구만 있다.
            h('div', { className: 'hint warn' }, `묻는 이유: ${(r.asked ?? [{ code: 'H1', text: '단계의 행을 지휘자(모델)가 골랐다' }]).map((a) => a.text).join(' · ')}`),
            h('textarea', {
              className: 'code', rows: 2, value: verify, placeholder: '검증 명령 · 단계마다 돈다 · 한 줄에 하나 (예: npm test)',
              onChange: (e: { target: { value: string } }) => setVerify(e.target.value),
            }),
            // 쓰기 행 단계가 있을 때만 선다 (D-086) — 켜면 그 단계들만 쓴다. 읽기 행 단계는 켜도 읽기 전용이다.
            r.steps.some((st) => st.write)
              ? h('label', { className: 'toggle' },
                  h('input', {
                    type: 'checkbox', checked: (write ?? r.write === true) && view.kind !== 'scratch', disabled: view.kind === 'scratch',
                    onChange: (e: { target: { checked: boolean } }) => setWrite(e.target.checked),
                  }),
                  h('span', { className: 'track' }),
                  h('span', { className: 'text' },
                    (write ?? r.write === true) ? h('b', null, '쓰기 행 단계의 primary 슬롯이 이 폴더의 파일을 고칠 수 있다') : '쓰기 행 단계 파일 쓰기 (--write)',
                    h('span', { className: 'dim' }, ' · 읽기 행 단계와 reviewer 는 언제나 읽기 전용')))
              : h('div', { className: 'hint' }, '쓰기 행 단계가 없다 — 모든 단계가 읽기 전용으로 돈다'),
            h('div', { className: 'row' },
              h('button', {
                className: 'btn accent', disabled: locked,
                onClick: () => { setDelegation('running'); act(orc.convApprove({ verify: lines(verify), write: (write ?? r.write === true) && view.kind !== 'scratch' })); },
              }, busy ? '실행 중…' : `승인하고 실행 · ${r.steps.length}단계${(write ?? r.write === true) && view.kind !== 'scratch' ? ' · 쓰기 행 쓰기 켜짐' : ''}`),
              h('button', { className: 'btn', disabled: locked, onClick: () => act(orc.convReject()) }, '거절')))
        : null);

  const record = (r: Rec, i: number): ReactNode => {
    switch (r.kind) {
      case 'user':
        return h('div', { key: i, className: 'bubble user' }, r.text);
      case 'direct': {
        const suggest = r.suggest;
        return h('div', { key: i, className: 'bubble orc' },
          ...r.notes.map((n, j) => h('div', { key: `n${j}`, className: 'hint' }, n)),
          ...(r.guide ?? []).map((g, j) => h('div', { key: `g${j}`, className: 'hint warn' }, g)),
          h('div', null, r.text),
          // 읽기 답(D-083)은 지휘자가 아니라 읽기 전용 엔진 1슬롯이 낸 답이다 — reviewer 판정이 없다는 것을 같이 말한다.
          h('div', { className: 'hint' }, r.read
            ? `코드를 읽고 답함 · ${r.read.slot} · 읽기 전용 · reviewer 없음 · ${r.read.by === 'auto' ? 'Jev GENERAL 자동' : '요청'} · ${r.cost}`
            : `직접 답 · ${r.by ?? '지휘자·Haiku·low'} · ${r.cost}`),
          ...cutLine(r.cut).map((l, j) => h('div', { key: `c${j}`, className: 'hint' }, l)),
          suggest && r === last && view.state === 'waiting_input'
            ? h('button', { className: 'btn accent', disabled: locked, onClick: () => act(orc.convPlanAs(suggest)) }, `${suggest} 로 위임`)
            : null,
          // 제안이 없으면(Jev NONE·확신도 미만이면 지휘자 제안을 버린다, D-065) 사람이 행을 고른다 — CLI `/task Rxx` 와 같은 경로다 (D-079).
          // 카드만 선다 — 쓰기 스위치·승인은 그 카드에서 한다.
          !suggest && r === last && view.state === 'waiting_input'
            ? h('div', { style: { marginTop: 8 } },
                // GENERAL 이면 선택기 앞에서 행에 안 맞는 작업이라고 말한다 — 고르는 행은 가장 가까운 것일 뿐이다 (D-082).
                r.general ? h('div', { className: 'hint warn' }, '행에 안 맞는 작업 (Jev GENERAL) — 업무 행 어디에도 맞지 않는다. 위임하려면 가장 가까운 행을 고른다') : null,
                // 지휘자는 파일을 못 읽는다(D-080) — 코드를 읽어야 답할 질문이면 읽기 전용 1슬롯이 답한다 (D-083). 이 클릭이 승인이다(카드 없음).
                r.read ? null : h('div', { className: 'row', style: { whiteSpace: 'normal', marginBottom: 6 } },
                  h('button', { className: 'btn accent', disabled: locked, onClick: () => act(orc.convRead()) }, '코드를 읽고 답하기'),
                  h('span', { className: 'hint' }, '읽기 전용 엔진 1슬롯(Luna·medium)이 이 폴더를 읽고 답한다 — 파일을 고치지 않고 reviewer 판정이 없다')),
                h('div', { className: 'row', style: { whiteSpace: 'normal' } },
                  // option 은 글자 크기를 따로 못 준다 — 고른 행의 모델은 선택기 아래 서브타이틀로 보인다.
                  h('div', { className: 'pick' },
                    h('select', {
                      value: pick, disabled: locked, 'aria-label': '위임할 업무 행',
                      onChange: (e: { target: { value: string } }) => setPick(e.target.value),
                    }, h('option', { value: '' }, '업무 행 선택…'), ...props.rows.map((row) => h('option', { key: row.id, value: row.id }, `${row.id} · ${row.task}`))),
                    pick ? h('span', { className: 'sub', title: 'primary · reviewer (기본 effort)' }, props.rows.find((row) => row.id === pick)?.models ?? '') : null),
                  h('button', { className: 'btn', disabled: locked || !pick, onClick: () => { setPick(''); act(orc.convPlanAs(pick)); } }, '위임하기'),
                  h('span', { className: 'hint' }, '행을 직접 골라 위임 — 배정 카드가 서고 승인은 그대로다')))
            : null,
          r === last && view.state === 'waiting_input' && !r.read ? stepsButton() : null);
      }
      case 'plan':
        return planCard(r, i, r === last && view.state === 'blocked');
      case 'approval':
        // 자동 승인도 카드·비용은 그대로 위에 보인다 (G2·FR-5) — 승인 클릭만 없다 (D-064 결정 7).
        return h('div', { key: i, className: 'hint' }, r.approved && r.by === 'auto' ? `자동 승인 · ${r.mode ?? ''} · 묻는 조건 없음` : r.approved ? `승인${r.write ? ' · 쓰기 켜짐' : ''}` : '거절');
      case 'mode':
        return h('div', { key: i, className: 'hint' }, `승인 방식 → ${r.mode}`);
      case 'orchestrator':
        return h('div', { key: i, className: 'hint' }, `지휘자 → ${r.model}·${r.effort}`);
      case 'steps':
        return stepsCard(r, i, r === last && view.state === 'blocked' && view.stepsPending);
      case 'name':
        return h('div', { key: i, className: 'hint' }, r.name ? `이름 → ${r.name}` : '이름 지움');
      case 'result':
        return h('section', { key: i, className: 'card' },
          h('span', { className: 'label' }, `위임 결과${r.step ? ` · 단계 ${r.step}` : ''} · ${r.decisionId}`),
          h('div', { className: 'row' },
            // 취소는 판정이 없다 (D-066) — UNKNOWN 칩을 붙이면 reviewer 가 돌고 판정을 못 낸 것처럼 읽힌다.
            r.outcome === 'cancelled' ? null : h('span', { className: `chip ${r.verdict}` }, r.verdict.toUpperCase()),
            h('span', { className: r.outcome === 'ok' ? 'good mono' : 'warn mono' }, `outcome = ${r.outcome}`)),
          h('div', { className: r.outcome === 'ok' ? 'good mono' : 'warn mono' }, r.evidence),
          h('pre', { style: { marginTop: 10 } }, r.text || '(빈 출력)'),
          r.review ? h('pre', { style: { marginTop: 10 } }, r.review) : null,
          // 카드는 말풍선(pre-wrap)과 달리 공백을 접는다 — 같은 문구(`맥락   …`)가 두 자리에서 달라 보이지 않게 맞춘다.
          // 첫 줄만 띄운다 — 붙이면 pre 블록 테두리에 닿아 출력의 일부처럼 보인다.
          ...[...cutLine(r.cut), ...compactLines(r.compacted)].map((l, j) => h('div', { key: `c${j}`, className: 'hint', style: { whiteSpace: 'pre-wrap', marginTop: j === 0 ? 8 : 0 } }, l)));
      case 'summary':
        return h('div', { key: i, className: 'bubble orc' },
          r.text ? h('div', null, r.text) : null,
          r.next ? h('div', { className: 'warn' }, r.next) : null,
          r.by && r.text ? h('div', { className: 'hint' }, `요약 · ${r.by}`) : null);
      case 'error':
        return h('div', { key: i, className: 'banner error' }, r.text);
    }
  };

  return h('div', { className: 'stack' },
    h('div', { className: 'row' },
      // 경로는 줄바꿈하지 않는다 — `hs-` 에서 끊기면 없는 경로처럼 읽힌다. 길면 `elide` 가 앞을 자르고 전체는 title 로 본다.
      h('span', { className: 'mono dim', title: view.dir, style: { whiteSpace: 'nowrap' } }, view.kind === 'scratch' ? `스크래치 · ${elide(view.dir, 36)}` : elide(view.dir, 44)),
      // 이 세션을 부르는 값 (D-085) — 누르면 복사한다. 다른 세션·오케스트레이터가 `hs-orc session send <id|이름>` 으로 쓴다.
      h('button', {
        className: 'btn mono', title: `id ${view.id} — 눌러서 복사`,
        onClick: () => { void navigator.clipboard?.writeText(view.id); },
      }, view.id),
      naming === null
        ? h('button', {
            className: 'btn', disabled: locked, title: '이름을 붙이면 id 대신 이름으로 부를 수 있다',
            onClick: () => setNaming(view.name ?? ''),
          }, view.name ? `이름 ${view.name}` : '이름 붙이기')
        : h('input', {
            type: 'text', className: 'code', autoFocus: true, value: naming, style: { width: 160 },
            placeholder: '영문자로 시작 · 영문·숫자·. _ - · 비우면 지움',
            onChange: (e: { target: { value: string } }) => setNaming(e.target.value),
            onBlur: () => setNaming(null),
            onKeyDown: (e: { key: string; preventDefault: () => void }) => {
              if (e.key === 'Enter') { e.preventDefault(); act(orc.convRename(naming)); setNaming(null); }
              if (e.key === 'Escape') setNaming(null);
            },
          }),
      h('div', { className: 'spacer' }),
      // 방식은 세션 값이다 (D-064). 바꿔도 이미 선 카드는 자동 승인하지 않는다 — 다음 배정부터다.
      h('select', {
        value: view.mode, disabled: locked, title: MODES.find((m) => m.id === view.mode)?.hint ?? '',
        onChange: (e: { target: { value: string } }) => act(orc.convMode(e.target.value as ApprovalMode)),
      }, ...MODES.map((m) => h('option', { key: m.id, value: m.id, title: m.hint }, `승인 · ${m.label}`))),
      h('span', { className: 'dim mono' }, view.budget),
      h('span', { className: 'dim mono' }, view.appBudget),
      // 엔진이 도는 중에도 연다 — 세션 상태를 건드리지 않고 그 폴더를 사람 손에 넘길 뿐이다.
      h('select', {
        value: terminal, title: '터미널 버튼이 여는 앱',
        onChange: (e: { target: { value: string } }) => { setTerminal(e.target.value); localStorage.setItem(TERMINAL_KEY, e.target.value); },
      }, ...TERMINALS.map((t) => h('option', { key: t.id, value: t.id }, t.label))),
      h('button', { className: 'btn', title: `${view.dir} 에서 터미널 열기`, onClick: () => { orc.convTerminal(terminal).catch((e: unknown) => setError(why(e))); } }, '터미널'),
      h('button', { className: 'btn', onClick: props.onClose }, '세션 닫기')),
    // 지휘자 (D-087) — 머리 줄과 따로 둔다: 한 줄에 넣으면 좁은 창에서 Budget 글이 접히고 터미널 선택이 밀려난다.
    // 엔진을 바꾸면 그 벤더의 기본 모델·effort 로 시작한다. 도는 호출은 시작한 지휘자로 끝난다.
    h('div', { className: 'row' },
      ...orchestratorSelects(orcOptions, view.orchestrator, locked, (choice) => act(orc.convOrchestrator(choice))),
      h('span', { className: 'hint' }, '지휘자 — 직접 답·요약·단계 계획을 맡는다. 위임 슬롯은 매트릭스가 배정한다')),
    view.broken > 0 ? h('div', { className: 'banner error' }, `기록에 깨진 줄 ${view.broken}개 — 건너뛰고 보여준다`) : null,
    view.interrupted ? h('div', { className: 'banner error' }, '승인한 위임의 결과가 기록되지 않았다 — 실행 중 앱이 끊겼다. 결정 로그 1차 줄만 남아 있을 수 있다.') : null,
    ...view.records.map(record),
    // 미검증·실패 뒤 사다리 다음 단계 (D-068) — 누르면 배정 카드만 선다. 시작은 카드의 승인이다(어느 방식에서도 A3 로 묻는다).
    view.ladder && view.state === 'waiting_input' && !busy
      ? h('div', { className: 'row' },
          h('button', { className: 'btn accent', onClick: () => act(orc.convEscalate()) }, '사다리 다음 단계로 다시 위임'),
          h('span', { className: 'hint' }, view.ladder.changes.at(-1) ?? view.ladder.label))
      : null,
    // 도는 중 받은 뷰에 이미 그 메시지가 실려 있으면 임시 말풍선을 또 띄우지 않는다.
    sending && !(peek && peek.records.length > props.view.records.length) ? h('div', { className: 'bubble user dim' }, sending) : null,
    // 다시 연 화면은 `busy` 를 모른다 — 서비스가 working 이면 도는 실행에 붙은 것이다 (D-063). 결과는 앞 화면이 건 요청이 돌아오며 싣는다.
    // key 를 고정한다 — 도는 중 기록 줄이 늘면(승인·방식 줄) 자리가 밀려 다시 마운트되고 경과 초가 0 으로 돌아간다.
    // 다른 프로세스가 쥐었다 (D-085) — 이 화면은 그 실행을 멈출 수 없다. 끝나면 쉬는 동안의 다시 읽기가 결과를 싣는다.
    view.external && !busy
      ? h('div', { key: 'external', className: 'row' },
          view.external.state === 'working'
            ? h(Running, { label: `다른 곳에서 도는 중 · ${view.external.by} · pid ${view.external.pid}` })
            : h('div', { className: 'hint warn' }, `다른 곳(${view.external.by} · pid ${view.external.pid})에 배정 카드가 승인을 기다린다 — 거기서 답한다`))
      : null,
    busy || view.state === 'working'
      ? h('div', { key: 'running', className: 'row' },
          h(Running, { label: delegation === 'cancelling' ? '취소하는 중…' : (view.state === 'blocked' || last?.kind === 'plan' || last?.kind === 'approval') ? '실행 중…' : '생각 중…' }),
          // 위임(primary·reviewer)이 도는 동안만 뜬다 (D-066). 다시 연 화면(D-063)은 서비스가 준 `cancellable` 로 같이 뜬다.
          // 취소는 그 위임만 멈춘다 — 세션은 남고, 돌아오는 뷰가 취소 결과 카드를 싣는다.
          delegation === 'running' || (delegation === '' && view.cancellable)
            ? h('button', { className: 'btn danger', onClick: () => { setDelegation('cancelling'); act(orc.convCancel()); } }, '취소')
            : null)
      : null,
    // 엔진이 도는 중 한 일 (D-084) — 중간 답 글·도구 호출. column-reverse 라 스크롤이 늘 끝(최신 줄)에 붙는다.
    (busy || view.state === 'working') && view.progress.length > 0
      ? h('div', { style: { maxHeight: 240, overflow: 'auto', display: 'flex', flexDirection: 'column-reverse' } },
          h('pre', { className: 'plain mono' }, view.progress.slice(-60).join('\n')))
      : null,
    error ? h('div', { className: 'banner error' }, error) : null,
    h('section', { className: 'card composer' },
      h('textarea', {
        rows: 3, value: draft, disabled: !canType,
        placeholder: view.state === 'blocked' ? '배정을 승인·거절하거나, 메시지를 보내면 이 배정은 거절로 남는다 · ⌘↵ 전송' : '메시지 · ⌘↵ 전송',
        onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
        onKeyDown: (e: { key: string; metaKey: boolean; ctrlKey: boolean; preventDefault: () => void }) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
        },
      }),
      h('div', { className: 'row', style: { marginTop: 10 } },
        h('label', { className: 'hint', title: '쓰기 행(구현·수정)은 git 폴더에서 이미 쓰기가 켜진다 — 이 체크는 그 밖의 메시지를 쓰기로 보낼 때 쓴다. auto 가 아니면 카드가 선다 (D-086)' },
          h('input', {
            type: 'checkbox', checked: sendWrite && view.kind !== 'scratch', disabled: view.kind === 'scratch',
            onChange: (e: { target: { checked: boolean } }) => setSendWrite(e.target.checked),
          }), ' 쓰기 위임으로 보내기'),
        h('div', { className: 'spacer' }),
        h('button', { className: 'btn accent', disabled: !canType || !draft.trim(), onClick: send }, '전송'))),
    // 끝 표식은 떠 있는 입력창 뒤에 둔다 — 앞에 두면 그 자리로 가도 입력창이 최신 기록을 덮는다.
    h('div', { ref: endRef }));
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
  // 세션을 바꾼 뒤 늦게 돌아온 앞 세션의 응답이 새 세션 화면을 덮지 않게 같은 세션의 뷰만 받는다.
  const accept = useCallback((v: SessionView) => setConv((c) => (sameSession(c, v) ? v : c)), []);
  // project 세션을 열면 서비스가 그 폴더로 옮긴다 (Task 8) — 프로젝트 바도 따라가야 폴더가 거짓말하지 않는다.
  const opened = useCallback((v: SessionView) => {
    setConv(v);
    setScreen('Session');
    orc.projects().then(setProjects, (e: unknown) => setError(why(e)));
  }, []);
  const moved = useCallback((s: ProjectState) => {
    setProjects(s);
    setConv((c) => (c && c.kind === 'project' && c.dir !== s.current.dir ? null : c));
  }, []);

  // Session 은 **숨기기만 한다.** 언마운트하면 입력·배정·진행 중인 실행 결과가 탭 이동 한 번에 사라진다.
  // 나머지 화면은 읽기 전용 조회라 들어올 때마다 다시 불러오는 편이 맞다(실행 뒤 대시보드가 낡지 않게).
  const session = h('div', { key: 'session', hidden: screen !== 'Session' },
    conv
      ? h(SessionScreen, {
          // 세션마다 화면 상태(입력·진행 표시)가 따로다 — 사이드바로 바꾸면 새로 만든다.
          key: `${conv.dir}::${conv.id}`,
          view: conv,
          rows,
          onChange: accept,
          onClose: () => { orc.convClose().then(() => setConv(null), (e: unknown) => setError(why(e))); },
        })
      : h(NewSession, { onOpen: opened, onError: setError }));
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
    h('div', { className: 'workspace' },
      h(Sidebar, {
        current: projects?.current.dir,
        open: conv,
        refresh: `${projects?.current.dir ?? ''}|${conv ? `${conv.dir}::${conv.id}::${conv.records.length}` : ''}`,
        onOpen: opened,
        onProject: moved,
        onError: setError,
      }),
      h('div', { className: 'content' },
        h(ProjectBar, { state: projects, onChange: moved, onError: setError }),
        h('nav', { className: 'tabs' }, ...SCREENS.map((s) =>
          h('button', { key: s, 'aria-current': s === screen, onClick: () => setScreen(s) }, s))),
        h('main', null,
          error ? h('div', { className: 'stack' }, h('div', { className: 'banner error' }, error)) : null,
          session,
          body))));
}

createRoot(document.getElementById('root') as HTMLElement).render(h(App, null));
