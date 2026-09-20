import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadEngines } from '../../data/engines.ts';
import { EngineError, buildInvocation } from '../resolve.ts';

const catalog = loadEngines();
const build = (model: Parameters<typeof buildInvocation>[1], effort: string, engine?: 'claude' | 'codex' | 'cursor') =>
  buildInvocation(catalog, model, effort, 'PROMPT', engine);

describe('argv 생성', () => {
  it('codex 는 exec 서브커맨드와 -c model_reasoning_effort 를 쓴다', () => {
    assert.deepEqual(build('sol', 'xhigh').argv, [
      'exec', 'PROMPT', '-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="xhigh"',
    ]);
  });

  it('claude 는 -p 와 --effort 를 쓴다', () => {
    assert.deepEqual(build('fable', 'high').argv, [
      '-p', 'PROMPT', '--model', 'claude-fable-5-1', '--effort', 'high',
    ]);
  });

  it('cursor 는 effort 를 모델 id 접미사로 녹이고 별도 플래그를 두지 않는다', () => {
    const invocation = build('opus', 'max', 'cursor');
    assert.equal(invocation.modelId, 'claude-opus-5-thinking-max');
    assert.deepEqual(invocation.argv, ['-p', 'PROMPT', '--model', 'claude-opus-5-thinking-max']);
  });
});

describe('명시적 실패', () => {
  it('정규 어휘 밖의 effort 는 던진다 (조용한 폴백 없음)', () => {
    assert.throws(() => build('sol', 'bogus'), EngineError);
    assert.throws(() => build('sol', 'ultra'), EngineError);
  });

  it('cursor 에 없는 Astra·Haiku 는 가장 가까운 모델로 바뀌지 않고 던진다', () => {
    assert.throws(() => build('astra', 'max', 'cursor'), /cursor 는 astra 를 제공하지 않는다/);
    assert.throws(() => build('haiku', 'low', 'cursor'), /cursor 는 haiku 를 제공하지 않는다/);
  });

  it('벤더가 다른 엔진에 모델을 요청하면 던진다', () => {
    assert.throws(() => build('fable', 'high', 'codex'), EngineError);
    assert.throws(() => build('sol', 'high', 'claude'), EngineError);
  });
});
