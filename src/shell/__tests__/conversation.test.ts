/**
 * 세션 조립 (D-056) — GUI·CLI 가 같은 조립을 쓴다. 실행기는 가짜다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SlotExecutor } from '../../core/executor.ts';
import { Journal } from '../../core/journal.ts';
import { prepareSession } from '../../core/transcript.ts';
import { assembleSession, restoreBudget } from '../conversation.ts';

const isolated = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-conv-'));
  process.env['HS_ORC_DECISION_LOG'] = path.join(dir, 'log.jsonl');
  process.env['HS_ORC_RUN_STORE'] = path.join(dir, 'runs');
  process.env['HS_ORC_SCRATCH'] = path.join(dir, 'scratch');
};

const fake = () => {
  const calls: string[] = [];
  const exec: SlotExecutor = (slot, prompt) => {
    calls.push(slot.label);
    return Promise.resolve({ ok: true, text: slot.label === 'Haiku' ? 'PASS' : `ran:${prompt}`, rawStdout: '', rawStderr: '', durationMs: 1 });
  };
  return { exec, calls };
};

describe('세션 조립 (D-056)', () => {
  it('주입한 실행기로 지휘자 직접 답을 돌린다', async () => {
    isolated();
    const { exec, calls } = fake();
    const { dir, id } = prepareSession('scratch', process.cwd());
    const session = assembleSession({ kind: 'scratch', dir, id, budget: restoreBudget(dir, id), journal: new Journal(), execute: exec });
    const out = await session.send('넌 누구니');
    assert.deepEqual(out.map((r) => r.kind), ['user', 'direct']);
    assert.equal(calls.length, 1, '지휘자 1회 — 분류 폴백은 돌지 않는다 (D-033)');
  });

  it('같은 세션의 Budget 을 기록의 spend 로 되살린다 (D-054)', async () => {
    isolated();
    const { exec } = fake();
    const { dir, id } = prepareSession('scratch', process.cwd());
    const budget = restoreBudget(dir, id);
    await assembleSession({ kind: 'scratch', dir, id, budget, journal: new Journal(), execute: exec }).send('넌 누구니');
    assert.equal(restoreBudget(dir, id).summary(), budget.summary());
  });
});
