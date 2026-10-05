/**
 * 스캐폴딩 허용 목록 (D-088). hs-orc 가 엔진 없이 직접 실행하는 유일한 사람 확인 명령이라 로더가 모양을 엄격히 본다 —
 * 수기 파일의 실수가 임의 명령 실행이 되지 않게 한다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface Scaffolder {
  readonly id: string;
  readonly label: string;
  /** 문장에서 이 항목을 고르는 낱말(소문자). 문장은 argv 에 들어가지 않는다. */
  readonly keywords: readonly string[];
  readonly argv: readonly string[];
}

export interface Scaffolders {
  readonly timeoutMs: number;
  /** 빈 폴더 판정에서 빼는 이름. */
  readonly ignore: readonly string[];
  readonly scaffolders: readonly Scaffolder[];
}

const SCAFFOLDERS_PATH = path.resolve(import.meta.dirname, '..', '..', 'data', 'scaffolders.json');

/** 인자 한 칸 — 셸 메타문자(공백·따옴표·$·`·;·|·&·<·>·괄호·*·?·~·\)와 경로 구분자 `/` 를 담을 수 없다. argv 로 넘기니 해석되지는 않지만 수기 실수를 막는다. */
const SAFE_ARG = /^[A-Za-z0-9@._=:-]+$/;
/** npx 다음 첫 비옵션 인자 — 공식 스캐폴더 패키지 이름 모양만 받는다. */
const PACKAGE = /^create-[a-z0-9-]+(@[a-z0-9.^~-]+)?$/;
/**
 * 패키지 앞에 올 수 있는 npx 옵션 — 묻지 않고 받는 `--yes` 뿐이다. `--package=`(다른 패키지를 받아 실행)·`--call=`(셸 명령)·
 * `--registry=` 같은 옵션은 실행 대상을 바꾸므로 받지 않는다 (PR #118 리뷰).
 */
const NPX_OPTIONS: readonly string[] = ['--yes'];

export class ScaffoldError extends Error {
  override name = 'ScaffoldError';
}

/** argv 한 줄이 허용 모양인가 — 아니면 던진다. 패키지 이름을 돌려준다. */
export function checkScaffoldArgv(argv: readonly string[]): string {
  if (argv[0] !== 'npx') throw new ScaffoldError(`스캐폴더는 npx 로만 실행한다: ${argv.join(' ')}`);
  const bad = argv.find((a: unknown) => typeof a !== 'string' || !SAFE_ARG.test(a));
  if (bad !== undefined) throw new ScaffoldError(`허용하지 않는 인자다: ${JSON.stringify(bad)}`);
  const at = argv.findIndex((a, i) => i > 0 && !a.startsWith('-'));
  const pkg = at < 0 ? undefined : argv[at];
  if (pkg === undefined || !PACKAGE.test(pkg)) throw new ScaffoldError(`create-* 패키지가 아니다: ${pkg ?? '(없음)'}`);
  const npxOption = argv.slice(1, at).find((a) => !NPX_OPTIONS.includes(a));
  if (npxOption !== undefined) throw new ScaffoldError(`npx 옵션은 ${NPX_OPTIONS.join('·')} 만 받는다: ${npxOption}`);
  const rest = argv.slice(at + 1);
  // 위치 인자에 대상 폴더 '.' 이 있어야 하고, 상위 경로로 세션 폴더 밖에 만들지 않는다 ('/' 는 위에서 막았다).
  if (!rest.includes('.') || rest.some((a) => a.includes('..'))) {
    throw new ScaffoldError(`대상 폴더는 '.'(세션 폴더) 이어야 한다: ${argv.join(' ')}`);
  }
  return pkg;
}

export function checkScaffolders(raw: Scaffolders): Scaffolders {
  if (!Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0) throw new ScaffoldError(`scaffolders.json 의 timeoutMs 는 양수여야 한다: ${raw.timeoutMs}`);
  if (!Array.isArray(raw.ignore) || !raw.ignore.every((n: unknown) => typeof n === 'string' && !n.includes('/'))) throw new ScaffoldError('scaffolders.json 의 ignore 는 이름 배열이어야 한다.');
  const list: readonly Scaffolder[] = raw.scaffolders;
  if (!Array.isArray(list) || list.length === 0) throw new ScaffoldError('scaffolders.json 에 scaffolders 가 없다.');
  const ids = new Set<string>();
  // Array.isArray 가 요소 타입을 any 로 넓힌다 — 선언 타입으로 돈다(값은 아래에서 하나씩 본다).
  for (const s of list as readonly Scaffolder[]) {
    if (typeof s.id !== 'string' || !/^[a-z0-9-]+$/.test(s.id) || ids.has(s.id)) throw new ScaffoldError(`scaffolders.json 의 id 가 틀렸거나 겹친다: ${String(s.id)}`);
    ids.add(s.id);
    if (typeof s.label !== 'string' || !s.label) throw new ScaffoldError(`${s.id} 에 label 이 없다.`);
    if (!Array.isArray(s.keywords) || s.keywords.length === 0 || !s.keywords.every((k: unknown) => typeof k === 'string' && k === k.toLowerCase() && k.trim() === k && k !== '')) {
      throw new ScaffoldError(`${s.id} 의 keywords 는 소문자 낱말 배열이어야 한다.`);
    }
    if (!Array.isArray(s.argv)) throw new ScaffoldError(`${s.id} 에 argv 가 없다.`);
    checkScaffoldArgv(s.argv);
  }
  return raw;
}

/** 부를 때마다 파일을 읽는다 — 캐시하지 않는다. 실행 직전 재검사가 지금 파일과 대조돼야 해서다 (PR #118 리뷰). 파일이 작고 카드·실행 때만 읽는다. */
export function loadScaffolders(): Scaffolders {
  return checkScaffolders(JSON.parse(readFileSync(SCAFFOLDERS_PATH, 'utf8')) as Scaffolders);
}
