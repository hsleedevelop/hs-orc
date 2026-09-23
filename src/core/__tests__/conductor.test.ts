import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { buildDirectPrompt, conductorSlot, directAnswer, parseSuggest } from '../conductor.ts';
import type { SlotExecutor } from '../executor.ts';

const matrix = loadMatrix();
const catalog = loadEngines();

describe('지휘자 — 직접 답 (SPEC §6.4.2)', () => {
  it('Haiku·low 이고, 쓰기를 줄 수 없는 reviewer 자리로 뜬다', () => {
    const slot = conductorSlot(catalog);
    assert.equal(slot.model, 'haiku');
    assert.equal(slot.effort, 'low');
    assert.equal(slot.role, 'reviewer');
    assert.equal(slot.label, '지휘자·Haiku');
  });

  it('마지막 줄의 SUGGEST 만 제안으로 읽고 본문에서 뗀다', () => {
    assert.deepEqual(parseSuggest(matrix, '타입 수정 작업이다.\nSUGGEST: R01'), { body: '타입 수정 작업이다.', suggest: 'R01' });
  });

  it('NONE·없는 행·마지막 줄이 아닌 SUGGEST 는 제안이 아니다', () => {
    assert.equal(parseSuggest(matrix, '잡담\nSUGGEST: NONE').suggest, null);
    assert.equal(parseSuggest(matrix, '이상한 행\nSUGGEST: R99').suggest, null);
    const mid = parseSuggest(matrix, 'SUGGEST: R01\n그런데 한 줄 더');
    assert.equal(mid.suggest, null);
    assert.equal(mid.body, 'SUGGEST: R01\n그런데 한 줄 더');
  });

  it('프롬프트는 읽기 전용·결과 날조 금지·행 목록·최근 대화를 싣는다', () => {
    const prompt = buildDirectPrompt(matrix, '사용자: 앞 질문', '넌 누구니');
    assert.match(prompt, /파일을 고치거나 명령을 실행하지 않는다/);
    assert.match(prompt, /결과를 지어내지 않는다/);
    assert.match(prompt, /R01\t/);
    assert.match(prompt, /\[최근 대화\]\n사용자: 앞 질문/);
    assert.ok(prompt.endsWith('넌 누구니'));
  });

  it('맥락이 비면 [최근 대화] 절을 만들지 않는다', () => {
    assert.doesNotMatch(buildDirectPrompt(matrix, '', 'hi'), /최근 대화/);
  });

  it('실행기를 한 번 부르고 제안을 읽어 돌려준다', async () => {
    const prompts: string[] = [];
    const conduct: SlotExecutor = (_slot, prompt) => {
      prompts.push(prompt);
      return Promise.resolve({ ok: true, text: '안녕하세요.\nSUGGEST: NONE', rawStdout: '', rawStderr: '', durationMs: 1 });
    };
    const answer = await directAnswer(conduct, conductorSlot(catalog), matrix, '', '넌 누구니');
    assert.equal(prompts.length, 1);
    assert.equal(answer.body, '안녕하세요.');
    assert.equal(answer.suggest, null);
  });
});
