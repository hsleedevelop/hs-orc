/**
 * matrix.json 생성기 — 원본 HTML이 진실이다 (SPEC §2, D-013).
 * 수기 전사를 금지하기 위해 원본의 `rows`/`profiles` 리터럴을 vm 으로 평가하고,
 * economics 표와 상향 사다리는 정적 마크업에서 뽑는다.
 *
 *   node scripts/gen-matrix.mjs [--source <html>] [--out <json>] [--check]
 *
 * --check 는 파일을 쓰지 않고 기존 산출물과 다르면 비정상 종료한다 (대조 테스트용).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import path from 'node:path';

// 원본 HTML 을 **저장소 안에** 둔다. 개인 절대경로를 기본값으로 두면 다른 머신에서
// `matrix:check` 가 조용히 생략되고, 게이트 첫 단계가 no-op 이 된다 — D-013 의
// "원본이 진실" 은 대조할 수 있을 때만 성립한다. 환경변수로 다른 원본을 지정할 수 있다.
const DEFAULT_SOURCE =
  process.env.HS_ORC_MATRIX_SOURCE ??
  path.resolve(import.meta.dirname, '..', 'data', 'matrix-source.html');
const DEFAULT_OUT = path.join(process.cwd(), 'data', 'matrix.json');

/** 모델 계층 — SPEC §2.1. 벤더 판정의 근거이며 INV-1 이 여기에 기댄다. */
const TIERS = {
  openai: ['luna', 'terra', 'sol', 'astra'],
  anthropic: ['haiku', 'sonnet', 'opus', 'fable'],
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

/** `const <name> = <literal>;` 를 찾아 그 리터럴만 안전하게 평가한다. */
function evalLiteral(html, name) {
  const start = html.indexOf(`const ${name} = `);
  if (start === -1) throw new Error(`원본에서 \`const ${name}\` 를 찾지 못했다: 구조가 바뀌었다.`);
  const open = start + `const ${name} = `.length;
  const openChar = html[open];
  const closeChar = openChar === '{' ? '}' : ']';
  // 문자열 안의 괄호를 세지 않도록 따옴표 상태를 추적한다.
  let depth = 0;
  let quote = null;
  let i = open;
  for (; i < html.length; i += 1) {
    const c = html[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === openChar) depth += 1;
    else if (c === closeChar) {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error(`\`${name}\` 리터럴이 닫히지 않았다.`);
  return runInNewContext(`(${html.slice(open, i + 1)})`, Object.create(null), { timeout: 1000 });
}

const vendorOf = (model) => {
  for (const [vendor, models] of Object.entries(TIERS)) if (models.includes(model)) return vendor;
  throw new Error(`모델 계층에 없는 모델: ${model}`);
};

/** 'Astra | xHigh/Max' → { label, efforts: ['xhigh','max'] } — 정규 어휘는 SPEC §3.3. */
const EFFORT_VOCAB = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function parseAssignment(cell) {
  const [label, effortPart] = cell.split('|').map((s) => s.trim());
  const efforts = effortPart
    .split('/')
    .map((s) => s.trim().toLowerCase())
    .map((s) => (s === 'mid' ? 'medium' : s));
  for (const e of efforts) {
    if (!EFFORT_VOCAB.has(e)) throw new Error(`정규 어휘 밖의 effort: ${e} (원본 셀: ${cell})`);
  }
  return { label, efforts };
}

function parseEconomics(html) {
  const table = html.match(/<table class="economics-grid">([\s\S]*?)<\/table>/);
  if (!table) throw new Error('economics-grid 표를 찾지 못했다.');
  const rows = [...table[1].matchAll(/<tr><td>([\s\S]*?)<\/tr>/g)].map((m) =>
    m[1].split(/<\/td><td>/).map((c) => c.replace(/<\/?td>/g, '').trim()),
  );
  return rows.map(([name, aa, cost, firstChunk, modality]) => {
    const key = name.toLowerCase().split(/\s/)[0].replace('*', '');
    return {
      model: key,
      vendor: vendorOf(key),
      // AA/비용/지연은 **벤치마크 측정치이며 실제 지출이 아니다** (SPEC §2.3).
      aa: Number(aa),
      taskCostUsd: Number(cost.replace('$', '')),
      firstChunkSec: Number(firstChunk.replace('s', '')),
      inputScope: modality,
      note: name.includes('*') ? 'AA row는 fallback 포함 구성' : null,
    };
  });
}

function parseLadder(html) {
  const page = html.match(/id="page-4"([\s\S]*?)<\/article>/);
  if (!page) throw new Error('상향 사다리(page-4)를 찾지 못했다.');
  return [...page[1].matchAll(/<li>(L\d): ([\s\S]*?)<\/li>/g)].map(([, level, body]) => {
    const [primary, reviewer] = body.split('/').map((s) => s.trim());
    const norm = (s) => {
      const [model, effort] = s.replace(/\s*\+.*$/, '').split(/\s+/);
      return { model: model.toLowerCase(), effort: effort.toLowerCase() === 'mid' ? 'medium' : effort.toLowerCase() };
    };
    return {
      level,
      primary: norm(primary),
      reviewer: norm(reviewer),
      independentReview: /independent review/i.test(body),
    };
  });
}

async function build(sourcePath) {
  const html = await readFile(sourcePath, 'utf8');
  const profiles = evalLiteral(html, 'profiles');
  const rawRows = evalLiteral(html, 'rows');

  const assignments = rawRows.map(([task, primaryCell, reviewerCell, criterion, primaryKey, reviewerKey, detail], i) => {
    const primary = parseAssignment(primaryCell);
    const reviewer = parseAssignment(reviewerCell);
    const row = {
      id: `R${String(i + 1).padStart(2, '0')}`,
      task,
      // 운영 기준 = 완료의 정의 (D-010). 완료 판정 로직을 새로 발명하지 않는다.
      operatingCriterion: criterion,
      primary: { model: primaryKey, vendor: vendorOf(primaryKey), efforts: primary.efforts, label: primary.label },
      reviewer: { model: reviewerKey, vendor: vendorOf(reviewerKey), efforts: reviewer.efforts, label: reviewer.label },
      detail,
    };
    // INV-1: vendor(primary) ≠ vendor(reviewer) (D-009). 원본이 깨지면 생성 자체를 실패시킨다.
    if (row.primary.vendor === row.reviewer.vendor) {
      throw new Error(`INV-1 위반: ${row.id} ${task} — primary/reviewer 벤더가 같다.`);
    }
    return row;
  });

  return {
    $generated: {
      note: 'GENERATED — 수기 편집하지 않는다. `npm run gen:matrix` 로 재생성한다.',
      source: sourceLabel(sourcePath),
      sourceSha256: createHash('sha256').update(html).digest('hex'),
      generator: 'scripts/gen-matrix.mjs',
    },
    tiers: TIERS,
    profiles: Object.fromEntries(
      Object.entries(profiles).map(([k, p]) => [k, { name: p.name, kind: p.kind, summary: p.summary, stats: p.stats }]),
    ),
    assignments,
    economics: parseEconomics(html),
    ladder: parseLadder(html),
  };
}

/**
 * 산출물에 적는 출처 표기. 저장소 안이면 **상대경로**로 적는다 —
 * 절대경로를 적으면 체크아웃 위치가 다른 머신에서 `--check` 가 거짓 실패한다(실측).
 */
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const sourceLabel = (p) => {
  const rel = path.relative(REPO_ROOT, p);
  return rel && !rel.startsWith('..') ? rel : p;
};

const sourcePath = arg('--source', DEFAULT_SOURCE);
const outPath = arg('--out', DEFAULT_OUT);

// 원본 HTML은 이 저장소 바깥의 절대경로다. 다른 머신에서는 없을 수 있으므로
// --check 는 원본이 없으면 통과시키되 **왜 대조하지 못했는지**를 반드시 말한다.
if (process.argv.includes('--check')) {
  const reachable = await readFile(sourcePath, 'utf8').then(
    () => true,
    () => false,
  );
  if (!reachable) {
    console.warn(`matrix.json 대조 생략: 원본 HTML이 이 머신에 없다 — ${sourcePath}`);
    process.exit(0);
  }
}

const matrix = await build(sourcePath);
const serialized = `${JSON.stringify(matrix, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const existing = await readFile(outPath, 'utf8').catch(() => null);
  if (existing !== serialized) {
    console.error(`matrix.json 이 원본과 다르다. \`npm run gen:matrix\` 로 재생성하라.\n  out: ${outPath}`);
    process.exit(1);
  }
  console.log(`matrix.json 대조 통과 (${matrix.assignments.length}행)`);
} else {
  await writeFile(outPath, serialized);
  console.log(`matrix.json 생성: ${matrix.assignments.length}행 · ${matrix.economics.length}모델 · 사다리 ${matrix.ladder.length}단`);
}
