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
    assert.deepEqual([...CLASSIFIER_MODELS], ['haiku', 'luna']);
    await assert.rejects(
      () => classifyWithModel(matrix, loadEngines(), '아무거나', { model: 'fable' }),
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
      assert.equal(withCwd?.id, 'R03', '넘긴 폴더에서 돌지 않았다');

      const withoutCwd = await classifyWithModel(matrix, loadEngines(), '아무거나');
      assert.equal(withoutCwd?.id, 'R01', '기본은 process.cwd() 그대로다 — CLI·TUI 는 안 바뀐다');
    } finally {
      process.env['PATH'] = realPath;
    }
  });
});
