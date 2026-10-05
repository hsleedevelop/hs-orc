/**
 * `hs-orc session` 진입점 (D-085). 인자 → 명령 → 표준 출력 배선만 한다. 로직은 `session-cmd.ts`.
 */
import { readSessionLog } from '../core/transcript.ts';
import { interruptGuard } from './chat.ts';
import { defaultJev } from './jev.ts';
import { knownSessions, resolveSession } from './session-registry.ts';
import { SESSION_USAGE, listLines, nameSession, parseSessionArgs, sendToSession, showLines } from './session-cmd.ts';

const out = (lines: readonly string[]): void => void process.stdout.write(`${lines.join('\n')}\n`);

async function main(): Promise<void> {
  const args = parseSessionArgs(process.argv.slice(2));
  const cwd = process.cwd();
  switch (args.cmd) {
    case 'help':
      out([SESSION_USAGE]);
      return;
    case 'ls': {
      const sessions = knownSessions(cwd);
      out(args.json ? [JSON.stringify(sessions, null, 2)] : listLines(sessions));
      return;
    }
    case 'show': {
      const target = resolveSession(cwd, args.ref);
      if (args.json) {
        const records = readSessionLog(target.dir, target.id).records.filter((r) => r.kind !== 'spend');
        out([JSON.stringify({ ...target, records: args.tail === 0 ? [] : records.slice(-args.tail) }, null, 2)]);
      } else out(showLines(target, args.tail));
      return;
    }
    case 'name':
      out([nameSession(cwd, args.ref, args.name).line]);
      return;
    case 'send': {
      const classifier = defaultJev();
      const result = await sendToSession({
        cwd,
        ref: args.ref,
        message: args.message,
        write: args.write,
        run: args.run,
        verify: args.verify,
        ...(classifier ? { classifier } : {}),
        // 엔진은 자기 프로세스 그룹으로 떠 셸이 죽어도 돈다 — chat 과 같은 규칙으로 첫 Ctrl-C 는 위임만 취소한다 (D-066).
        onSession: (session) => {
          const guard = interruptGuard(session, (line) => void process.stdout.write(`${line}\n`));
          process.on('SIGINT', () => {
            if (guard() === 'wait') return;
            process.exit(130);
          });
        },
      });
      out(result.lines);
      process.exitCode = result.exitCode;
      return;
    }
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
