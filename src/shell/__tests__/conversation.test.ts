/**
 * 세션 조립 (D-056) — GUI·CLI 가 같은 조립을 쓴다. 실행기는 가짜다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SlotExecutor } from '../../core/executor.ts';
import { gitEnv } from '../../core/git-env.ts';
import { Journal } from '../../core/journal.ts';
import { appendRecord, prepareSession, transcriptPath } from '../../core/transcript.ts';
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
    const session = assembleSession({ approvalMode: 'manual', kind: 'scratch', dir, id, budget: restoreBudget(dir, id), journal: new Journal(), execute: exec });
    const out = await session.send('넌 누구니');
    assert.deepEqual(out.map((r) => r.kind), ['user', 'direct']);
    assert.equal(calls.length, 1, '지휘자 1회 — 분류 폴백은 돌지 않는다 (D-033)');
  });

  it('폴더가 git 인지 조립이 정해 넘긴다 — git 아닌 폴더의 codex 쓰기 카드에만 H4 (D-074)', async () => {
    isolated();
    const { exec } = fake();
    const h4 = async (dir: string): Promise<boolean> => {
      const { id } = prepareSession('project', dir);
      const session = assembleSession({ approvalMode: 'auto-ask', kind: 'project', dir, id, budget: restoreBudget(dir, id), journal: new Journal(), execute: exec });
      const plan = (await session.send('이 타입 에러 고쳐줘', { write: true })).find((r) => r.kind === 'plan');
      return plan?.kind === 'plan' && (plan.asked ?? []).some((a) => a.code === 'H4');
    };
    const empty = mkdtempSync(path.join(os.tmpdir(), 'hs-conv-empty-'));
    assert.equal(await h4(empty), true);
    const repo = mkdtempSync(path.join(os.tmpdir(), 'hs-conv-git-'));
    spawnSync('git', ['init', '-q'], { cwd: repo, env: gitEnv() });
    assert.equal(await h4(repo), false);
  });

  it('같은 세션의 Budget 을 기록의 spend 로 되살린다 (D-054)', async () => {
    isolated();
    const { exec } = fake();
    const { dir, id } = prepareSession('scratch', process.cwd());
    const budget = restoreBudget(dir, id);
    await assembleSession({ approvalMode: 'manual', kind: 'scratch', dir, id, budget, journal: new Journal(), execute: exec }).send('넌 누구니');
    assert.equal(restoreBudget(dir, id).summary(), budget.summary());
  });

  it('기록의 spend 재생에 캐시 읽기 누계가 되살아난다 — 옛 줄은 내역 없음 (D-070)', () => {
    isolated();
    const { dir, id } = prepareSession('scratch', process.cwd());
    const file = transcriptPath(dir, id);
    const at = { v: 1 as const, at: '2026-10-01T00:00:00.000Z', turn: 1 };
    appendRecord(file, { ...at, kind: 'spend', charges: [], tokens: 120000, unreported: 0 });
    appendRecord(file, { ...at, turn: 2, kind: 'spend', charges: [], tokens: 1060322, unreported: 0, cacheReadTokens: 943872 });
    const budget = restoreBudget(dir, id);
    assert.equal(budget.spentTokens, 1180322);
    assert.match(budget.summary(), /\(캐시 읽기 943872 · 그 외 116450 · 내역 없음 120000\)/);
  });
});
