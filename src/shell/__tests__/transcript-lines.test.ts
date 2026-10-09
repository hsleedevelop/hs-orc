/**
 * 맥락 컷·엔진 압축 알림 줄 (D-053·D-058) — chat 과 GUI 가 함께 쓴다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SETTING_KINDS as CORE_SETTING_KINDS } from '../../core/transcript.ts';
import { SETTING_KINDS, compactLines, cutLine, lastEvent } from '../transcript-lines.ts';

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

  it('살아 있는 카드·제안 판정의 마지막 기록은 이름 줄을 건너뛴다 — 승인 대기 중 이름을 붙여도 카드 버튼이 남는다 (PR #111 리뷰 4)', () => {
    const plan = { kind: 'plan', turn: 1 };
    assert.equal(lastEvent([{ kind: 'user', turn: 1 }, plan, { kind: 'name', turn: 1 }]), plan);
    assert.equal(lastEvent([{ kind: 'name', turn: 0 }]), undefined);
  });

  it('역할·비용 줄도 건너뛴다 — 승인 대기 중 오케스트레이터로 지정해도 카드 버튼이 남는다 (D-090)', () => {
    const plan = { kind: 'plan', turn: 1 };
    assert.equal(lastEvent([{ kind: 'user', turn: 1 }, plan, { kind: 'role', turn: 1 }, { kind: 'spend', turn: 1 }]), plan);
  });

  it('건너뛰는 설정 줄 목록이 Core(`transcript.ts`)와 같다 — 한쪽에만 더하면 화면과 Core 가 다른 카드를 살아 있다고 본다', () => {
    assert.deepEqual([...SETTING_KINDS].sort(), [...CORE_SETTING_KINDS].sort());
  });
});
