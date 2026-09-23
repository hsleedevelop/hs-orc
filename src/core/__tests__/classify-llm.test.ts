import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { CLASSIFIER_MODELS, ClassifierModelError, buildClassifyPrompt, classifyWithModel } from '../classify-llm.ts';

const matrix = loadMatrix();

describe('분류 폴백', () => {
  it('분류에는 저비용 모델만 허용한다 — Fable 요청은 던진다', async () => {
    assert.deepEqual([...CLASSIFIER_MODELS], ['haiku']);
    await assert.rejects(
      () => classifyWithModel(matrix, loadEngines(), '아무거나', { model: 'fable' }),
      ClassifierModelError,
    );
  });

  it('luna 도 던진다 — codex 는 지휘자 격리 수단이 없어 실행 전에 막는다 (D-037)', async () => {
    await assert.rejects(
      () => classifyWithModel(matrix, loadEngines(), '아무거나', { model: 'luna' }),
      ClassifierModelError,
    );
  });

  it('프롬프트는 11행 id 와 제목만 주고 id 하나를 요구한다', () => {
    const prompt = buildClassifyPrompt(matrix, '타입 에러');
    assert.match(prompt, /R01\t짧은 구현 \/ 타입 수정/);
    assert.match(prompt, /R11\t/);
    assert.match(prompt, /id만/);
    assert.match(prompt, /NONE/);
  });

  /**
   * D-029: 분류기는 **넘겨받은 폴더**에서 돈다. PATH 앞에 가짜 `claude` 를 놓고
   * 그 스크립트가 자기 `$PWD` 를 보고 다른 id 를 답하게 한다 — 인자를 읽었다고 단언하는 게 아니라
   * **실제로 그 폴더에서 떴는지**를 본다.
   */
  it('분류기는 넘겨받은 폴더에서 뜬다 — 폴더를 바꾼 셸의 분류가 옛 폴더에 남으면 안 된다', async () => {
    const here = mkdtempSync(path.join(os.tmpdir(), 'hs-classify-'));
    const project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hs-project-')));
    const bin = path.join(here, 'claude');
    writeFileSync(
      bin,
      // `$PWD` 는 **부모 환경에서 상속된다** — spawn 의 cwd 를 반영하지 않는다. `pwd -P` 가 실제 폴더다.
      ['#!/bin/sh', 'here=$(pwd -P)', `if [ "$here" = "${project}" ]; then id=R03; else id=R01; fi`,
       `printf '{"type":"result","is_error":false,"result":"%s"}\\n' "$id"`, ''].join('\n'),
      'utf8',
    );
    chmodSync(bin, 0o755);

    const realPath = process.env['PATH'];
    process.env['PATH'] = `${here}${path.delimiter}${realPath ?? ''}`;
    try {
      const withCwd = await classifyWithModel(matrix, loadEngines(), '아무거나', { cwd: project });
      assert.equal(withCwd.assignment?.id, 'R03', '넘긴 폴더에서 돌지 않았다');

      const withoutCwd = await classifyWithModel(matrix, loadEngines(), '아무거나');
      assert.equal(withoutCwd.assignment?.id, 'R01', '기본은 process.cwd() 그대로다 — CLI·TUI 는 안 바뀐다');
    } finally {
      process.env['PATH'] = realPath;
    }
  });

  /**
   * D-034: 행뿐 아니라 **실행 결과**(성공 여부·실측 금액·측정 토큰)를 돌려준다 —
   * 안 그러면 어떤 셸도 분류 폴백의 비용을 셀 수 없다.
   */
  it('실측 비용·토큰·성공 여부를 함께 돌려준다', async () => {
    const here = mkdtempSync(path.join(os.tmpdir(), 'hs-classify-outcome-'));
    const bin = path.join(here, 'claude');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'printf \'{"type":"result","is_error":false,"result":"R02","total_cost_usd":0.015,"usage":{"input_tokens":900,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}\\n\'',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(bin, 0o755);

    const realPath = process.env['PATH'];
    process.env['PATH'] = `${here}${path.delimiter}${realPath ?? ''}`;
    try {
      const outcome = await classifyWithModel(matrix, loadEngines(), '아무거나');
      assert.equal(outcome.ok, true);
      assert.equal(outcome.assignment?.id, 'R02');
      assert.equal(outcome.model, 'haiku');
      assert.equal(outcome.effort, 'low');
      assert.equal(outcome.actualUsd, 0.015);
      assert.deepEqual(outcome.usage, {
        inputTokens: 900, outputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0,
      });
    } finally {
      process.env['PATH'] = realPath;
    }
  });

  it('엔진이 실패해도 성공 여부·비용은 돌려준다 — 쓴 것은 과금 대상이다', async () => {
    const here = mkdtempSync(path.join(os.tmpdir(), 'hs-classify-outcome-fail-'));
    const bin = path.join(here, 'claude');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'printf \'{"type":"result","is_error":true,"result":"","total_cost_usd":0.004}\\n\'',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(bin, 0o755);

    const realPath = process.env['PATH'];
    process.env['PATH'] = `${here}${path.delimiter}${realPath ?? ''}`;
    try {
      const outcome = await classifyWithModel(matrix, loadEngines(), '아무거나');
      assert.equal(outcome.ok, false);
      assert.equal(outcome.assignment, null);
      assert.equal(outcome.actualUsd, 0.004);
      assert.match(outcome.failure ?? '', /error/, '실패 사유가 없으면 셸이 "맞는 행 없음"과 구분하지 못한다.');
    } finally {
      process.env['PATH'] = realPath;
    }
  });
});
