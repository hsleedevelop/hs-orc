/**
 * 맥락 컷·엔진 압축 알림 줄 (D-053·D-058) — chat 과 GUI 가 함께 쓴다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactLines, cutLine } from '../transcript-lines.ts';

describe('transcript-lines', () => {
  it('컷이 없으면 줄이 없고, 있으면 잘린 턴·글자 수를 한 줄로 알린다', () => {
    assert.deepEqual(cutLine(undefined), []);
    assert.deepEqual(cutLine({ turns: 2, chars: 300 }), ['맥락   앞 대화 2턴·300자를 싣지 못했다']);
  });

  it('압축은 한 번에 한 줄이고, 토큰은 앞뒤가 다 있을 때만 붙인다', () => {
    assert.deepEqual(compactLines(undefined), []);
    assert.deepEqual(compactLines([{ trigger: 'auto', preTokens: 180000, postTokens: 12000 }, { trigger: 'manual', preTokens: 5000 }]), [
      '압축   엔진이 앞 맥락을 요약으로 바꿨다 (auto 180000→12000 토큰)',
      '압축   엔진이 앞 맥락을 요약으로 바꿨다 (manual)',
    ]);
  });
});
