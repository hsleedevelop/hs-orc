import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/**
 * 하한선에 걸린 입력이 **엔진을 띄우지 않는지**를 프로세스 수준에서 증명한다 (PLAN S3 완료 판정).
 * 증명 방법: PATH 를 비운 채 실행한다. 엔진을 띄우려 했다면 바이너리 해석이 반드시 실패하고
 * "실행 가능한 바이너리를 찾지 못했다" 가 나온다. 그 문구가 없으면 spawn 시도 자체가 없었다는 뜻이다.
 */
// spawnSync 를 쓴다 — execFileSync 는 성공했을 때 stderr 를 돌려주지 않아
// "조용히 끝났다" 를 확인할 수가 없다(실측: 그래서 초록 거짓말이 날 뻔했다).
const cli = (args: readonly string[], env: NodeJS.ProcessEnv = {}) => {
  const r = spawnSync(process.execPath, ['src/shell/cli.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
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
    assert.match(r.err, /--classify-llm/);
  });

  it('모르는 하한선 항목은 던진다', () => {
    const r = cli(['아무거나', '--gate', 'bogus'], NO_PATH);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /그런 하한선 항목이 없다/);
  });
});
