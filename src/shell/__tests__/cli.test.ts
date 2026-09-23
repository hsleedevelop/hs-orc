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
});
