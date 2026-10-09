/**
 * 앱 실행 경로 (D-091 — Q29 R1).
 *
 * 위임 엔진은 dev 서버를 띄우지 못한다 — codex `workspace-write` 샌드박스는 포트 bind 를 막고(`network-bind`, D-091 실측),
 * claude `acceptEdits` 는 `npm run dev` 를 허용하지 않으며, 서버는 끝나지 않아 "실행하고 끝나는" 위임과 맞지 않는다(Q29 §3).
 * 그래서 hs-orc 가 **허용 스크립트만**, **사람이 카드에서 확인한 뒤**, 사람이 쓰는 터미널 창에서 띄운다(실행은 셸이 한다).
 * - 감지는 결정론이다(G1) — 문장은 argv 에 들어가지 않고 실행 요청인지만 가린다.
 * - argv 는 `<패키지 매니저> run <스크립트>` 로 고정이다. 스크립트 본문은 프로젝트 내용이라 카드에 원문을 보인다.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** 실행을 부탁하는 말 — 대상(앱·서버…)과 함께일 때만 본다. "실행하면"·"실행이 안 돼" 같은 서술은 맞지 않는다. */
const ASK_KO = /(실행|구동|기동)\s*(해|시켜|좀)|띄워|켜\s*(줘|봐|주)|돌려\s*(줘|봐|주)|시작\s*해\s*(줘|봐|주)/;
const TARGET_KO = /(앱|어플|서버|사이트|웹|프론트|프로젝트|개발\s*모드)/;
const ASK_EN = /\b(run|start|launch|serve|boot|spin\s+up|fire\s+up)\b[\w\s'-]{0,24}?\b(app|server|site|project|frontend|it)\b/i;
/** 명령을 직접 짚은 말 — "npm run dev 해줘". */
const EXPLICIT = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start)\b/i;
/**
 * 실행 요청이 아닌 말 — 테스트·빌드는 "실행" 을 같이 쓰고, 버그 보고·질문·고치는 일은 위임·직접 답으로 간다.
 * 이것이 하나라도 있으면 실행 경로를 타지 않는다(종전 경로 그대로).
 */
const NOT_RUN_KO = /(테스트|빌드|린트|배포|타입\s*체크|안\s*(돼|되|됨)|에러|오류|흰\s*화면|크래시|버그|고쳐|수정|구현|재현|왜|설명|어떻게|방법|하면|했더니|할\s*때|되면|하는\s*법)/;
/** 영어 낱말은 앞이 글자·`-` 가 아닐 때만 — 폴더 이름(`hs-orc-test`)에 걸리지 않게. */
const NOT_RUN_EN = /(?<![\w-])(tests?|build|lint|deploy|typecheck|errors?|crash(es)?|bugs?|fix|how|why)\b/i;

/** 앱(dev 서버) 실행을 부탁하는 문장인가. 넓게 잡으면 일상 문장이 카드를 세우므로 부탁하는 꼴 + 대상을 둘 다 본다. */
export function detectRun(text: string): boolean {
  if (NOT_RUN_KO.test(text) || NOT_RUN_EN.test(text)) return false;
  if (EXPLICIT.test(text)) return true;
  return (ASK_KO.test(text) && TARGET_KO.test(text)) || ASK_EN.test(text);
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** 잠금 파일 → 패키지 매니저. 앞의 것이 이긴다. 하나도 없으면 npm. 이 집합 밖의 bin 은 없다. */
const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

export interface RunTarget {
  readonly pm: PackageManager;
  /** 허용 목록에서 고른 스크립트 이름 (`dev`·`start`). */
  readonly script: string;
  /** `package.json` 의 그 스크립트 본문 원문 — 무엇이 도는지 사람이 카드에서 본다. hs-orc 는 검사하지 않는다(셸 문자열이다). */
  readonly body: string;
  readonly argv: readonly string[];
  /** `node_modules` 가 없다 — 대개 `command not found` 로 바로 끝난다. 설치는 하지 않고 알리기만 한다(D-091 결정 4). */
  readonly missingDeps: boolean;
}

/**
 * 폴더에서 실행할 스크립트를 고른다. 허용 목록(`limits.json` `runScripts`) 순서대로 처음 있는 것이다.
 * 고를 수 없으면 사유. 사용자 문장은 보지 않는다 — 실행 직전에도 같은 함수로 다시 고른다.
 */
export function runTarget(dir: string, scripts: readonly string[]): RunTarget | { readonly why: string } {
  const file = path.join(dir, 'package.json');
  if (!existsSync(file)) return { why: 'package.json 이 없다' };
  let declared: unknown;
  try {
    declared = (JSON.parse(readFileSync(file, 'utf8')) as { scripts?: unknown }).scripts;
  } catch (error) {
    return { why: `package.json 을 읽지 못했다 (${error instanceof Error ? error.message : String(error)})` };
  }
  const table = declared && typeof declared === 'object' ? (declared as Record<string, unknown>) : {};
  const script = scripts.find((name) => { const body = table[name]; return typeof body === 'string' && body.trim() !== ''; });
  if (!script) return { why: `package.json 에 허용 스크립트(${scripts.join('·')})가 없다` };
  const pm = LOCKFILES.find(([lock]) => existsSync(path.join(dir, lock)))?.[1] ?? 'npm';
  return { pm, script, body: table[script] as string, argv: [pm, 'run', script], missingDeps: !existsSync(path.join(dir, 'node_modules')) };
}

/** 카드가 선 뒤 바뀌었나 — argv·본문이 글자까지 같아야 같은 실행이다. 바뀌었으면 사람이 본 것과 다른 것이 돈다. */
export function sameRunTarget(a: RunTarget, b: RunTarget): boolean {
  return a.body === b.body && a.argv.length === b.argv.length && a.argv.every((x, i) => x === b.argv[i]);
}
