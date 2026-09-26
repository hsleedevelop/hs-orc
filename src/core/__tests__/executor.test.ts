import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { assign } from '../assign.ts';
import { Budget } from '../budget.ts';
import { createExecutor, sinceBaseline, type SlotRun } from '../executor.ts';

/**
 * 쓰기 권한 부여 지점은 `createExecutor` **한 곳**이고, 거기서 reviewer 가 구조적으로 배제된다 (D-025).
 * 판정 대상을 스스로 고칠 수 있는 reviewer 는 독립 검증자가 아니다 — 그래서 argv 를
 * **실제로 받은 프로세스**에서 읽어 증명한다. 어댑터 내부를 흉내내면 배선이 끊겨도 초록이 뜬다.
 *
 * 가짜 바이너리를 PATH 앞에 둔다. 진짜 엔진을 띄우지 않으므로 돈이 들지 않는다.
 */
const catalog = loadEngines();
const matrix = loadMatrix();
const row = matrix.assignments.find((a) => a.id === 'R01');
if (!row) throw new Error('R01 이 매트릭스에 없다.');
const plan = assign(matrix, catalog, row);

const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'hs-orc-fakebin-'));
const originalPath = process.env['PATH'] ?? '';

/** 받은 argv 를 파일로 남기고 곧바로 끝나는 가짜 엔진. */
function installFake(name: string): void {
  const file = path.join(fakeDir, name);
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@" > "${file}.argv"\nexit 0\n`, 'utf8');
  chmodSync(file, 0o755);
}

const argvOf = (name: string): string => readFileSync(path.join(fakeDir, `${name}.argv`), 'utf8');

before(() => {
  installFake('codex');
  installFake('claude');
  process.env['PATH'] = `${fakeDir}${path.delimiter}${originalPath}`;
});

after(() => {
  process.env['PATH'] = originalPath;
  rmSync(fakeDir, { recursive: true, force: true });
});

describe('쓰기 권한은 primary 슬롯만 받는다 (D-025)', () => {
  it('--write 를 켜도 reviewer 는 읽기 전용이다', async () => {
    const execute = createExecutor(catalog, fakeDir, 10_000, { write: true });
    await execute(plan.slots.primary, 'P');
    await execute(plan.slots.reviewer, 'R');

    assert.equal(plan.slots.primary.engine, 'codex');
    assert.match(argvOf('codex'), /workspace-write/);
    assert.equal(plan.slots.reviewer.engine, 'claude');
    assert.doesNotMatch(
      argvOf('claude'),
      /acceptEdits/,
      'reviewer 가 쓰기를 받았다 — 판정 대상을 스스로 고칠 수 있으면 독립 검증이 아니다.',
    );
  });

  it('옵션이 없으면 두 슬롯 다 읽기 전용이다 — 외부 쓰기는 옵트인이다', async () => {
    const execute = createExecutor(catalog, fakeDir, 10_000);
    await execute(plan.slots.primary, 'P');
    await execute(plan.slots.reviewer, 'R');
    assert.doesNotMatch(argvOf('codex'), /workspace-write/);
    assert.doesNotMatch(argvOf('claude'), /acceptEdits/);
  });
});

/**
 * SPEC §3.7 — 파싱 실패가 **원본 손실로 이어지지 않는다.**
 *
 * 어댑터는 원래부터 raw 를 보존했지만 `SlotRun` 에 그 자리가 없어 executor 경계에서 버려졌고,
 * 셸은 남은 `text` 를 "원시 로그" 라는 이름으로 디스크에 썼다. codex·cursor 의 토큰 보고가
 * 통째로 사라진 이유가 그것이다(2026-09-22 첫 실사용). 이 테스트가 그 경계를 고정한다.
 */
describe('원시 출력은 파싱과 무관하게 보존된다 (SPEC §3.7)', () => {
  const garbage = '{ 이건 JSON 이 아니다\n또 한 줄';

  it('파싱이 통째로 실패해도 stdout 원본이 그대로 올라온다', async () => {
    const file = path.join(fakeDir, 'claude');
    writeFileSync(file, `#!/bin/sh\nprintf '%s' '${garbage}'\nprintf '%s' 'stderr 한 줄' >&2\nexit 0\n`, 'utf8');
    chmodSync(file, 0o755);

    const run = await createExecutor(catalog, fakeDir, 10_000)(plan.slots.reviewer, 'R');
    assert.equal(run.text, '', '파싱된 텍스트는 비어야 한다 — 그래야 이 테스트가 raw 를 보는 것이다');
    assert.equal(run.rawStdout, garbage, 'text 가 아니라 **원본**이 보존돼야 한다');
    assert.equal(run.rawStderr, 'stderr 한 줄');
  });

  it('정상 응답에서도 raw 는 파싱 결과가 아니라 원본이다 — 토큰 보고가 여기 실려 온다', async () => {
    const line = JSON.stringify({ type: 'result', is_error: false, result: 'ok', usage: { input_tokens: 11, output_tokens: 5 } });
    const file = path.join(fakeDir, 'claude');
    writeFileSync(file, `#!/bin/sh\ncat <<'JSONL'\n${line}\nJSONL\n`, 'utf8');
    chmodSync(file, 0o755);

    const run = await createExecutor(catalog, fakeDir, 10_000)(plan.slots.reviewer, 'R');
    assert.equal(run.text, 'ok');
    assert.match(run.rawStdout, /input_tokens/, '사용량이 raw 에 없으면 단가 선언(D-027)이 소급 계산될 수 없다');
    assert.notEqual(run.rawStdout, run.text);
  });
});

describe('resume 한 실행의 누적 보고는 직전 보고를 빼서 센다 (D-057)', () => {
  // 수치는 2026-09-26 실측 원본이다 (DECISIONS D-031 Q10 후속).
  it('claude 는 total_cost_usd 가 누적이다 — 금액만 빼고 토큰은 그대로 둔다', async () => {
    const line = JSON.stringify({ type: 'result', is_error: false, result: 'ORC', session_id: 'S1', total_cost_usd: 0.0938752, usage: { input_tokens: 10, output_tokens: 105, cache_read_input_tokens: 43642, cache_creation_input_tokens: 671 } });
    const file = path.join(fakeDir, 'claude');
    writeFileSync(file, `#!/bin/sh\ncat <<'JSONL'\n${line}\nJSONL\n`, 'utf8');
    chmodSync(file, 0o755);

    const run = await createExecutor(catalog, fakeDir, 10_000)(plan.slots.reviewer, 'R', { resume: 'S1', baseline: { costUsd: 0.087634 } });
    assert.ok(Math.abs((run.actualUsd ?? 0) - 0.0062412) < 1e-9, `이번 몫만 센다: ${run.actualUsd}`);
    assert.equal(run.usage?.cachedInputTokens, 43642, '기준에 토큰이 없으면 토큰은 원본을 센다 (D-060 이전 기록)');
    assert.equal(run.reported?.costUsd, 0.0938752, '다음 resume 의 기준은 원본이다');
  });

  it('codex 는 turn.completed.usage 가 누적이다 — 네 칸을 빼서 이번 턴 몫이 된다', async () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 'T1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ORC' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 103616, cached_input_tokens: 50688, output_tokens: 40 } }),
    ].join('\n');
    const file = path.join(fakeDir, 'codex');
    writeFileSync(file, `#!/bin/sh\ncat <<'JSONL'\n${lines}\nJSONL\n`, 'utf8');
    chmodSync(file, 0o755);

    const baseline = { usage: { inputTokens: 29147, outputTokens: 7, cachedInputTokens: 11008, cacheWriteTokens: 0 } };
    const run = await createExecutor(catalog, fakeDir, 10_000)(plan.slots.primary, 'P', { resume: 'T1', baseline });
    // 세션 로그의 last_token_usage (input 63,461 · cached 39,680 · output 33) 와 같아야 한다.
    assert.deepEqual(run.usage, { inputTokens: 63461 - 39680, outputTokens: 33, cachedInputTokens: 39680, cacheWriteTokens: 0 });
    assert.equal(run.reported?.usage?.cachedInputTokens, 50688);
  });

  it('기준이 없거나 빼서 음수가 되면 원본을 센다 — 적게 세면 상한이 거짓이 된다', () => {
    const raw = { costUsd: 0.05, usage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0 } };
    assert.deepEqual(sinceBaseline(raw, undefined, ['cost', 'usage']), raw);
    assert.deepEqual(sinceBaseline(raw, { costUsd: 0.08, usage: { ...raw.usage, inputTokens: 20 } }, ['cost', 'usage']), raw);
    assert.deepEqual(sinceBaseline(raw, { costUsd: 0.01 }, []), raw, '선언이 없는 엔진(cursor)은 빼지 않는다');
  });
});

describe('압축 몫은 modelUsage 누적 차분으로 센다 — 두 번 세지 않는다 (D-060)', () => {
  // 2026-09-26 Q17 실측 원본을 가짜 claude 가 그대로 흘린다.
  const fixture = (name: string): string => fileURLToPath(new URL(`../../adapters/__tests__/fixtures/${name}`, import.meta.url));
  const replay = (name: string): void => {
    const file = path.join(fakeDir, 'claude');
    writeFileSync(file, `#!/bin/sh\ncat '${fixture(name)}'\n`, 'utf8');
    chmodSync(file, 0o755);
  };
  const total = (u: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteTokens: number } | undefined): number =>
    u ? u.inputTokens + u.outputTokens + u.cachedInputTokens + u.cacheWriteTokens : NaN;

  it('1턴 → /compact resume: 두 번째 실행은 압축 몫(차분)만, Budget 합은 세션 누적과 같다', async () => {
    const execute = createExecutor(catalog, fakeDir, 10_000);
    replay('claude-q17-turn1.jsonl');
    const first = await execute(plan.slots.reviewer, 'P');
    replay('claude-q17-compact.jsonl');
    const second = await execute(plan.slots.reviewer, '/compact', { resume: first.sessionId ?? '', ...(first.reported ? { baseline: first.reported } : {}) });

    // result.usage 는 0 이었다 — 차분이 압축 실행의 토큰이다. 캐시 읽기+쓰기 20,542 ≈ pre_tokens 20,546.
    assert.deepEqual(second.usage, { inputTokens: 1436, outputTokens: 1038, cachedInputTokens: 20143, cacheWriteTokens: 399 });
    assert.ok(Math.abs((second.actualUsd ?? 0) - 0.00913905) < 1e-9, `금액도 차분이다: ${second.actualUsd}`);
    assert.deepEqual(second.compactions, [{ trigger: 'manual', preTokens: 20546, postTokens: 1362 }]);
    assert.equal(second.compactionUncounted, undefined, 'claude 는 압축 몫이 이미 들어 있다');

    const budget = new Budget(100, 2_000_000);
    budget.countTokens(first.usage, first.compactionUncounted);
    budget.countTokens(second.usage, second.compactionUncounted);
    // 1턴을 다시 세거나(21,485 더) 압축 이벤트의 pre_tokens(20,546)를 또 더하면 이 값을 넘는다.
    assert.equal(budget.spentTokens, total(second.reported?.usage));
    assert.equal(budget.spentTokens, 44501);
    assert.doesNotMatch(budget.summary(), /압축 토큰을 보고하지 않는/);
  });

  /**
   * 2026-09-26 실엔진 검증 원본 (claude 2.1.283 · Haiku low): 한 세션을 orc 실행기로 다섯 번 이었다 —
   * 1턴 · resume 3번 · 임계값을 낮춘 자동 압축 resume 1번(chain-5).
   */
  const chain = async (): Promise<SlotRun[]> => {
    const execute = createExecutor(catalog, fakeDir, 10_000);
    const runs: SlotRun[] = [];
    for (let i = 1; i <= 5; i += 1) {
      replay(`claude-d060-chain-${i}.jsonl`);
      const prev = runs.at(-1);
      runs.push(await execute(plan.slots.reviewer, 'P', prev ? { resume: prev.sessionId ?? '', ...(prev.reported ? { baseline: prev.reported } : {}) } : undefined));
    }
    return runs;
  };

  it('resume 체인: 턴별로 매긴 토큰·금액의 합이 마지막 result 의 세션 누적과 같다', async () => {
    const runs = await chain();
    // 압축 없는 resume 은 그 턴의 result.usage 그대로다 — 앞 턴을 다시 세지 않는다.
    assert.deepEqual(runs[1]?.usage, { inputTokens: 10, outputTokens: 95, cachedInputTokens: 20110, cacheWriteTokens: 122 });
    assert.deepEqual(runs[3]?.usage, { inputTokens: 10, outputTokens: 45, cachedInputTokens: 20379, cacheWriteTokens: 125 });

    const budget = new Budget(100, 2_000_000);
    for (const run of runs) {
      budget.charge('Haiku·low', run.actualUsd, 0, run.meteredUsd, plan.slots.reviewer.plan);
      budget.countTokens(run.usage, run.compactionUncounted);
    }
    const last = runs.at(-1)?.reported;
    assert.equal(budget.spentTokens, total(last?.usage));
    assert.equal(budget.spentTokens, 124098);
    assert.equal(budget.spentUsd, Number((last?.costUsd ?? NaN).toFixed(6)), '금액은 total_cost_usd 누적 $0.0384377');
  });

  it('자동 압축(trigger: auto) resume 도 압축 몫이 modelUsage 차분에 든다', async () => {
    const compacted = (await chain())[4];
    assert.deepEqual(compacted?.compactions, [{ trigger: 'auto', preTokens: 20597, postTokens: 912 }]);
    // result.usage 는 본 답변 몫(10·70·16,950·1,792)뿐이다. 차분에는 압축 호출 몫(1,481·864·20,379·78)이 더 들고,
    // 그 캐시 읽기 20,379 는 직전 턴 맥락이다 (pre_tokens 20,597 = 직전 턴 합 20,559 + 새 메시지).
    assert.deepEqual(compacted?.usage, { inputTokens: 1491, outputTokens: 934, cachedInputTokens: 37329, cacheWriteTokens: 1870 });
    assert.ok(Math.abs((compacted?.actualUsd ?? 0) - 0.0135754) < 1e-9, `금액도 차분이다: ${compacted?.actualUsd}`);
  });

  it('codex 실행은 압축 몫이 빠질 수 있다고 표시된다 — 보정하지 않는다', async () => {
    const file = path.join(fakeDir, 'codex');
    const line = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 40419, cached_input_tokens: 0, output_tokens: 10 } });
    writeFileSync(file, `#!/bin/sh\ncat <<'JSONL'\n${line}\nJSONL\n`, 'utf8');
    chmodSync(file, 0o755);

    const run = await createExecutor(catalog, fakeDir, 10_000)(plan.slots.primary, 'P');
    assert.equal(run.compactionUncounted, true);
    const budget = new Budget(100, 2_000_000);
    budget.countTokens(run.usage, run.compactionUncounted);
    assert.equal(budget.spentTokens, 40429, '보고된 토큰만 센다 — 추정치를 더하지 않는다');
    assert.match(budget.summary(), /압축 토큰을 보고하지 않는 엔진 1회/);
  });

  it('cursor 는 선언하지 않는다 — 압축 실측이 없다 (결정 4)', () => {
    assert.equal(catalog.engines.cursor.compactionUncounted, undefined);
  });
});
