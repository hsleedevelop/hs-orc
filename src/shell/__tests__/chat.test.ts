/**
 * `hs-orc chat` (D-056). 실행기는 전부 가짜다 — 이 파일이 돈을 쓰면 아무도 안 돌린다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptRecord } from '../../core/transcript.ts';
import { renderRecord } from '../chat.ts';

const at = { v: 1 as const, at: '2026-09-26T00:00:00.000Z', turn: 1 };

describe('chat — 기록 렌더', () => {
  it('직접 답은 본문·비용을 찍고, 제안이 있으면 /task 명령을 알려준다', () => {
    const lines = renderRecord({ ...at, kind: 'direct', text: '안녕하세요', suggest: 'R01', cost: '$0.0110 actual', notes: [] });
    assert.deepEqual(lines, ['안녕하세요', '비용   $0.0110 actual', '제안   R01 — /task R01 로 위임한다']);
  });

  it('배정은 두 슬롯과 추정 비용을 찍는다', () => {
    const lines = renderRecord({
      ...at, kind: 'plan', taskId: 'R01', title: '타입 에러', reason: '규칙', primary: 'Luna·low → codex/x', reviewer: 'Haiku·low → claude/y', estimateUsd: 0.5, notes: [],
    });
    assert.deepEqual(lines, ['업무   R01 타입 에러  (규칙)', '배정   primary  Luna·low → codex/x', '       reviewer Haiku·low → claude/y', '비용   $0.5 (추정)']);
  });

  it('맥락을 잘랐으면 잘린 양을 알린다 (D-053)', () => {
    const lines = renderRecord({ ...at, kind: 'direct', text: '답', suggest: null, cost: '$0 x', notes: [], cut: { turns: 2, chars: 300 } });
    assert.ok(lines.includes('맥락   앞 대화 2턴·300자를 싣지 못했다'));
  });

  it('spend 줄은 화면에 찍지 않는다 (D-054)', () => {
    assert.deepEqual(renderRecord({ ...at, kind: 'spend', charges: [], tokens: 0, unreported: 0 } as unknown as TranscriptRecord), []);
  });
});
