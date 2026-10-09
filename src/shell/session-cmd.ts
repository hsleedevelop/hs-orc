/**
 * `hs-orc session` — 다른 세션·오케스트레이터가 id 나 이름으로 대화 세션을 다룬다 (D-085).
 * 판단은 전부 `ConversationSession`(Core)에 있고 여기는 찾기·점유·출력만 한다. 표준 입력을 읽지 않는다 —
 * 부르는 쪽이 사람이 아니라 다른 에이전트일 수 있다.
 *
 *   hs-orc session ls [--json]
 *   hs-orc session show <id|이름> [--tail N] [--json]
 *   hs-orc session send <id|이름> "<메시지>" [--write] [--run] [--verify "<명령>"]...
 *   hs-orc session name <id|이름> <새 이름>        빈 문자열("")이면 이름을 지운다
 *   hs-orc session new [--role worker|orchestrator] [--name <이름>]   부른 폴더에 세션을 만든다 (D-090) — 엔진은 돌지 않는다
 */
import type { RowClassifier } from '../adapters/jev.ts';
import type { SlotExecutor } from '../core/executor.ts';
import { Journal } from '../core/journal.ts';
import { H6_BLOCKED, SESSION_NAME, type ConversationSession } from '../core/session.ts';
import { uncommittedFiles } from '../core/evidence-gather.ts';
import { claimSession, releaseSession } from '../core/session-lock.ts';
import { assertNotEnded, withRoleLock } from '../core/session-meta.ts';
import {
  isSessionRole,
  prepareSession,
  readSessionLog,
  recordedStatus,
  sessionRole,
  sessionStatus,
  type SessionRole,
  type SessionSummary,
  type TranscriptRecord,
} from '../core/transcript.ts';
import { renderRecord, renderRecords } from './chat.ts';
import { assembleSession, restoreBudget } from './conversation.ts';
import { assertNameFree, assertOrchestratorFree, resolveSession } from './session-registry.ts';
import { roleLabel, statusLabel } from './transcript-lines.ts';

export const SESSION_USAGE = [
  '사용법: hs-orc session <명령>',
  '  ls [--json]                                         아는 세션 전부 — id · 이름 · 상태 · 폴더',
  '  show <id|이름> [--tail N] [--json]                  상태와 끝 기록 N개(기본 10)',
  '  send <id|이름> "<메시지>" [--write] [--run] [--verify "<명령>"]...',
  '                                                      메시지 1건을 보내고 그 턴의 기록을 찍는다',
  '  name <id|이름> <새 이름>                            이름을 붙인다 ("" 은 지운다). 영문자로 시작, 영문·숫자·. _ -',
  '  new [--role worker|orchestrator] [--name <이름>]    부른 폴더에 세션을 만들고 id 를 찍는다 (기본 worker). 엔진은 돌지 않는다',
  '                                                      오케스트레이터는 폴더당 하나다 — 이미 있으면 거절한다 (D-090)',
  '',
  'send 는 --run 이 있어야 위임(읽기 위임·읽기 답 포함)을 시작한다 — 세션 방식이 auto·auto-ask 여도 같다(auto 는 GUI·chat 몫).',
  '--run 이 없으면 배정 카드는 거절로 남는다 — 제시만 했다. --run 이면 세션 방식대로 승인하고, 선 카드는 --run 이 승인한다.',
  '--run 은 카드의 쓰기 값을 따른다 — 쓰기 행 카드(D-086)는 --write 없이도 쓰기로 승인한다. 미커밋 변경이 있거나 확인 못 하면',
  '실행하지 않고 거절로 남긴다(exit 1) — 커밋하거나 --write 로 명시한다.',
  '--write 는 읽기 행 카드에도 쓰기를 켠다(미커밋 변경이 있어도 켠다 — 명시한 쓰기다).',
  '예외로 끝난 위임의 재시도 카드·스캐폴딩 카드(D-088)는 --run 이 있어도 승인하지 않는다. git 밖 쓰기 행(H6)은 --write 없이는 승인하지 않는다.',
  '다른 곳(GUI·chat)이 그 세션을 쥐고 있으면 거절한다. 종료된 세션(D-089)에는 send·name 을 거절한다 — show 는 된다.',
].join('\n');

export type SessionCommand =
  | { readonly cmd: 'help' }
  | { readonly cmd: 'ls'; readonly json: boolean }
  | { readonly cmd: 'show'; readonly ref: string; readonly tail: number; readonly json: boolean }
  | { readonly cmd: 'send'; readonly ref: string; readonly message: string; readonly write: boolean; readonly run: boolean; readonly verify: readonly string[] }
  | { readonly cmd: 'name'; readonly ref: string; readonly name: string }
  | { readonly cmd: 'new'; readonly role: SessionRole; readonly name: string };

export function parseSessionArgs(argv: readonly string[]): SessionCommand {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') return { cmd: 'help' };
  const positional: string[] = [];
  let json = false;
  let write = false;
  let run = false;
  let tail = 10;
  let role: string | null = null;
  let name: string | null = null;
  const verify: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? '';
    const value = (): string => {
      const next = rest[i + 1];
      if (next === undefined) throw new Error(`${arg} 에 값이 없다.`);
      i += 1;
      return next;
    };
    if (arg === '--json') json = true;
    else if (arg === '--write') write = true;
    else if (arg === '--run') run = true;
    else if (arg === '--verify') verify.push(value());
    else if (arg === '--role') role = value();
    else if (arg === '--name') name = value();
    else if (arg === '--tail') {
      tail = Number(value());
      if (!Number.isInteger(tail) || tail < 0) throw new Error(`--tail 은 0 이상의 정수다.`);
    } else if (arg.startsWith('--')) throw new Error(`모르는 옵션이다: ${arg}\n${SESSION_USAGE}`);
    else positional.push(arg);
  }
  // 조용한 폴백 금지 — 명령에 안 맞는 옵션·인자가 무시되면 부른 쪽은 켠 줄 안다.
  const allow = (flags: Record<string, boolean>, count: number): void => {
    const extra = Object.entries({ json, write, run, verify: verify.length > 0, tail: tail !== 10, role: role !== null, name: name !== null }).find(([k, on]) => on && !flags[k]);
    if (extra) throw new Error(`${cmd} 에는 --${extra[0]} 를 쓰지 않는다.\n${SESSION_USAGE}`);
    if (positional.length !== count) throw new Error(`${cmd} 은 인자 ${count}개를 받는다 (받음 ${positional.length}개).\n${SESSION_USAGE}`);
  };
  const [a = '', b = ''] = positional;
  switch (cmd) {
    case 'ls':
      allow({ json: true }, 0);
      return { cmd, json };
    case 'show':
      allow({ json: true, tail: true }, 1);
      return { cmd, ref: a, tail, json };
    case 'send':
      allow({ write: true, run: true, verify: true }, 2);
      if (!b.trim()) throw new Error('보낼 메시지가 비었다.');
      return { cmd, ref: a, message: b, write, run, verify };
    case 'name':
      allow({}, 2);
      return { cmd, ref: a, name: b };
    case 'new': {
      allow({ role: true, name: true }, 0);
      const picked = role ?? 'worker';
      if (!isSessionRole(picked)) throw new Error(`--role 은 worker · orchestrator 중 하나다 (받음 ${picked}).`);
      return { cmd, role: picked, name: (name ?? '').trim() };
    }
    default:
      throw new Error(`모르는 명령이다: ${cmd}\n${SESSION_USAGE}`);
  }
}

const shortTime = (at: string): string => (at ? at.slice(0, 16).replace('T', ' ') : '—');

/** `ls` 한 줄 — id 가 맨 앞이다. 부르는 쪽이 첫 칸을 잘라 다음 명령에 넣는다. */
export function listLines(sessions: readonly SessionSummary[]): string[] {
  if (sessions.length === 0) return ['세션 없음'];
  const width = Math.max(4, ...sessions.map((s) => (s.name ?? '-').length));
  return sessions.map((s) =>
    [s.id, (s.name ?? '-').padEnd(width), `${statusLabel(s.status)}${s.archived ? ' · 보관' : ''}`.padEnd(12), roleLabel(s.role).padEnd(7), s.kind.padEnd(7), shortTime(s.lastAt), s.dir, s.preview].join('  '),
  );
}

export function showLines(target: SessionSummary, tail: number): string[] {
  const { records, broken } = readSessionLog(target.dir, target.id);
  const visible = records.filter((r) => r.kind !== 'spend');
  const mode = records.findLast((r) => r.kind === 'mode');
  const status = sessionStatus(target.dir, target.id, records);
  return [
    `세션   ${target.kind} ${target.id}${target.name ? ` · 이름 ${target.name}` : ''} · ${target.dir}`,
    `상태   ${statusLabel(status)}${status.holder ? ` (${status.holder.by} · pid ${status.holder.pid})` : ''}`,
    `역할   ${roleLabel(sessionRole(records))}`,
    `방식   승인 방식 ${mode?.kind === 'mode' ? mode.mode : '(아직 기록 없음)'}`,
    `누적   ${restoreBudget(target.dir, target.id).summary()}`,
    ...(broken > 0 ? [`경고   기록에 깨진 줄 ${broken}개 — 건너뛰고 보여준다`] : []),
    ...(visible.length > tail ? [`       (앞 기록 ${visible.length - tail}개 생략)`] : []),
    ...(tail > 0 ? renderRecords(visible, visible.length - tail) : []),
  ];
}

export interface SendInput {
  readonly cwd: string;
  readonly ref: string;
  readonly message: string;
  readonly write: boolean;
  readonly run: boolean;
  readonly verify: readonly string[];
  /** 테스트용 — 주면 지휘자·위임 모두 이것을 쓴다. */
  readonly execute?: SlotExecutor;
  readonly classifier?: RowClassifier;
  /** 세션을 연 직후 — 진입점이 Ctrl-C(위임 취소)를 거는 자리다. */
  readonly onSession?: (session: ConversationSession) => void;
}

export interface SendOutcome {
  readonly target: SessionSummary;
  readonly records: readonly TranscriptRecord[];
  readonly lines: readonly string[];
  /** 0 = 오류 없이 끝났다(ok·unverified·직접 답·제시만). 1 = 오류 기록이나 완료가 아닌 결과(wrong·rework·cancelled), --run 을 H5 로 거절. */
  readonly exitCode: 0 | 1;
}

/**
 * 메시지 1건을 보낸다. 세션을 쥐고(다른 곳이 쥐었으면 던진다) 디스크의 기록으로 새로 조립한다 —
 * 들고 있던 객체가 없으니 낡을 수도 없다. 카드가 서면 `run` 이 승인, 아니면 거절로 남기고 놓는다.
 */
export async function sendToSession(input: SendInput): Promise<SendOutcome> {
  const target = resolveSession(input.cwd, input.ref);
  const { dir, id, kind } = target;
  claimSession(dir, id, 'working', 'cli');
  try {
    // 쥔 뒤에 본다 (D-089) — GUI 는 점유를 쥔 채 종료 표식을 쓴다.
    assertNotEnded(dir, id);
    const budget = restoreBudget(dir, id);
    const session = assembleSession({
      kind,
      dir,
      id,
      budget,
      journal: new Journal(),
      // --run 이 없으면 세션 방식이 auto·auto-ask 여도 위임·읽기 답을 시작하지 않는다 (D-085 결정 5, 전하 결정) — auto 는 GUI·chat 몫이다.
      autoStart: input.run,
      ...(input.classifier ? { classifier: input.classifier } : {}),
      ...(input.execute ? { execute: input.execute } : {}),
    });
    input.onSession?.(session);
    const out: TranscriptRecord[] = [...(await session.send(input.message, { write: input.write }))];
    const notes: string[] = [];
    // --run 을 받고도 시작하지 않았다(H5) — 제시만(0)과 가르게 exit 1 이다.
    let refused = false;
    if (session.state === 'blocked' && session.scaffoldPending) {
      // 스캐폴딩 카드(D-088)는 hs-orc 가 임의 명령을 실행하는 첫 경로라 사람이 카드를 보고 확인한다 — 미리 받은 --run 으로 넘기지 않는다.
      out.push(...session.reject());
      if (input.run) refused = true;
      notes.push('안내   스캐폴딩 카드는 --run 으로 승인하지 않는다 (H7, D-088) — GUI·hs-orc chat 에서 그 세션을 열고 명령을 확인해 실행한다.');
    } else if (session.state === 'blocked') {
      // 자동 승인된 위임이 예외로 끝나 다시 선 카드(D-081)는 사람이 실패를 보고 다시 승인하는 자리다 — 미리 받은 --run 으로 넘기지 않는다.
      const card = session.records().findLast((r) => r.kind === 'plan');
      const retry = card?.kind === 'plan' && card.retry === true;
      // --run 은 카드의 쓰기 값을 따른다 (D-085 결정 5-a, 전하 결정) — D-086 쓰기 행 카드는 --write 없이도 쓰기로 승인한다.
      // 미커밋 변경이 있거나 확인 못 하면(H5, fail-closed) 승인하지 않는다 — 읽기 전용으로 돌리면 쓰기 행이 파일을 못 고치고 헛돌며
      // 과금된다. 사람이 커밋하거나 --write 로 정한다. git 밖 쓰기 행(H6)은 카드가 원래 읽기 전용으로 선다.
      const cardWrite = card?.kind === 'plan' && card.write === true;
      const dirty = input.run && !retry && cardWrite && !input.write ? uncommittedFiles(dir) : [];
      const unsafe = dirty === null || dirty.length > 0;
      // git 밖 쓰기 행(H6)은 읽기 전용 승인을 막는다 (D-088) — --write 를 명시하면 쓰기로 승인한다(엔진이 거절하면 H4 대로다).
      const readOnlyBlocked = card?.kind === 'plan' && card.readOnlyBlocked === true && !input.write;
      if (input.run && readOnlyBlocked) {
        out.push(...session.reject());
        refused = true;
        notes.push(`안내   ${H6_BLOCKED} 실행하지 않고 거절로 남겼다.`);
      } else if (input.run && !retry && !unsafe) {
        out.push(...(await session.approve({ verify: input.verify, write: input.write || cardWrite })));
      } else {
        // 카드를 메모리에만 두고 나가면 기록 끝에 죽은 카드가 남는다 — 거절로 닫는다. 실행은 다시 보내며 --run 이다.
        out.push(...session.reject());
        if (input.run && !retry) refused = true;
        notes.push(
          retry ? '안내   위임이 예외로 끝났다 — 재시도 카드는 자동으로 승인하지 않는다(D-081). 오류를 보고 같은 메시지를 --run 으로 다시 보낸다.'
          : input.run ? `안내   쓰기 행 카드인데 ${dirty === null ? '미커밋 변경을 확인하지 못했다' : `미커밋 변경 ${dirty.length}개가 있다`} (H5) — 실행하지 않고 거절로 남겼다. 커밋하거나 --write 로 명시하라.`
          : '안내   제시만 했다 — 배정은 거절로 남겼다. 실행하려면 같은 메시지를 --run 을 붙여 다시 보낸다.',
        );
      }
    }
    const failed = out.some((r) => r.kind === 'error' || (r.kind === 'result' && r.outcome !== 'ok' && r.outcome !== 'unverified'));
    const lines = [
      ...renderRecords(out),
      ...notes,
      `상태   ${statusLabel(recordedStatus(session.records()))} · ${id}${session.name ? ` (${session.name})` : ''}`,
      `누적   ${budget.summary()}`,
    ];
    return { target, records: out, lines, exitCode: failed || refused ? 1 : 0 };
  } finally {
    releaseSession(dir, id);
  }
}

/** 이름을 붙인다. 다른 세션과 겹치면 던진다. 기록에 한 줄을 쓰므로 다른 곳이 쥐었으면 거절한다. */
export function nameSession(cwd: string, ref: string, name: string): { target: SessionSummary; line: string } {
  const target = resolveSession(cwd, ref);
  const next = name.trim();
  assertNameFree(cwd, next, target);
  claimSession(target.dir, target.id, 'working', 'cli');
  try {
    assertNotEnded(target.dir, target.id);
    const session = assembleSession({ kind: target.kind, dir: target.dir, id: target.id, budget: restoreBudget(target.dir, target.id), journal: new Journal() });
    const out = session.rename(next);
    return { target, line: out.length === 0 ? `이름   그대로 (${next || '없음'})` : renderRecord(out[0] as TranscriptRecord).join('\n') };
  } finally {
    releaseSession(target.dir, target.id);
  }
}

/**
 * 부른 폴더에 project 세션을 만든다 (D-090) — `role` 줄(워커여도)을 남겨 기록 파일이 생기고 `ls`·사이드바·찾기에 잡힌다. 이름을 주면 이름 줄도 남긴다.
 * 엔진·지휘자는 부르지 않고 방식·지휘자도 굳히지 않는다 — 첫 메시지(`send`)가 그때 기본값으로 굳힌다(새 세션으로 연다, session.ts 생성자).
 * 검사(이름 모양·겹침 · 오케스트레이터 0~1)를 다 지난 뒤에만 쓴다 — 중간에 던져 반쯤 만든 세션을 남기지 않는다.
 */
export function newSession(cwd: string, role: SessionRole, name: string): { target: SessionSummary; lines: string[] } {
  if (name && !SESSION_NAME.test(name)) throw new Error(`이름은 영문자로 시작하고 영문·숫자·. _ - 만 쓴다 (최대 32자): ${name}`);
  const { dir, id } = prepareSession('project', cwd);
  assertNameFree(cwd, name, { dir, id });
  const write = (): void => {
    claimSession(dir, id, 'working', 'cli');
    try {
      const session = assembleSession({ kind: 'project', dir, id, budget: restoreBudget(dir, id), journal: new Journal() });
      session.setRole(role);
      if (name) session.rename(name);
    } finally {
      releaseSession(dir, id);
    }
  };
  // 오케스트레이터는 폴더의 역할 잠금 안에서 검사하고 쓴다 (D-090) — 동시에 만든 두 프로세스가 둘 다 검사를 지나지 않게.
  if (role === 'orchestrator') withRoleLock(dir, () => { assertOrchestratorFree({ dir, id }); write(); });
  else write();
  const target: SessionSummary = { id, dir, kind: 'project', lastAt: '', preview: '', role, ...(name ? { name } : {}) };
  return {
    target,
    lines: [
      `${id}  ${roleLabel(role)}${name ? ` · 이름 ${name}` : ''} · ${dir}`,
      `안내   보내기: hs-orc session send ${name || id} "<메시지>" — 위임은 --run 이 있어야 시작한다`,
    ],
  };
}
