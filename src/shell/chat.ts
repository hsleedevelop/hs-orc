/**
 * `hs-orc chat` — 줄 입력 대화 세션 (D-056). 판단은 전부 `ConversationSession`(Core)에 있고
 * 여기는 기록을 터미널 줄로 그리고 입력을 세션 호출로 옮긴다.
 */
import { createInterface } from 'node:readline';
import { loadEngines } from '../data/engines.ts';
import { EFFORTS, type Effort } from '../data/matrix.ts';
import { APPROVAL_MODES, isApprovalMode, isOrchestratorEngine, type ApprovalMode, type OrchestratorChoice } from '../data/limits.ts';
import { defaultOrchestrator, orchestratorOptions } from '../core/conductor.ts';
import { slotLine } from '../core/reader.ts';
import type { Budget } from '../core/budget.ts';
import type { ConversationSession } from '../core/session.ts';
import { listScratchSessions, listSessions, readSessionLog, type SessionSummary, type TranscriptRecord } from '../core/transcript.ts';
import { compactLines, cutLine, lastEvent, ladderLines, retryLines } from './transcript-lines.ts';

export function renderRecord(r: TranscriptRecord): string[] {
  switch (r.kind) {
    case 'user':
      return [`나     ${r.text}`];
    case 'direct':
      return [
        ...r.notes.map((n) => `분류   ${n}`),
        ...(r.guide ?? []).map((g) => `안내   ${g}`),
        // 읽기 답(D-083)은 지휘자가 아니라 읽기 전용 엔진 1슬롯이 낸 답이다 — reviewer 판정이 없다는 것을 같이 말한다.
        ...(r.read ? [`읽기   ${r.read.slot} · 읽기 전용 · reviewer 없음 · ${r.read.by === 'auto' ? 'Jev GENERAL 자동' : '사용자 요청'}`] : []),
        r.text,
        `비용   ${r.cost}${r.by ? ` · ${r.by}` : ''}`,
        // 제안이 있으면 곧이어 배정 카드가 붙는다 (D-064) — 카드 이전 기록에는 붙지 않아 openingLines 가 /task 길을 알린다.
        ...(r.suggest ? [`제안   ${r.suggest} (지휘자)`] : []),
        // GENERAL 은 배정이 서지 않는다 — 고르는 행은 가장 가까운 것일 뿐이라고 말한다 (D-082).
        ...(r.general ? [`안내   행에 안 맞는 작업 (Jev GENERAL) — ${r.read ? '' : '코드를 읽고 답하려면 /read · '}위임하려면 /task Rxx 로 가장 가까운 행을 고른다.`] : []),
        ...cutLine(r.cut),
      ];
    case 'plan':
      return [
        ...r.notes.map((n) => `분류   ${n}`),
        `업무   ${r.taskId} ${r.title}  (${r.reason})`,
        `배정   primary  ${r.primary}`,
        `       reviewer ${r.reviewer}`,
        ...(r.reviewer2 ? [`       reviewer ${r.reviewer2}  (사다리 ④ 추가 — 둘 다 PASS 일 때만 PASS)`] : []),
        `비용   $${r.estimateUsd} (추정)`,
        // 다음 행동 안내 (D-074) — manual 이면 H4 도 여기 실린다(묻는 이유가 비어서).
        ...(r.guide ?? []).map((g) => `안내   ${g}`),
        ...ladderLines(r.ladder).map((l, i) => (i === 0 ? l : `       ${l}`)),
        ...retryLines(r.retry),
        // 묻는 카드는 걸린 조건을 이름으로 보인다 (D-064). manual 은 늘 묻고, 이유가 없으면 자동 승인이 뒤따른다.
        ...(r.mode && r.mode !== 'manual' && r.asked && r.asked.length > 0 ? [`묻는 이유  ${r.asked.map((a) => `${a.code} ${a.text}`).join(' · ')}`] : []),
      ];
    case 'approval':
      if (r.approved && r.by === 'auto') return [`승인   자동 승인 · ${r.mode ?? ''} · 묻는 조건 없음 — 읽기 전용`];
      return [r.approved ? `승인   ${r.write ? '쓰기 켬 — primary 가 파일을 고칠 수 있다' : '읽기 전용'}` : '거절'];
    case 'mode':
      return [`방식   승인 방식 → ${r.mode}`];
    case 'orchestrator':
      return [`지휘   지휘자 → ${r.model}·${r.effort}`];
    case 'steps':
      return [
        `계획   지휘자 단계 계획 ${r.steps.length}단계 · ${r.by} · ${r.cost}`,
        ...r.steps.flatMap((st) => [
          `단계   ${st.id} ${st.taskId} ${st.task}${st.write ? ' · 쓰기 행' : ''}${st.dependsOn.length > 0 ? `  (← ${st.dependsOn.join(', ')})` : ''}`,
          `       ${st.prompt.slice(0, 200)}`,
          `       primary ${st.primary} · reviewer ${st.reviewer} · $${st.estimateUsd}`,
        ]),
        `비용   $${r.estimateUsd} (추정, 단계 합 · 단계는 순서대로 하나씩 돈다)`,
        ...(r.guide ?? []).map((g) => `안내   ${g}`),
        ...(r.asked && r.asked.length > 0 ? [`묻는 이유  ${r.asked.map((a) => `${a.code} ${a.text}`).join(' · ')}`] : []),
        ...cutLine(r.cut),
      ];
    case 'result':
      // 취소는 결과가 아니라 멈춤이다 (D-066) — reviewer 판정·검증이 없다. 받은 출력은 남겨 보여준다.
      if (r.outcome === 'cancelled') return [`결과   ${r.step ? `단계 ${r.step} · ` : ''}취소됨 · 결정 ${r.decisionId}`, `증거   ${r.evidence}`, ...(r.text ? [r.text] : [])];
      return [
        `결과   ${r.step ? `단계 ${r.step} · ` : ''}${r.outcome} · reviewer ${r.verdict.toUpperCase()} · 결정 ${r.decisionId}`,
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
  '명령   메시지를 그냥 쓰면 보낸다 · /write <문장> 쓰기 위임으로 보낸다 · /task Rxx 마지막 메시지를 그 행으로 배정 · /read 마지막 메시지를 읽기 전용 1슬롯이 코드를 읽고 답한다(카드 없이 바로) · /ladder 실패·미검증 뒤 사다리 다음 단계로 다시 위임(카드만 선다) · /steps 마지막 메시지를 지휘자가 위임 단계로 나눈 계획으로 세운다(승인하면 단계마다 차례로 위임) · /mode [방식] · /orc [claude|codex|모델] [effort] 지휘자 바꾸기 · /help · /quit (Ctrl-D)',
  '방식   /mode manual 매번 묻는다 · auto-ask 쓰기·모델이 고른 행·비싼 조합·상한 근접·첫 위임만 묻는다 · auto 쓰기·모델이 고른 행만 묻는다 — 자동은 이 메시지의 배정 1건만 시작한다',
  '승인   배정이 뜨면 y 읽기 전용 · w 쓰기 · n 거절 · a 지휘자에게 묻기 · 문장을 쓰면 거절하고 그 메시지를 보낸다',
  '취소   위임이 도는 중 Ctrl-C 한 번 — 그 위임만 멈추고 세션은 남는다 · 한 번 더 누르면 나간다',
].join('\n');

/**
 * `/orc` 인자 → 지휘자 선택 (D-087). `claude`·`codex` 는 그 벤더의 기본, 모델 키는 그 모델(effort 는 지금 값), effort 만 주면 effort 만 바꾼다.
 * 모르는 낱말은 던진다 — 조용히 무시하면 바꾼 줄 안다.
 */
export function parseOrchestratorArgs(current: OrchestratorChoice, words: readonly string[]): OrchestratorChoice {
  const models = orchestratorOptions(loadEngines()).flatMap((o) => o.models.map((m) => m.model as string));
  let choice = current;
  for (const word of words) {
    if (isOrchestratorEngine(word)) choice = defaultOrchestrator(word);
    else if (models.includes(word)) choice = { ...choice, model: word as OrchestratorChoice['model'] };
    else if ((EFFORTS as readonly string[]).includes(word)) choice = { ...choice, effort: word as Effort };
    else throw new Error(`모르는 지휘자 인자다: ${word} — claude·codex · 모델(${models.join('·')}) · effort(${EFFORTS.join('·')})`);
  }
  return choice;
}

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
    if (session.state === 'blocked') say(session.stepsPending ? '승인?  y 읽기 전용 · w 쓰기 행 단계에 쓰기 · n 거절 — 단계마다 차례로 위임한다' : '승인?  y 읽기 전용 · w 쓰기 · n 거절 · a 지휘자에게 묻기');
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
        } else if (line === '/mode' || line.startsWith('/mode ')) {
          const arg = line.slice('/mode'.length).trim();
          if (!arg) say(`방식   ${session.mode} (${APPROVAL_MODES.join(' · ')})`);
          else if (isApprovalMode(arg)) {
            // 선 카드는 그대로 사람이 누른다 (D-064 결정 9) — 바뀐 방식은 다음 배정부터다.
            const out = session.setMode(arg);
            if (out.length === 0) say(`방식   이미 ${arg}`);
            else show(out);
            if (session.state === 'blocked') say('안내   지금 선 카드는 자동 승인하지 않는다 — 다음 배정부터 적용된다.');
          } else say(`모르는 방식이다: ${arg} — ${APPROVAL_MODES.join(' · ')}`);
        } else if (line === '/orc' || line.startsWith('/orc ')) {
          const words = line.slice('/orc'.length).trim().split(/\s+/).filter(Boolean);
          if (words.length === 0) say(`지휘   ${slotLine(session.conductor())} — /orc claude·codex 는 그 벤더 기본, /orc <모델> [effort]`);
          else {
            const out = session.setOrchestrator(parseOrchestratorArgs(session.orchestrator, words));
            if (out.length === 0) say(`지휘   이미 ${slotLine(session.conductor())}`);
            else say(`지휘   → ${slotLine(session.conductor())}`);
          }
        } else if (line === '/steps') {
          // 카드만 세운다 — 시작은 y·w 로 따로 한다 (D-087). 배정 카드가 선 채 부르면 그 배정은 거절로 남는다.
          show(await session.planSteps());
        } else if (line === '/ladder') {
          // 카드만 세운다 — 시작은 y·w 로 따로 한다 (D-068). 블로킹 중에는 아래 blocked 분기가 먼저 받는다.
          if (session.state === 'blocked') say('이미 선 배정이 있다 — 먼저 y·w·n·a 로 답한다.');
          else show(session.escalate());
        } else if (line.startsWith('/write ')) {
          show(await session.send(line.slice('/write '.length), { write: true }));
        } else if (session.state === 'blocked') {
          if (line === 'y' || line === 'w') {
            show(await session.approve({ verify: options.verify, write: line === 'w' }));
            say(`누적   ${budget.summary()}`);
          } else if (line === 'n') show(session.reject());
          else if (line === 'a' && !session.stepsPending) show(await session.askConductor());
          // 공백이 든 문장은 새 메시지다 — 배정은 거절로 남는다 (D-064). 한 단어(오타 y·yes 등)는 유료 호출로 새지 않게 되묻는다.
          else if (/\s/.test(line) && !line.startsWith('/')) show(await session.send(line));
          else say('y·w·n·a 중 하나로 답한다 (새 메시지는 문장으로 쓴다).');
        } else if (line === '/read') {
          // 질문형 경로 (D-083) — 이 명령이 승인이다. 카드 없이 바로 돈다.
          show(await session.readAnswer());
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
  /** 시작 때 이 세션의 승인 방식을 바꾼다 (D-064). 없으면 기록·기본값 그대로. */
  readonly approval?: ApprovalMode;
}

export const CHAT_USAGE = '사용법: hs-orc chat [--scratch | --resume <id>] [--list] [--approval manual|auto-ask|auto] [--verify "<명령>"]...';

export function parseChatArgs(argv: readonly string[]): ChatArgs {
  let scratch = false;
  let list = false;
  let help = false;
  let resume: string | undefined;
  let approval: ApprovalMode | undefined;
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
      case '--approval': {
        const mode = value();
        if (!isApprovalMode(mode)) throw new Error(`--approval 은 ${APPROVAL_MODES.join('·')} 중 하나다: ${mode}`);
        approval = mode;
        break;
      }
      // 조용한 폴백 금지 — 오타가 무시되면 사용자는 켠 줄 안다.
      default: throw new Error(`모르는 옵션이다: ${arg ?? ''}\n  ${CHAT_USAGE}`);
    }
  }
  if (scratch && resume !== undefined) throw new Error('--scratch 와 --resume 은 함께 쓸 수 없다 — 이어 갈 세션의 종류는 기록이 정한다.');
  return { scratch, list, help, verify, ...(resume !== undefined ? { resume } : {}), ...(approval ? { approval } : {}) };
}

/** 이 폴더의 project 세션을 먼저, 다음에 스크래치를 본다. 스크래치 폴더는 목록에서 오므로 뿌리 안이다. */
export function findSession(cwd: string, id: string): SessionSummary | undefined {
  return [...listSessions(cwd, 'project'), ...listScratchSessions()].find((s) => s.id === id);
}

export function openingLines(session: ConversationSession, budget: Budget, tail = 10): string[] {
  const records = session.records().filter((r) => r.kind !== 'spend');
  const last = lastEvent(records);
  const broken = readSessionLog(session.dir, session.id).broken;
  return [
    `세션   ${session.kind} ${session.id} · ${session.dir}`,
    `방식   승인 방식 ${session.mode}`,
    `지휘   ${slotLine(session.conductor())}`,
    ...(session.orchestratorNotice ? [`안내   ${session.orchestratorNotice} · /orc 로 바꾼다`] : []),
    `누적   ${budget.summary()}`,
    ...(broken > 0 ? [`경고   기록에 깨진 줄 ${broken}개 — 건너뛰고 보여준다`] : []),
    ...(records.length > tail ? [`       (앞 기록 ${records.length - tail}개 생략)`] : []),
    ...records.slice(-tail).flatMap(renderRecord),
    ...(session.interrupted ? ['끊김   지난 위임은 승인 뒤 결과가 기록되지 않았다 — 다시 보내면 새로 띄운다.'] : []),
    // Core 는 승인 안 된 배정을 되살리지 않는다 (session.ts 생성자) — 사용자에게 그 사실과 길을 알린다.
    ...(last?.kind === 'plan' ? [`안내   승인 안 된 배정은 되살리지 않는다 — 다시 보내거나 /task ${last.taskId}.`] : []),
    ...(session.state === 'waiting_input' && session.ladderOffer() ? [`안내   /ladder — 사다리 ${session.ladderOffer()?.label}(으)로 다시 위임하는 배정 카드를 세운다.`] : []),
    // 카드 합치기(D-064) 이전 기록 — 제안만 있고 배정이 없다.
    ...(last?.kind === 'direct' && last.suggest ? [`안내   ${last.suggest} 로 위임하려면 /task ${last.suggest}.`] : []),
    CHAT_HELP,
  ];
}

/**
 * Ctrl-C 처리. 엔진은 자기 프로세스 그룹으로 떠(adapters/run.ts `detached`) 셸이 죽어도 **계속 돌고 과금된다** —
 * 쓰기를 켰으면 파일도 계속 고친다. 그래서 셸을 먼저 죽이지 않는다.
 * - 위임(primary·reviewer)이 도는 중의 첫 Ctrl-C 는 **그 위임만 취소**한다 (D-066) — 엔진 그룹을 종료하고 세션은 남는다.
 *   같은 위임 중 두 번째는 나간다(종료 신호는 이미 갔다, 사용자가 알고 고른 것).
 * - 직접 답·요약이 도는 중은 취소 대상이 아니다 — 첫 Ctrl-C 는 경고만 하고 기다리고, 두 번째는 나간다.
 * - 입력 대기 중이면 바로 나간다.
 */
export function interruptGuard(
  session: Pick<ConversationSession, 'state' | 'records' | 'cancel'>,
  say: (line: string) => void,
): () => 'exit' | 'wait' {
  // 위임 하나 동안 기록 길이는 그대로다(결과는 끝날 때 붙는다) — 그 길이로 "같은 위임" 을 가린다.
  let warnedAt = -1;
  let cancelledAt = -1;
  return () => {
    if (session.state !== 'working') return 'exit';
    const at = session.records().length;
    if (warnedAt === at || cancelledAt === at) return 'exit';
    if (session.cancel()) {
      cancelledAt = at;
      say('\n취소   위임을 취소한다 — 엔진 프로세스를 종료하는 중이다. 세션은 남는다. 한 번 더 누르면 기다리지 않고 나간다.');
      return 'wait';
    }
    warnedAt = at;
    say('\n중단   위임이 도는 중이다 — 끝날 때까지 기다린다. 한 번 더 누르면 엔진을 남겨 둔 채 나간다(엔진은 계속 돌고 과금된다).');
    return 'wait';
  };
}
