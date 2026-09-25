/**
 * `hs-orc chat` 진입점 (D-056). 인자 → 세션 열기 → 표준 입출력 배선만 한다.
 *   hs-orc chat [--scratch | --resume <id>] [--list] [--verify "<명령>"]...
 */
import { Journal } from '../core/journal.ts';
import { listScratchSessions, listSessions, prepareSession, type SessionKind } from '../core/transcript.ts';
import { assembleSession, restoreBudget } from './conversation.ts';
import { findSession, interruptGuard, openingLines, parseChatArgs, runChat } from './chat.ts';

async function main(): Promise<void> {
  const args = parseChatArgs(process.argv.slice(2));
  const cwd = process.cwd();
  if (args.list) {
    const all = [...listSessions(cwd, 'project'), ...listScratchSessions()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    process.stdout.write(all.length === 0 ? '세션 없음\n' : `${all.map((s) => `${s.id}  ${s.kind.padEnd(7)} ${s.lastAt}  ${s.preview}`).join('\n')}\n`);
    return;
  }
  let kind: SessionKind;
  let dir: string;
  let id: string;
  if (args.resume !== undefined) {
    const found = findSession(cwd, args.resume);
    if (!found) throw new Error(`그런 세션이 없다: ${args.resume} — hs-orc chat --list`);
    ({ kind, dir, id } = found);
  } else {
    kind = args.scratch ? 'scratch' : 'project';
    ({ dir, id } = prepareSession(kind, cwd));
  }
  const budget = restoreBudget(dir, id);
  const session = assembleSession({ kind, dir, id, budget, journal: new Journal() });
  process.stdout.write(`${openingLines(session, budget).join('\n')}\n`);
  const guard = interruptGuard(session, (line) => void process.stdout.write(`${line}\n`));
  process.on('SIGINT', () => {
    if (guard() === 'wait') return;
    process.stdout.write(`\n이어서: hs-orc chat --resume ${id}\n`);
    process.exit(130);
  });
  await runChat(session, budget, { input: process.stdin, output: process.stdout }, { verify: args.verify });
  process.stdout.write(`\n이어서: hs-orc chat --resume ${id}\n`);
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
