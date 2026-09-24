/**
 * 의존성 감지 (D-028 후속). 워크트리를 새로 만들면 `node_modules` 가 따라오지 않고,
 * 그 상태로 `--write` 를 켜면 primary 가 **시간과 돈을 태우고 나서야** 막힌다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { depStatus } from '../deps.ts';

const sandbox = () => mkdtempSync(path.join(os.tmpdir(), 'hs-deps-'));
const WITH_DEPS = JSON.stringify({ dependencies: { left: '1.0.0' } });

describe('의존성 감지', () => {
  it('매니페스트가 없으면 unknown 이다 — 모르는 생태계를 아는 척하지 않는다', () => {
    assert.deepEqual(depStatus(sandbox()), { kind: 'unknown' });
  });

  it('package.json 은 있고 node_modules 가 없으면 missing 이다', () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, 'package.json'), WITH_DEPS, 'utf8');
    assert.deepEqual(depStatus(dir), { kind: 'missing', manifest: 'package.json', install: 'npm install' });
  });

  it('lock 파일이 있으면 `npm ci` 다 — 버전이 본체와 갈리면 검증이 거짓이 된다', () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, 'package.json'), WITH_DEPS, 'utf8');
    writeFileSync(path.join(dir, 'package-lock.json'), '{}', 'utf8');
    const status = depStatus(dir);
    assert.equal(status.kind, 'missing');
    assert.equal(status.kind === 'missing' ? status.install : '', 'npm ci');
  });

  it('설치돼 있으면 ready 다', () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, 'package.json'), WITH_DEPS, 'utf8');
    mkdirSync(path.join(dir, 'node_modules'));
    assert.deepEqual(depStatus(dir), { kind: 'ready', manifest: 'package.json' });
  });

  it('의존성을 하나도 선언하지 않았으면 node_modules 가 없어도 ready 다 — 설치할 것이 없다', () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }), 'utf8');
    assert.deepEqual(depStatus(dir), { kind: 'ready', manifest: 'package.json' });
  });

  it('workspaces 가 있으면 루트에 의존성이 없어도 missing 이다 — 설치는 하위 패키지 몫이다', () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }), 'utf8');
    assert.equal(depStatus(dir).kind, 'missing');
  });

  it('package.json 을 못 읽으면 missing 이다 — 확인 못 한 것을 "설치할 것 없음" 으로 넘기지 않는다', () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, 'package.json'), '{ broken', 'utf8');
    assert.equal(depStatus(dir).kind, 'missing');
  });

  it('node_modules 가 파일이면 설치된 것이 아니다', () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, 'package.json'), WITH_DEPS, 'utf8');
    writeFileSync(path.join(dir, 'node_modules'), 'not a dir', 'utf8');
    assert.equal(depStatus(dir).kind, 'missing');
  });
});
