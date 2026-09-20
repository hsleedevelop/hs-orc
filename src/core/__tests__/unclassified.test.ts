import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUnclassified, recordUnclassified, shapeKey, suggestRows } from '../unclassified.ts';

const tmp = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'hs-unc-')), 'u.jsonl');

describe('미분류 누적 (D-022)', () => {
  it('임계치 전에는 제안하지 않는다', () => {
    const f = tmp();
    recordUnclassified('점심 메뉴 골라줘', f);
    recordUnclassified('점심 메뉴 골라줘', f);
    assert.deepEqual(suggestRows(readUnclassified(f)), []);
  });

  it('같은 모양이 3회 쌓이면 제안한다 — 추가는 원본 편집이라고 말한다', () => {
    const f = tmp();
    for (let i = 0; i < 3; i += 1) recordUnclassified('점심 메뉴 골라줘', f);
    const [s] = suggestRows(readUnclassified(f));
    assert.equal(s?.count, 3);
    assert.match(s?.message ?? '', /원본 HTML/);
    assert.match(s?.message ?? '', /gen:matrix/);
  });

  it('제안은 매트릭스를 건드리지 않는다 — 반환값일 뿐이다', () => {
    const f = tmp();
    for (let i = 0; i < 4; i += 1) recordUnclassified('무언가 다른 일', f);
    const before = readUnclassified(f).length;
    suggestRows(readUnclassified(f));
    assert.equal(readUnclassified(f).length, before);
  });

  it('모양 키는 어순이 달라도 같은 묶음으로 본다', () => {
    assert.equal(shapeKey('점심 메뉴 골라줘'), shapeKey('메뉴 골라줘 점심'));
    assert.notEqual(shapeKey('점심 메뉴'), shapeKey('배포 롤백'));
  });

  it('로그가 없는 것은 정상이다', () => {
    assert.deepEqual(readUnclassified(tmp()), []);
  });
});
