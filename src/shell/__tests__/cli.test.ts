import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 하한선에 걸린 입력이 **엔진을 띄우지 않는지**를 프로세스 수준에서 증명한다 (PLAN S3 완료 판정).
 * 증명 방법: PATH 를 비운 채 실행한다. 엔진을 띄우려 했다면 바이너리 해석이 반드시 실패하고
 * "실행 가능한 바이너리를 찾지 못했다" 가 나온다. 그 문구가 없으면 spawn 시도 자체가 없었다는 뜻이다.
 *
 * **자식은 샌드박스에서 돈다.** 유닛 테스트와 달리 여기서는 진짜 CLI 가 뜨므로 기본 경로가
 * 그대로 적용된다 — 격리하지 않으면 매 `npm test` 가 저장소의 `.hs-orc/` 와
 * **사용자의 개인 결정 로그**(`~/.claude/logs/delegation-router.jsonl`)에 줄을 쌓는다.
 * 실측으로 그 일이 벌어졌다: 미분류 누적이 테스트 쓰레기로 임계치를 넘겨 제품이 사용자에게
 * 가짜 "행 추가 제안"을 냈고, 개인 로그에는 일어나지도 않은 $10.89 실행이 38줄 남았다(PLAN S9-3).
 * 그래서 cwd 기준 경로(`.hs-orc/`)는 **임시 cwd** 로, 홈 기준 경로(결정 로그)는 **환경변수**로 돌린다.
 */
const CLI = path.resolve(import.meta.dirname, '..', 'cli.ts');
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'hs-orc-cli-'));
const decisionLog = path.join(sandbox, 'decisions.jsonl');
after(() => rmSync(sandbox, { recursive: true, force: true }));

/** 이 파일이 저장소를 건드렸는지 재는 기준선. 자식을 띄우기 **전에** 찍는다. */
const repoUnclassified = path.resolve(import.meta.dirname, '..', '..', '..', '.hs-orc', 'unclassified.jsonl');
const sizeOf = (file: string): number => (existsSync(file) ? readFileSync(file, 'utf8').length : -1);
const repoBefore = sizeOf(repoUnclassified);

// spawnSync 를 쓴다 — execFileSync 는 성공했을 때 stderr 를 돌려주지 않아
// "조용히 끝났다" 를 확인할 수가 없다(실측: 그래서 초록 거짓말이 날 뻔했다).
const cli = (args: readonly string[], env: NodeJS.ProcessEnv = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: { ...process.env, HS_ORC_DECISION_LOG: decisionLog, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
};

const NO_PATH = { PATH: '' };

describe('CLI 순서 보장', () => {
  it('하한선에 걸리면 PATH 가 비어 있어도 조용히 끝난다 (엔진 spawn 0회)', () => {
    const r = cli(['이 아키텍처 설계 검토해줘', '--gate', 'irreversibleChange', '--run'], NO_PATH);
    assert.equal(r.code, 0);
    assert.match(r.err, /하한선에 걸렸다/);
    assert.doesNotMatch(r.err, /실행 가능한 바이너리를 찾지 못했다/);
  });

  it('하한선을 안 걸면 같은 입력이 실제로 바이너리를 찾으려 한다 (위 통과가 우연이 아님)', () => {
    const r = cli(['이 아키텍처 설계 검토해줘', '--run'], NO_PATH);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /실행 가능한 바이너리를 찾지 못했다/);
  });

  it('--run 없이는 배정과 비용만 제시하고 멈춘다 (승인 게이트)', () => {
    const r = cli(['이 아키텍처 설계 검토해줘'], NO_PATH);
    assert.equal(r.code, 0);
    assert.match(r.err, /primary\s+Fable/);
    assert.match(r.err, /reviewer Astra/);
    assert.match(r.err, /비용\s+\$10\.89/);
    assert.match(r.err, /INDEPENDENT/);
    assert.match(r.err, /실제 실행은 --run/);
  });

  it('분류 실패는 기본 배정을 만들지 않고 사용자에게 올린다', () => {
    const r = cli(['오늘 점심 뭐 먹지'], NO_PATH);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /분류하지 못했다/);
    assert.match(r.err, /--task <R01\.\.R11>/);
  });

  it('규칙이 빗나가면 LLM 폴백이 기본으로 돈다 — 돌았다는 사실과 비용을 찍는다 (D-026)', () => {
    // PATH 가 비어 폴백 자체는 실패한다. 그래도 **시도했다는 것**과 실패 사유가 보여야 한다.
    const r = cli(['오늘 점심 뭐 먹지'], NO_PATH);
    assert.match(r.err, /규칙 무매치 → Haiku·low/);
    // 실행조차 못 했으니(PATH 없음) 비용을 지어내지 않는다 — 그 사실 자체를 찍는다 (D-034).
    assert.match(r.err, /비용 보고 없음/, '유료 호출 시도는 비용 표기(또는 "없다"는 사실)와 함께 알려야 한다.');
    assert.match(r.err, /classify-fallback/, '폴백 실패를 삼키면 안 된다.');
  });

  it('--no-classify-llm 은 폴백을 아예 시작하지 않는다', () => {
    const r = cli(['오늘 점심 뭐 먹지', '--no-classify-llm'], NO_PATH);
    assert.doesNotMatch(r.err, /Haiku·low/, '끈 폴백이 돌았다 — 말없이 돈 유료 호출이다.');
    assert.match(r.err, /--no-classify-llm 으로 꺼져 있다/);
  });

  it('모르는 옵션은 작업 문자열로 섞이지 않고 던진다', () => {
    const r = cli(['이 아키텍처 설계 검토해줘', '--wrlte'], NO_PATH);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /모르는 옵션이다: --wrlte/);
  });

  it('모르는 하한선 항목은 던진다', () => {
    const r = cli(['아무거나', '--gate', 'bogus'], NO_PATH);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /그런 하한선 항목이 없다/);
  });

  /**
   * 위 테스트들이 남긴 흔적이 **샌드박스 안에만** 있는지 본다.
   * 이 검사가 없으면 격리가 조용히 풀려도 초록이 뜨고, 그 대가는 사용자의 개인 로그다.
   */
  it('테스트가 남긴 흔적은 전부 샌드박스 안에 있다 — 저장소도 홈도 건드리지 않는다', () => {
    assert.ok(existsSync(path.join(sandbox, '.hs-orc', 'unclassified.jsonl')), '미분류 로그가 샌드박스 밖으로 샜다.');
    assert.ok(existsSync(decisionLog), '결정 로그가 샌드박스 밖으로 샜다 — 기본 경로는 사용자의 개인 로그다.');
    assert.equal(
      sizeOf(repoUnclassified),
      repoBefore,
      '저장소의 미분류 로그가 이 테스트 때문에 늘었다 — 제품의 "행 추가 제안"이 테스트 쓰레기로 오염된다.',
    );
  });
});

/**
 * D-035 — CLI 의 모든 진행 방식에 토큰 상한을 걸고, 올리는 것은 --token-budget 로만.
 *
 * loop 의 실행 전 "상한" 줄은 **엔진을 띄우기 전에** 찍힌다(runLoop 진입 전). 그래서 PATH 를
 * 비워도(NO_PATH) 그 줄은 항상 찍히고, 이후 spawn 실패로 넘어간다 — "assert the Budget passed
 * into the mode has limitTokens === limits.tokenBudget" 를 **표시된 값**으로 검증하는
 * 가장 작고 신뢰할 수 있는 방법이다(엔진을 띄우지 않고도 값이 새 나온다).
 */
describe('D-035 — CLI 의 모든 진행 방식에 토큰 상한 (T1) + --token-budget (T3)', () => {
  it('loop 는 --token-budget 없이도 기본 토큰 상한(limits.tokenBudget)을 쓴다', () => {
    const r = cli(['이 아키텍처 설계 검토해줘', '--mode', 'loop', '--run'], NO_PATH);
    assert.match(r.err, /상한.*토큰 2000000 \(0 = 없음\)/);
  });

  it('--token-budget 5 는 그 실행의 토큰 상한을 5 로 낮춘다', () => {
    const r = cli(['이 아키텍처 설계 검토해줘', '--mode', 'loop', '--token-budget', '5', '--run'], NO_PATH);
    assert.match(r.err, /토큰 5 \(0 = 없음\)/);
  });

  it('--token-budget 0 은 토큰 상한을 끈다', () => {
    const r = cli(['이 아키텍처 설계 검토해줘', '--mode', 'loop', '--token-budget', '0', '--run'], NO_PATH);
    assert.match(r.err, /토큰 0 \(0 = 없음\)/);
  });

  it('--token-budget -1 은 엔진을 띄우기 전에 던진다', () => {
    const r = cli(['이 아키텍처 설계 검토해줘', '--token-budget', '-1'], NO_PATH);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /--token-budget 은 0 이상의 정수여야 한다: -1/);
    assert.doesNotMatch(r.err, /실행 가능한 바이너리를 찾지 못했다/);
  });

  it('--token-budget abc 도 마찬가지로 엔진을 띄우기 전에 던진다', () => {
    const r = cli(['이 아키텍처 설계 검토해줘', '--token-budget', 'abc'], NO_PATH);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /--token-budget 은 0 이상의 정수여야 한다: abc/);
    assert.doesNotMatch(r.err, /실행 가능한 바이너리를 찾지 못했다/);
  });

  it('--token-budget "" 은 Number("")===0 으로 조용히 통과하지 않는다 — 빈 값도 던진다', () => {
    const r = cli(['이 아키텍처 설계 검토해줘', '--token-budget', ''], NO_PATH);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /--token-budget 은 0 이상의 정수여야 한다: $/m);
    assert.doesNotMatch(r.err, /실행 가능한 바이너리를 찾지 못했다/);
  });

  it('--token-budget 1e3 은 지수 표기라 정수 리터럴이 아니다 — 던진다', () => {
    const r = cli(['이 아키텍처 설계 검토해줘', '--token-budget', '1e3'], NO_PATH);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /--token-budget 은 0 이상의 정수여야 한다: 1e3/);
    assert.doesNotMatch(r.err, /실행 가능한 바이너리를 찾지 못했다/);
  });

  it('사용법에 --token-budget 이 있다', () => {
    const r = cli([], NO_PATH);
    assert.match(r.err, /--token-budget/);
  });

  describe('가짜 claude 바이너리로 pingpong 이 기본 토큰 상한에 실제로 걸리는지 증명한다', () => {
    // D-035 이전에는 pingpong 이 tokenBudget=0(상한 없음)을 받았다 — 얼마를 써도 안 걸렸다.
    // 큰 토큰 사용량을 보고하는 가짜 claude 로 기본 상한(2,000,000)이 실제로 막는지 본다.
    const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'hs-orc-cli-fakebin-'));
    const fakeClaude = path.join(fakeDir, 'claude');
    writeFileSync(
      fakeClaude,
      [
        '#!/bin/sh',
        `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"ok","duration_ms":1,"total_cost_usd":0.01,"usage":{"input_tokens":1500000,"output_tokens":1000000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(fakeClaude, 0o755);
    after(() => rmSync(fakeDir, { recursive: true, force: true }));

    it('기본 토큰 상한(2,000,000)이 pingpong 에도 걸리고, 걸리면 --token-budget 안내가 뜬다', () => {
      const r = cli(['이 아키텍처 설계 검토해줘', '--mode', 'pingpong', '--run'], { PATH: fakeDir });
      assert.equal(r.code, 0);
      assert.match(r.err, /누적.*토큰 2500000\/2000000/);
      assert.match(r.err, /안내 {3}토큰 상한\(2000000\)에 닿았다 — 이번 실행만 올리려면 --token-budget N\./);
    });
  });

  describe('가짜 claude+codex 로 once 모드가 reviewer 분기에서도 안내를 찍는지 증명한다', () => {
    // primary(claude) 혼자는 상한(150만) 밑이라 reviewer(codex)가 정상적으로 돈다 — duo.review
    // 분기다. reviewer 토큰까지 합산해야 넘는다 — 리뷰가 실제로 실행됐을 때도 안내가 뜨는지가
    // 이 회귀의 핵심이다(고치기 전에는 else-if 분기 밖이라 이 경우 안내가 안 떴다).
    const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'hs-orc-cli-fakebin-once-'));
    const fakeClaude = path.join(fakeDir, 'claude');
    const fakeCodex = path.join(fakeDir, 'codex');
    writeFileSync(
      fakeClaude,
      [
        '#!/bin/sh',
        `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"ok","duration_ms":1,"total_cost_usd":0.01,"usage":{"input_tokens":700000,"output_tokens":300000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(fakeClaude, 0o755);
    writeFileSync(
      fakeCodex,
      [
        '#!/bin/sh',
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"없음\\nPASS"}}'`,
        `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1000000,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0}}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(fakeCodex, 0o755);
    after(() => rmSync(fakeDir, { recursive: true, force: true }));

    it('primary 만으로는 상한 밑이라 reviewer 가 돌고, 합산 후에야 넘겨도 안내가 뜬다', () => {
      const r = cli(['이 아키텍처 설계 검토해줘', '--token-budget', '1500000', '--run'], { PATH: fakeDir });
      assert.match(r.err, /검증 {3}reviewer Astra·xhigh → PASS/);
      assert.match(r.err, /안내 {3}토큰 상한\(1500000\)에 닿았다 — 이번 실행만 올리려면 --token-budget N\./);
    });
  });
});

/**
 * D-036 — CLI loop 는 FAIL 이면 재시도하고, reviewer 의 지적을 다음 사이클 프롬프트에 싣는다.
 * 가짜 claude(primary Fable)는 받은 인자를 파일에 남기고 사이클마다 draft-N 을 내며, 가짜 codex(reviewer Astra)는
 * 호출 횟수에 따라 FAIL → PASS 를 낸다. `REVIEWER_EXIT` 가 있으면 그 코드로 죽는다.
 */
describe('D-036 — CLI loop 재시도 + reviewer FAIL 사유 전달 (L2 + L4)', () => {
  const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'hs-orc-cli-fakebin-loop-'));
  const claudeArgs = path.join(fakeDir, 'claude-args');
  const reviewCount = path.join(fakeDir, 'review-count');
  const primaryCount = path.join(fakeDir, 'primary-count');
  const codexArgs = path.join(fakeDir, 'codex-args');
  const mark = path.join(fakeDir, 'verify-mark');
  const fakeClaude = path.join(fakeDir, 'claude');
  const fakeCodex = path.join(fakeDir, 'codex');
  const codexLine = (text: string) =>
    `printf '%s\\n' '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"${text}"}}'`;
  writeFileSync(
    fakeClaude,
    [
      '#!/bin/sh',
      'if [ -n "$PRIMARY_EXIT" ]; then exit "$PRIMARY_EXIT"; fi',
      `printf '%s\\n<<END>>\\n' "$*" >> '${claudeArgs}'`,
      `n=0; [ -f '${primaryCount}' ] && read n < '${primaryCount}'; n=$((n+1)); echo "$n" > '${primaryCount}'`,
      `printf '%s\\n' "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"draft-$n\\",\\"duration_ms\\":1,\\"total_cost_usd\\":0.01,\\"usage\\":{\\"input_tokens\\":10,\\"output_tokens\\":10,\\"cache_read_input_tokens\\":0,\\"cache_creation_input_tokens\\":0}}"`,
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(fakeClaude, 0o755);
  writeFileSync(
    fakeCodex,
    [
      '#!/bin/sh',
      'if [ -n "$REVIEWER_EXIT" ]; then exit "$REVIEWER_EXIT"; fi',
      // PATH 가 fakeDir 뿐이라 cat 같은 외부 명령이 없다 — 셸 내장만 쓴다.
      `printf '%s\\n<<END>>\\n' "$*" >> '${codexArgs}'`,
      `n=0; [ -f '${reviewCount}' ] && read n < '${reviewCount}'; n=$((n+1)); echo "$n" > '${reviewCount}'`,
      `if [ "$n" -eq 1 ] && [ -z "$REVIEWER_PASS" ]; then ${codexLine('반례 ZETA 가 빠졌다\\nFAIL')}; else ${codexLine('없음\\nPASS')}; fi`,
      `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":10}}'`,
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(fakeCodex, 0o755);
  after(() => rmSync(fakeDir, { recursive: true, force: true }));
  const reset = () => [claudeArgs, reviewCount, primaryCount, codexArgs, mark].forEach((f) => rmSync(f, { force: true }));

  it('FAIL 이면 다음 사이클로 가고, 그 프롬프트에 reviewer 의 지적이 실린다', () => {
    reset();
    const r = cli(['이 아키텍처 설계 검토해줘', '--mode', 'loop', '--run'], { PATH: fakeDir });
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /중단 {3}goal-reached · 2회/);
    const prompts = readFileSync(claudeArgs, 'utf8').split('<<END>>');
    assert.doesNotMatch(prompts[0] ?? '', /ZETA/);
    assert.match(prompts[1] ?? '', /반례 ZETA 가 빠졌다/, '2사이클 프롬프트에 FAIL 사유가 없다 — 눈먼 재시도다.');
  });

  it('마지막 사이클 primary 의 산출물 전문을 stdout 에 낸다 — journal 의 앞 200자만으로는 결과를 볼 수 없다', () => {
    reset();
    const r = cli(['이 아키텍처 설계 검토해줘', '--mode', 'loop', '--run'], { PATH: fakeDir });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'draft-2\n');
  });

  // D-040: 첫 실행에서만 실패하는 검증 명령. PATH 가 fakeDir 뿐이라 셸 내장만 쓴다.
  const flakyVerify = `if [ -f '${mark}' ]; then echo GREEN; else : > '${mark}'; echo RED_OMEGA; exit 1; fi`;

  it('--write 면 Core 가 검증 명령을 돌려 reviewer 에 싣고, 실패하면 reviewer 없이 FAIL 로 재시도한다 (D-040·D-041)', () => {
    reset();
    const r = cli(['이 아키텍처 설계 검토해줘', '--mode', 'loop', '--run', '--write', '--verify', flakyVerify], {
      PATH: fakeDir,
      REVIEWER_PASS: '1',
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /중단 {3}goal-reached · 2회/);
    assert.match(r.err, /reviewer Astra 생략 — 검증 명령 실패 · 검증 명령 .* exit=1/);
    // 1사이클은 명령 실패로 FAIL 이 정해져 reviewer 가 돌지 않는다 — 2사이클 한 번만 돈다.
    const reviews = readFileSync(codexArgs, 'utf8').split('<<END>>').filter((p) => p.trim());
    assert.equal(reviews.length, 1, 'FAIL 이 이미 정해진 사이클에 reviewer 를 태웠다.');
    assert.match(reviews[0] ?? '', /검증 명령 \(Core 실행\)[\s\S]*exit=0[\s\S]*GREEN/, 'reviewer 가 명령 결과를 받지 못했다.');
    assert.doesNotMatch(r.err, /토큰 미보고/, '돌지 않은 reviewer 를 미보고 실행으로 셌다.');
    const prompts = readFileSync(claudeArgs, 'utf8').split('<<END>>');
    assert.match(prompts[1] ?? '', /검증 명령이 실패했다[\s\S]*RED_OMEGA/, '2사이클 프롬프트에 명령 실패가 없다.');
  });

  it('읽기 전용이면 검증 명령을 돌리지 않고, 미실행이라고 reviewer 와 기록에 적는다 (D-040)', () => {
    reset();
    const r = cli(['이 아키텍처 설계 검토해줘', '--mode', 'loop', '--run', '--verify', flakyVerify], {
      PATH: fakeDir,
      REVIEWER_PASS: '1',
    });
    assert.equal(r.code, 0, r.err);
    assert.equal(existsSync(mark), false, '읽기 전용인데 검증 명령이 돌았다 — 원본을 검사한 결과가 증거처럼 쓰인다.');
    assert.match(r.err, /테스트 미실행\(읽기 전용\)/);
    assert.match(readFileSync(codexArgs, 'utf8'), /적용되지 않았고 검증 명령/);
  });

  it('reviewer 실행이 실패하면 재시도하지 않고 사람에게 올린다', () => {
    reset();
    const r = cli(['이 아키텍처 설계 검토해줘', '--mode', 'loop', '--run'], { PATH: fakeDir, REVIEWER_EXIT: '3' });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /중단 {3}escalated · 1회/);
  });

  it('primary 실행이 실패하면 reviewer 를 부르지 않고 사람에게 올린다 — 에러 문자열을 채점하며 상한까지 돌지 않는다', () => {
    reset();
    const r = cli(['이 아키텍처 설계 검토해줘', '--mode', 'loop', '--run'], { PATH: fakeDir, PRIMARY_EXIT: '3' });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /중단 {3}escalated · 1회/);
    assert.equal(existsSync(reviewCount), false, 'primary 가 죽었는데 reviewer 가 돌았다.');
    assert.doesNotMatch(r.err, /누적.*실측/, '돌지 않은 reviewer 를 실측 $0 으로 적었다 — 출처 표시가 거짓이 된다.');
  });
});
