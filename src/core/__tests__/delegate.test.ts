import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { assign } from '../assign.ts';
import { Budget } from '../budget.ts';
import { readDecisions } from '../decision-log.ts';
import { delegate } from '../delegate.ts';
import type { SlotExecutor } from '../executor.ts';
import { Journal } from '../journal.ts';

const matrix = loadMatrix();
const catalog = loadEngines();
const row = (id: string) => matrix.assignments.find((a) => a.id === id)!;

describe('위임 1건 (SPEC §4 5~7단계)', () => {
  it('결정 로그에는 사용자 문장을, 엔진에는 맥락이 붙은 프롬프트를 보내고 note 로 세션을 잇는다', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-delegate-'));
    const log = path.join(dir, 'log.jsonl');
    process.env['HS_ORC_DECISION_LOG'] = log;
    process.env['HS_ORC_RUN_STORE'] = path.join(dir, 'runs');
    const prompts: string[] = [];
    const execute: SlotExecutor = (slot, prompt) => {
      prompts.push(prompt);
      return Promise.resolve({ ok: true, text: slot.label === 'Haiku' ? 'PASS' : 'ran', rawStdout: '', rawStderr: '', durationMs: 1 });
    };

    const d = await delegate({
      matrix, plan: assign(matrix, catalog, row('R01')), reason: '수동 지정 R01',
      title: '타입 고쳐줘', prompt: '[최근 대화]\n사용자: 앞\n\n[이번 요청]\n타입 고쳐줘',
      verify: [], cwd: process.cwd(), execute, budget: new Budget(20, 2_000_000), journal: new Journal(),
      note: 'session 0923-1200-aaa',
    });

    const lines = readDecisions(log).filter((r) => r.id === d.decisionId);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.task, '타입 고쳐줘');
    assert.match(lines[0]?.note ?? '', / · session 0923-1200-aaa$/);
    assert.match(prompts[0] ?? '', /^\[최근 대화\]/);
    assert.equal(d.outcome, 'unverified');
    assert.equal(d.verdict, 'pass');
  });

  it('검증 명령이 실패하면 결정 로그 2차 outcome 은 ok 가 아니라 rework 다 (D-043)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-delegate-'));
    const log = path.join(dir, 'log.jsonl');
    process.env['HS_ORC_DECISION_LOG'] = log;
    process.env['HS_ORC_RUN_STORE'] = path.join(dir, 'runs');
    const execute: SlotExecutor = (slot) =>
      Promise.resolve({ ok: true, text: slot.label === 'Haiku' ? 'PASS' : 'ran', rawStdout: '', rawStderr: '', durationMs: 1 });

    const d = await delegate({
      matrix, plan: assign(matrix, catalog, row('R01')), reason: '수동 지정 R01', title: '타입 고쳐줘', prompt: '타입 고쳐줘',
      verify: ['exit 1'], cwd: dir, execute, budget: new Budget(20, 2_000_000), journal: new Journal(),
    });

    assert.equal(d.outcome, 'rework');
    assert.equal(readDecisions(log).filter((r) => r.id === d.decisionId).at(-1)?.outcome, 'rework');
  });
});
