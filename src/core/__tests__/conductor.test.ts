import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { LEGACY_ORCHESTRATOR, StepsError, buildDirectPrompt, buildSummaryPrompt, conductorSlot, defaultOrchestrator, directAnswer, nextSuggestion, orchestratorOptions, parseSteps, parseSuggest } from '../conductor.ts';
import { buildInvocation } from '../../adapters/resolve.ts';
import type { SlotExecutor } from '../executor.ts';

const matrix = loadMatrix();
const catalog = loadEngines();

describe('지휘자 — 직접 답 (SPEC §6.4.2)', () => {
  it('옛 지휘자는 Haiku·low 이고, 쓰기를 줄 수 없는 reviewer 자리로 뜬다', () => {
    const slot = conductorSlot(catalog, LEGACY_ORCHESTRATOR);
    assert.equal(slot.model, 'haiku');
    assert.equal(slot.effort, 'low');
    assert.equal(slot.role, 'reviewer');
    assert.equal(slot.label, '지휘자·Haiku');
    assert.equal(slot.longContext, undefined, 'Haiku 에는 1M 선언이 없다');
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

  it('행이 확정되지 않은 턴(D-079)은 행 제안 대신 직접 고르라고 안내하게 한다 — 진행 중이라 말하지 않는 규칙은 두 경우 다 싣는다', () => {
    const routed = buildDirectPrompt(matrix, '', '로그인 버그 고쳐줘');
    const unrouted = buildDirectPrompt(matrix, '', '로그인 버그 고쳐줘', { unrouted: true });
    assert.match(routed, /맞는 행을 제안한다/);
    assert.doesNotMatch(unrouted, /맞는 행을 제안한다/);
    assert.match(unrouted, /업무 행에 배정되지 않았다/);
    assert.match(unrouted, /위임하기.*\/task Rxx/);
    assert.match(unrouted, /`SUGGEST: NONE` 이다/);
    for (const p of [routed, unrouted]) assert.match(p, /진행 중이라거나 곧 진행한다고 말하지 않는다/);
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
    const answer = await directAnswer(conduct, conductorSlot(catalog, LEGACY_ORCHESTRATOR), matrix, '', '넌 누구니');
    assert.equal(prompts.length, 1);
    assert.equal(answer.body, '안녕하세요.');
    assert.equal(answer.suggest, null);
  });
});

describe('지휘자 모델 선택 (D-087)', () => {
  it('기본은 벤더마다 그 CLI 의 기본 모델·high 이고 1M 창으로 뜬다 — claude 는 모델 id 끝, codex 는 설정 인자', () => {
    const claude = conductorSlot(catalog, defaultOrchestrator('claude'));
    assert.deepEqual([claude.engine, claude.modelId, claude.effort, claude.role, claude.longContext], ['claude', 'claude-opus-5-5', 'high', 'reviewer', true]);
    assert.equal(buildInvocation(catalog, claude.model, claude.effort, 'X', { isolate: true, longContext: true }).modelId, 'claude-opus-5-5[1m]');
    const codex = conductorSlot(catalog, defaultOrchestrator('codex'));
    assert.deepEqual([codex.engine, codex.modelId, codex.effort, codex.role, codex.longContext], ['codex', 'gpt-6.1-sol', 'high', 'reviewer', true]);
    const argv = buildInvocation(catalog, codex.model, codex.effort, 'X', { isolate: true, longContext: true }).argv;
    assert.ok(argv.join(' ').includes('-c model_context_window=1000000'));
    assert.ok(argv.includes('--ignore-user-config'), 'codex 지휘자도 사용자 설정을 싣지 않는다 (D-032 B1)');
    assert.equal(defaultOrchestrator().model, 'opus', '시작 엔진은 claude 다');
  });

  it('1M 선언이 없는 모델에 1M 을 요청하면 기본 창으로 바꾸지 않고 던진다', () => {
    assert.throws(() => buildInvocation(catalog, 'haiku', 'low', 'X', { longContext: true }), /1M 창 선언이 없다/);
  });

  it('선택지는 엔진마다 그 엔진이 기본인 모델이고, 모르는 모델은 지휘자로 받지 않는다', () => {
    const options = orchestratorOptions(catalog);
    assert.deepEqual(options.map((o) => o.engine), ['claude', 'codex']);
    assert.ok(options[0]?.models.some((m) => m.model === 'opus' && m.longContext));
    assert.ok(options[1]?.models.every((m) => catalog.models[m.model].defaultEngine === 'codex'));
    assert.throws(() => conductorSlot(catalog, { model: 'nope' as 'opus', effort: 'high' }), /모르는 지휘자 모델/);
  });
});

describe('지휘자 — 단계 계획 (D-087)', () => {
  it('행·의존을 검사해 단계마다 매트릭스 배정을 붙인다 — 펜스를 둘러도 읽는다', () => {
    const nodes = parseSteps(matrix, catalog, '```json\n{"steps":[{"id":"s1","task":"R03","prompt":"원인 찾기","dependsOn":[]},{"id":"s2","task":"R01","prompt":"고치기","dependsOn":["s1"]}]}\n```', 24);
    assert.deepEqual(nodes.map((n) => [n.id, n.plan.assignment.id, n.dependsOn]), [['s1', 'R03', []], ['s2', 'R01', ['s1']]]);
    assert.ok(nodes.every((n) => n.onFailure === 'skip-dependents'));
  });

  it('없는 행·순환·모양 틀림·상한 초과는 계획으로 받지 않는다', () => {
    const bad = (steps: unknown, max = 24) => () => parseSteps(matrix, catalog, JSON.stringify({ steps }), max);
    assert.throws(bad([{ id: 's1', task: 'R99', prompt: 'x' }]), StepsError);
    assert.throws(bad([{ id: 'a', task: 'R01', prompt: 'x', dependsOn: ['b'] }, { id: 'b', task: 'R01', prompt: 'y', dependsOn: ['a'] }]), /순환/);
    assert.throws(bad([{ id: 's1', task: 'R01', prompt: 'x', dependsOn: 's0' }]), /모양이 틀렸다/);
    assert.throws(bad([{ id: 's1', task: 'R01', prompt: 'x' }, { id: 's2', task: 'R01', prompt: 'y' }], 1), /상한/);
    assert.throws(() => parseSteps(matrix, catalog, '계획은 이렇습니다', 24), /JSON 이 없다/);
  });
});

describe('지휘자 — 결과 처리 (SPEC §6.4.4)', () => {
  it('요약 프롬프트는 날조 금지와 판정·증거·outcome 을 싣는다', () => {
    const prompt = buildSummaryPrompt('타입 고쳐줘', {
      text: '고쳤다', verdict: 'pass', outcome: 'unverified',
      report: { satisfied: false, contradictions: [], missing: [], rejected: [], accepted: [], summary: '증거 0/1' },
    });
    assert.ok(prompt.startsWith('아래 위임 결과'));
    assert.match(prompt, /지어내지 않는다/);
    assert.match(prompt, /\[reviewer 판정\] pass/);
    assert.match(prompt, /\[증거\] 증거 0\/1/);
    assert.match(prompt, /\[outcome\] unverified/);
  });

  it('검증된 통과면 다음 제안이 없다', () => {
    assert.equal(nextSuggestion('ok', 'pass'), '');
  });

  it('미검증·실패·FAIL 이면 사다리의 첫 단계를 코드가 제안한다 — 모델이 정하지 않는다', () => {
    for (const [outcome, verdict] of [['unverified', 'pass'], ['wrong', 'unknown'], ['ok', 'fail']] as const) {
      assert.match(nextSuggestion(outcome, verdict), /코드·로그·재현 조건 보강/);
    }
  });

  it('세션이 계산한 다음 단계를 그대로 안내하고, 올릴 곳이 없으면 그렇게 말한다 (D-068) — 취소·성공은 여전히 비어 있다', () => {
    assert.match(nextSuggestion('rework', 'fail', { label: '②effort 상향' }), /사다리 다음 단계: ②effort 상향/);
    assert.match(nextSuggestion('rework', 'fail', null), /더 올릴 곳이 없다/);
    assert.equal(nextSuggestion('cancelled', 'unknown', { label: '②effort 상향' }), '');
    assert.equal(nextSuggestion('ok', 'pass', null), '');
  });
});
