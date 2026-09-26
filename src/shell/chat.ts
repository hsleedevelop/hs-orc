/**
 * `hs-orc chat` — 줄 입력 대화 세션 (D-056). 판단은 전부 `ConversationSession`(Core)에 있고
 * 여기는 기록을 터미널 줄로 그리고 입력을 세션 호출로 옮긴다.
 */
import { createInterface } from 'node:readline';
import type { Budget } from '../core/budget.ts';
import type { ConversationSession } from '../core/session.ts';
import { listScratchSessions, listSessions, readTranscript, type SessionSummary, type TranscriptRecord } from '../core/transcript.ts';
import { compactLines, cutLine } from './transcript-lines.ts';

export function renderRecord(r: TranscriptRecord): string[] {
  switch (r.kind) {
    case 'user':
      return [`나     ${r.text}`];
    case 'direct':
      return [
        ...r.notes.map((n) => `분류   ${n}`),
        r.text,
        `비용   ${r.cost}`,
        ...(r.suggest ? [`제안   ${r.suggest} — /task ${r.suggest} 로 위임한다`] : []),
        ...cutLine(r.cut),
      ];
    case 'plan':
      return [
        ...r.notes.map((n) => `분류   ${n}`),
        `업무   ${r.taskId} ${r.title}  (${r.reason})`,
        `배정   primary  ${r.primary}`,
        `       reviewer ${r.reviewer}`,
        `비용   $${r.estimateUsd} (추정)`,
      ];
    case 'approval':
      return [r.approved ? `승인   ${r.write ? '쓰기 켬 — primary 가 파일을 고칠 수 있다' : '읽기 전용'}` : '거절'];
    case 'result':
      return [
        `결과   ${r.outcome} · reviewer ${r.verdict.toUpperCase()} · 결정 ${r.decisionId}`,
        `증거   ${r.evidence}`,
        r.text,
        ...(r.review ? [`검증   ${r.review.slice(0, 600)}`] : []),
        ...cutLine(r.cut),
        ...compactLines(r.compacted),
      ];
    case 'summary':
      return [...(r.text ? [r.text] : []), `다음   ${r.next}`];
    case 'error':
      return [`오류   ${r.text}`];
    case 'spend':
      // Budget 을 되살리는 재료다 (D-054) — 화면에 찍지 않는다.
      return [];
  }
}

export const CHAT_HELP = [
  '명령   메시지를 그냥 쓰면 보낸다 · /task Rxx 마지막 메시지를 그 행으로 배정 · /help · /quit (Ctrl-D)',
  '승인   배정이 뜨면 y 읽기 전용 · w 쓰기 · n 거절 · a 지휘자에게 묻기',
].join('\n');

export interface ChatIO {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

const why = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 입력이 끝나거나 `/quit` 이면 끝난다. 줄은 하나씩 순서대로 처리한다(`for await`) — 겹친 세션 호출이 없다.
 * 승인 대기(`blocked`) 중에는 줄을 답(y·w·n·a)으로 읽는다. 입력이 그 자리에서 끝나면 승인하지 않는다.
 */
export async function runChat(
  session: ConversationSession,
  budget: Budget,
  io: ChatIO,
  options: { readonly verify: readonly string[] },
): Promise<void> {
  const say = (line: string): void => void io.output.write(`${line}\n`);
  const show = (records: readonly TranscriptRecord[]): void => records.flatMap(renderRecord).forEach(say);
  const rl = createInterface({ input: io.input, output: io.output, terminal: false });
  // 입력이 끝나면(Ctrl-D·파이프 끝) readline 은 닫히지만 이미 받은 줄은 계속 나온다 —
  // 닫힌 뒤 prompt() 는 던지므로 묻지 않는다.
  let closed = false;
  rl.once('close', () => {
    closed = true;
  });
  const ask = (): void => {
    if (closed) return;
    if (session.state === 'blocked') say('승인?  y 읽기 전용 · w 쓰기 · n 거절 · a 지휘자에게 묻기');
    rl.setPrompt('> ');
    rl.prompt();
  };
  ask();
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      try {
        // /quit·/help 는 승인 대기 중에도 먼저 본다 — 도움말이 약속한 명령이 y·w·n·a 안내에 막히면 안 된다.
        // 대기 중 /quit 은 Ctrl-D 와 같다: 승인하지 않고 나간다(배정은 기록에 plan 으로만 남는다).
        if (line === '/quit' || line === '/exit') {
          break;
        } else if (line === '/help') {
          say(CHAT_HELP);
        } else if (session.state === 'blocked') {
          if (line === 'y' || line === 'w') {
            show(await session.approve({ verify: options.verify, write: line === 'w' }));
            say(`누적   ${budget.summary()}`);
          } else if (line === 'n') show(session.reject());
          else if (line === 'a') show(await session.askConductor());
          else say('y·w·n·a 중 하나로 답한다.');
        } else if (line.startsWith('/task')) {
          const m = /^\/task\s+(R\d{2})$/i.exec(line);
          if (m?.[1]) show(await session.planAs(m[1].toUpperCase()));
          else say('형식: /task R01');
        } else if (/^[ywna]$/i.test(line)) {
          // 위임 중에 미리 친 답이 줄 대기열에 남았다가 여기로 온다 — 메시지로 보내면 유료 직접 답과 쓸모없는 턴이 생긴다.
          say('승인 대기 중인 배정이 없다 — 메시지로 보내려면 문장으로 쓴다.');
        } else if (line.startsWith('/')) {
          say(`모르는 명령이다: ${line} — /help`);
        } else if (line) {
          show(await session.send(line));
        }
      } catch (error) {
        // 세션 규칙 위반(스크래치 쓰기 등)은 상태를 바꾸지 않고 던진다 — 알리고 같은 자리에서 다시 묻는다.
        say(`오류   ${why(error)}`);
      }
      ask();
    }
  } finally {
    rl.close();
  }
}

export interface ChatArgs {
  readonly scratch: boolean;
  readonly resume?: string;
  readonly list: boolean;
  readonly help: boolean;
  readonly verify: readonly string[];
}

export const CHAT_USAGE = '사용법: hs-orc chat [--scratch | --resume <id>] [--list] [--verify "<명령>"]...';

export function parseChatArgs(argv: readonly string[]): ChatArgs {
  let scratch = false;
  let list = false;
  let help = false;
  let resume: string | undefined;
  const verify: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg ?? ''} 에 값이 없다.`);
      i += 1;
      return next;
    };
    switch (arg) {
      case '--scratch': scratch = true; break;
      case '--list': list = true; break;
      case '--help': case '-h': help = true; break;
      case '--resume': resume = value(); break;
      case '--verify': verify.push(value()); break;
      // 조용한 폴백 금지 — 오타가 무시되면 사용자는 켠 줄 안다.
      default: throw new Error(`모르는 옵션이다: ${arg ?? ''}\n  ${CHAT_USAGE}`);
    }
  }
  if (scratch && resume !== undefined) throw new Error('--scratch 와 --resume 은 함께 쓸 수 없다 — 이어 갈 세션의 종류는 기록이 정한다.');
  return { scratch, list, help, verify, ...(resume !== undefined ? { resume } : {}) };
}

/** 이 폴더의 project 세션을 먼저, 다음에 스크래치를 본다. 스크래치 폴더는 목록에서 오므로 뿌리 안이다. */
export function findSession(cwd: string, id: string): SessionSummary | undefined {
  return [...listSessions(cwd, 'project'), ...listScratchSessions()].find((s) => s.id === id);
}

export function openingLines(session: ConversationSession, budget: Budget, tail = 10): string[] {
  const records = session.records().filter((r) => r.kind !== 'spend');
  const last = records.at(-1);
  const broken = readTranscript(session.file).broken;
  return [
    `세션   ${session.kind} ${session.id} · ${session.dir}`,
    `누적   ${budget.summary()}`,
    ...(broken > 0 ? [`경고   기록에 깨진 줄 ${broken}개 — 건너뛰고 보여준다`] : []),
    ...(records.length > tail ? [`       (앞 기록 ${records.length - tail}개 생략)`] : []),
    ...records.slice(-tail).flatMap(renderRecord),
    ...(session.interrupted ? ['끊김   지난 위임은 승인 뒤 결과가 기록되지 않았다 — 다시 보내면 새로 띄운다.'] : []),
    // Core 는 승인 안 된 배정을 되살리지 않는다 (session.ts 생성자) — 사용자에게 그 사실과 길을 알린다.
    ...(last?.kind === 'plan' ? [`안내   승인 안 된 배정은 되살리지 않는다 — 다시 보내거나 /task ${last.taskId}.`] : []),
    CHAT_HELP,
  ];
}

/**
 * Ctrl-C 처리. 엔진은 자기 프로세스 그룹으로 떠(adapters/run.ts `detached`) 셸이 죽어도 **계속 돌고 과금된다** —
 * 쓰기를 켰으면 파일도 계속 고친다. 그래서 위임이 도는 중의 첫 Ctrl-C 는 경고만 하고 끝날 때까지 기다린다.
 * 같은 위임 중 두 번째는 나간다(사용자가 알고 고른 것). 입력 대기 중이면 바로 나간다.
 */
export function interruptGuard(
  session: Pick<ConversationSession, 'state' | 'records'>,
  say: (line: string) => void,
): () => 'exit' | 'wait' {
  // 위임 하나 동안 기록 길이는 그대로다(결과는 끝날 때 붙는다) — 그 길이로 "같은 위임" 을 가린다.
  let warnedAt = -1;
  return () => {
    if (session.state !== 'working') return 'exit';
    const at = session.records().length;
    if (warnedAt === at) return 'exit';
    warnedAt = at;
    say('\n중단   위임이 도는 중이다 — 끝날 때까지 기다린다. 한 번 더 누르면 엔진을 남겨 둔 채 나간다(엔진은 계속 돌고 과금된다).');
    return 'wait';
  };
}
