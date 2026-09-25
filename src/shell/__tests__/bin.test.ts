import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 진입점의 **경로 해석**을 프로세스 수준에서 고정한다.
 *
 * 두 기준이 섞여 있고 그게 의도다:
 *   설치 위치 기준 — data/{matrix,engines,limits,verify}.json (어디서 부르든 같은 매트릭스)
 *   cwd 기준       — .hs-orc/ (실행 산출물은 작업 중인 프로젝트에 쌓인다)
 * 둘 중 하나가 반대로 뒤집히면 "다른 디렉터리에서 부를 수 있다"가 조용히 거짓이 된다.
 *
 * 그래서 이 테스트는 반드시 **저장소 바깥** 디렉터리를 cwd 로 잡고 돈다.
 */
const BIN = path.resolve(import.meta.dirname, '..', '..', '..', 'bin', 'hs-orc.mjs');

// execFileSync 는 성공했을 때 stderr 를 돌려주지 않아 "조용히 끝났다"를 확인할 수 없다 (cli.test.ts 와 같은 이유).
// PATH 를 비워 둔다 — 여기서는 엔진을 띄울 일이 없고, 띄우려 했다면 바이너리 해석이 터져 드러난다.
const outside = mkdtempSync(path.join(os.tmpdir(), 'hs-orc-bin-'));
after(() => rmSync(outside, { recursive: true, force: true }));

const hsOrc = (args: readonly string[], cwd = outside) => {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
};

describe('hs-orc 진입점', () => {
  it('저장소 바깥에서 불러도 매트릭스를 찾는다 — data/*.json 은 설치 위치 기준', () => {
    const r = hsOrc(['이 타입 에러 고쳐줘']);
    assert.equal(r.code, 0);
    assert.match(r.err, /업무\s+R01/);
    assert.match(r.err, /primary\s+Luna/);
    assert.match(r.err, /reviewer Haiku/);
    assert.match(r.err, /실제 실행은 --run/);
  });

  it('실행 산출물은 부른 디렉터리에 쌓인다 — .hs-orc 는 cwd 기준', () => {
    const project = mkdtempSync(path.join(os.tmpdir(), 'hs-orc-proj-'));
    try {
      const r = hsOrc(['오늘 점심 뭐 먹지'], project);
      assert.notEqual(r.code, 0);
      assert.match(r.err, /분류하지 못했다/);
      assert.ok(
        existsSync(path.join(project, '.hs-orc', 'unclassified.jsonl')),
        '미분류 로그가 부른 디렉터리에 생기지 않았다 — 설치 위치로 샜다는 뜻이다.',
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('tui 하위명령은 cli 로 새지 않는다', () => {
    // TTY 없이도 라우팅만 확인할 수 있는 경로다 — tui/main.ts 만 이 문구를 낸다.
    const r = hsOrc(['tui', '--screen', 'bogus']);
    assert.equal(r.code, 1);
    assert.match(r.err, /그런 화면이 없다: bogus/);
  });

  it('chat --list 는 cli 로 새지 않고 세션 목록을 낸다', () => {
    const r = spawnSync(process.execPath, [BIN, 'chat', '--list'], {
      cwd: outside,
      encoding: 'utf8',
      env: { ...process.env, PATH: '', HS_ORC_SCRATCH: path.join(outside, 'scratch') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /세션 없음/);
    assert.doesNotMatch(r.stderr, /업무/);
  });

  it('chat --resume 에 없는 id 를 주면 새 세션을 만들지 않고 1 로 끝난다', () => {
    const r = spawnSync(process.execPath, [BIN, 'chat', '--resume', 'nope'], {
      cwd: outside,
      encoding: 'utf8',
      env: { ...process.env, PATH: '', HS_ORC_SCRATCH: path.join(outside, 'scratch') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /그런 세션이 없다: nope/);
    assert.equal(existsSync(path.join(outside, '.hs-orc', 'sessions')), false);
  });

  it('`--` 뒤의 첫 낱말은 하위명령이 아니다', () => {
    const r = hsOrc(['--', 'tui 화면 하나 만들어줘']);
    assert.equal(r.code, 0);
    assert.match(r.err, /업무\s+R03/);
    assert.doesNotMatch(r.err, /그런 화면이 없다/);
  });
});
