import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, lastSummary } from '../context.ts';
import type { TranscriptRecord } from '../transcript.ts';

const at = '2026-09-23T00:00:00.000Z';
const records: TranscriptRecord[] = [
  { v: 1, at, turn: 1, kind: 'user', text: '넌 누구니' },
  { v: 1, at, turn: 1, kind: 'direct', text: 'hs-orc 다', suggest: null, cost: '$0', notes: [] },
  { v: 1, at, turn: 2, kind: 'user', text: '타입 고쳐줘' },
  { v: 1, at, turn: 2, kind: 'plan', taskId: 'R01', title: 't', reason: 'r', primary: 'p', reviewer: 'v', estimateUsd: 1, notes: [] },
  { v: 1, at, turn: 2, kind: 'result', outcome: 'ok', verdict: 'pass', text: '엔진 원문 긴 출력', review: '', evidence: 'e', decisionId: 'd' },
  { v: 1, at, turn: 2, kind: 'summary', text: '타입을 고쳤다\n둘째 줄', next: '' },
  { v: 1, at, turn: 3, kind: 'user', text: '지금 메시지' },
];
const wide = { contextTurns: 6, contextChars: 6000 };

describe('맥락 자르기 (SPEC §6.4.3)', () => {
  it('user·direct·summary 만 싣고 엔진 원문·배정·결과는 싣지 않는다', () => {
    const text = buildContext(records, wide, { before: 3 });
    assert.match(text, /사용자: 넌 누구니/);
    assert.match(text, /orc: hs-orc 다/);
    assert.match(text, /orc\(위임 결과 요약\): 타입을 고쳤다/);
    assert.doesNotMatch(text, /엔진 원문/);
    assert.doesNotMatch(text, /지금 메시지/);
  });

  it('최근 N턴만 싣는다', () => {
    const text = buildContext(records, { contextTurns: 1, contextChars: 6000 }, { before: 3 });
    assert.doesNotMatch(text, /넌 누구니/);
    assert.match(text, /타입 고쳐줘/);
  });

  it('글자 상한을 넘으면 앞을 자르고 잘렸다고 표시한다', () => {
    const text = buildContext(records, { contextTurns: 6, contextChars: 20 }, { before: 3 });
    assert.equal(text.length, 20);
    assert.ok(text.startsWith('…'));
  });

  it('after 이후 턴만 고른다 — resume 한 엔진은 그 뒤 대화만 받는다', () => {
    const text = buildContext(records, wide, { before: 3, after: 1 });
    assert.doesNotMatch(text, /넌 누구니/);
    assert.match(text, /타입 고쳐줘/);
  });

  it('직전 요약의 첫 줄을 돌려준다', () => {
    assert.equal(lastSummary(records), '타입을 고쳤다');
    assert.equal(lastSummary(records.slice(0, 2)), null);
  });
});
