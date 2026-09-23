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

describe('의존성 감지', () => {
  it('매니페스트가 없으면 unknown 이다 — 모르는 생태계를 아는 척하지 않는다', () => {
    assert.deepEqual(depStatus(sandbox()), { kind: 'unknown' });
  });

  it('package.json 은 있고 node_modules 가 없으면 missing 이다', () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, 'package.json'), '{}', 'utf8');
    assert.deepEqual(depStatus(dir), { kind: 'missing', manifest: 'package.json', install: 'npm install' });
  });

  it('lock 파일이 있으면 `npm ci` 다 — 버전이 본체와 갈리면 검증이 거짓이 된다', () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, 'package.json'), '{}', 'utf8');
    writeFileSync(path.join(dir, 'package-lock.json'), '{}', 'utf8');
    const status = depStatus(dir);
    assert.equal(status.kind, 'missing');
    assert.equal(status.kind === 'missing' ? status.install : '', 'npm ci');
  });

  it('설치돼 있으면 ready 다', () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, 'package.json'), '{}', 'utf8');
    mkdirSync(path.join(dir, 'node_modules'));
    assert.deepEqual(depStatus(dir), { kind: 'ready', manifest: 'package.json' });
  });

  it('node_modules 가 파일이면 설치된 것이 아니다', () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, 'package.json'), '{}', 'utf8');
    writeFileSync(path.join(dir, 'node_modules'), 'not a dir', 'utf8');
    assert.equal(depStatus(dir).kind, 'missing');
  });
});
