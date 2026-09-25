/**
 * `hs-orc chat` — 줄 입력 대화 세션 (D-056). 판단은 전부 `ConversationSession`(Core)에 있고
 * 여기는 기록을 터미널 줄로 그리고 입력을 세션 호출로 옮긴다.
 */
import { createInterface } from 'node:readline';
import type { Budget } from '../core/budget.ts';
import type { ContextCut } from '../core/context.ts';
import type { ConversationSession } from '../core/session.ts';
import type { TranscriptRecord } from '../core/transcript.ts';

const cutLine = (cut: ContextCut | undefined): string[] => (cut ? [`맥락   앞 대화 ${cut.turns}턴·${cut.chars}자를 싣지 못했다`] : []);

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
        if (session.state === 'blocked') {
          if (line === 'y' || line === 'w') {
            show(await session.approve({ verify: options.verify, write: line === 'w' }));
            say(`누적   ${budget.summary()}`);
          } else if (line === 'n') show(session.reject());
          else if (line === 'a') show(await session.askConductor());
          else say('y·w·n·a 중 하나로 답한다.');
        } else if (line === '/quit' || line === '/exit') {
          break;
        } else if (line === '/help') {
          say(CHAT_HELP);
        } else if (line.startsWith('/task')) {
          const m = /^\/task\s+(R\d{2})$/i.exec(line);
          if (m?.[1]) show(await session.planAs(m[1].toUpperCase()));
          else say('형식: /task R01');
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
