import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMatrix } from '../../data/matrix.ts';
import { JevUnavailableError, type JevChoiceAnswer, type JevChoiceRequest, type RowClassifier } from '../../adapters/jev.ts';
import { NONE, buildCriteria, candidatesText, classifyWithJev, jevReason } from '../classify-jev.ts';

const matrix = loadMatrix();
const answer = (choice: string, probabilities: Record<string, number>, confidence: number): JevChoiceAnswer => ({
  choice, probabilities, confidence, inputTokens: 1000, outputTokens: 10, elapsedMs: 300,
});
const fake = (a: JevChoiceAnswer): { classifier: RowClassifier; requests: JevChoiceRequest[] } => {
  const requests: JevChoiceRequest[] = [];
  return { classifier: (r) => (requests.push(r), Promise.resolve(a)), requests };
};

describe('Jev 분류 (D-065)', () => {
  it('criteria 는 매트릭스 11행에서 만들고 NONE 을 반드시 넣는다 — 모델·effort 는 싣지 않는다', () => {
    const criteria = buildCriteria(matrix);
    assert.deepEqual(Object.keys(criteria), [...matrix.assignments.map((a) => a.id), NONE]);
    assert.match(criteria['R05'] ?? '', /복잡한 버그/);
    assert.doesNotMatch(Object.values(criteria).join(' '), /Astra|Fable|Luna|Haiku/);
  });

  it('확신도가 기준 이상이면 행을 확정한다 — p·conf·토큰을 함께 준다', async () => {
    const { classifier, requests } = fake(answer('R05', { R05: 0.91, R03: 0.05, NONE: 0.04 }, 0.83));
    const v = await classifyWithJev(matrix, classifier, '간헐적 500 원인 찾아줘', { confidenceMin: 0.6 });
    assert.ok(v.kind === 'row');
    assert.equal(v.assignment.id, 'R05');
    assert.equal(jevReason('R05', v.probability, v.confidence), 'Jev R05 p=0.91 conf=0.83');
    assert.equal(v.usage.inputTokens, 1000);
    assert.equal(requests[0]?.state, '간헐적 500 원인 찾아줘');
  });

  it('확신도 미만이면 행을 확정하지 않고 상위 후보 3개를 준다', async () => {
    const { classifier } = fake(answer('R05', { R05: 0.4, R06: 0.3, R07: 0.2, NONE: 0.1 }, 0.36));
    const v = await classifyWithJev(matrix, classifier, '버그도 고치고 테스트도', { confidenceMin: 0.6 });
    assert.equal(v.kind, 'unsure');
    assert.equal(candidatesText(v.candidates), 'R05 0.40 · R06 0.30 · R07 0.20');
  });

  it('NONE 은 확신이 있어도 행이 아니다', async () => {
    const { classifier } = fake(answer('NONE', { NONE: 0.99, R01: 0.01 }, 0.98));
    assert.equal((await classifyWithJev(matrix, classifier, '넌 누구니', { confidenceMin: 0.6 })).kind, 'none');
  });

  it('맥락이 있으면 message 와 함께 보낸다 — 없으면 문장만 간다', async () => {
    const { classifier, requests } = fake(answer('NONE', { NONE: 1 }, 1));
    await classifyWithJev(matrix, classifier, '방금 결과 요약해줘', { confidenceMin: 0.6, context: '사용자: 고쳐줘' });
    assert.deepEqual(requests[0]?.state, { recent_conversation: '사용자: 고쳐줘', message: '방금 결과 요약해줘' });
    assert.match(requests[0]?.instructions ?? '', /recent_conversation/);
  });

  it('우리가 준 옵션이 아닌 선택은 못 쓴 것으로 올린다 — 행을 추측하지 않는다', async () => {
    const { classifier } = fake(answer('R99', { R99: 1 }, 1));
    await assert.rejects(classifyWithJev(matrix, classifier, 'x', { confidenceMin: 0.6 }), JevUnavailableError);
  });
});
