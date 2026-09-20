import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultVerify, parseVerify } from '../verify.ts';

const withConfig = (json: unknown) => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'hs-ver-')), 'verify.json');
  writeFileSync(file, JSON.stringify(json), 'utf8');
  return { HS_ORC_VERIFY_CONFIG: file };
};

describe('기본 검증 명령은 선언이지 추론이 아니다', () => {
  it('선언이 없으면 빈 배열이다 — "기본값이 있겠지"로 채우지 않는다', () => {
    assert.deepEqual(defaultVerify('R01', withConfig({ default: [], R01: [] })), []);
    assert.deepEqual(defaultVerify('R07', { HS_ORC_VERIFY_CONFIG: '/없는/경로.json' }), []);
  });

  it('default 와 행별 선언을 합친다', () => {
    const env = withConfig({ default: ['npm run lint'], R01: ['npm test'] });
    assert.deepEqual(defaultVerify('R01', env).map((v) => v.cmd), ['npm run lint', 'npm test']);
    assert.deepEqual(defaultVerify('R09', env).map((v) => v.cmd), ['npm run lint']);
  });

  it('phase 접두를 떼어낸다 — 명령 안의 콜론은 건드리지 않는다', () => {
    assert.deepEqual(parseVerify('before:npm test'), { cmd: 'npm test', phase: 'before' });
    assert.deepEqual(parseVerify('curl http://x:8080'), { cmd: 'curl http://x:8080' });
  });

  it('배열이 아닌 값이나 빈 문자열은 무시한다', () => {
    const env = withConfig({ default: 'npm test', R01: ['', '  ', 'npm test'] });
    assert.deepEqual(defaultVerify('R01', env).map((v) => v.cmd), ['npm test']);
  });
});
