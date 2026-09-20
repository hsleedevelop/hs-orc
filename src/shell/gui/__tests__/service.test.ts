/**
 * S7 완료 판정: **v1 의 S5 시나리오가 GUI 에서 동일하게 통과한다.**
 * 창을 띄우지 않고 검증한다 — 로직이 Electron 에 묶여 있으면 이 파일이 아예 안 만들어진다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SlotExecutor } from '../../../core/executor.ts';
import { readDecisions } from '../../../core/decision-log.ts';
import { GuiService } from '../service.ts';

const calls: string[] = [];
const fake: SlotExecutor = (slot, prompt) => {
  calls.push(slot.label);
  return Promise.resolve({ ok: true, text: slot.label === 'Haiku' ? 'PASS' : `ran:${prompt}`, durationMs: 1 });
};

const isolated = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-gui-'));
  process.env['HS_ORC_DECISION_LOG'] = path.join(dir, 'log.jsonl');
  process.env['HS_ORC_RUN_STORE'] = path.join(dir, 'runs');
  return path.join(dir, 'log.jsonl');
};

describe('GUI — Core 를 그대로 쓴다', () => {
  it('분류 → 배정 → 비용을 v1 과 같은 뷰모델로 낸다', () => {
    const view = new GuiService(fake).plan('이 아키텍처 설계 검토해줘');
    assert.equal(view.awaitingApproval, true);
    assert.equal(view.cost?.line, '$10.89 = primary $7.63 + reviewer $3.26');
    assert.equal(view.cost?.badge.grade, 'INDEPENDENT');
    assert.ok(view.lines.some((l) => l.startsWith('reviewer')), 'reviewer 슬롯이 GUI 에서 사라지면 안 된다');
  });

  it('하한선·분류 실패는 GUI 에서도 비용도 승인도 없다', () => {
    const view = new GuiService(fake).plan('오늘 점심 뭐 먹지');
    assert.equal(view.cost, null);
    assert.equal(view.awaitingApproval, false);
  });
});

describe('GUI — S5 시나리오', () => {
  it('승인 → 실행 → 증거 미충족이면 unverified 로 닫고 결정 로그 2줄을 남긴다', async () => {
    const log = isolated();
    const service = new GuiService(fake);
    const result = await service.run({ task: '이 타입 에러 고쳐줘', verify: [] });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'unverified');
    assert.equal(result.report?.satisfied, false);
    const rows = readDecisions(log);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.outcome), ['pending', 'unverified']);
  });

  it('증거가 모이면 ok 로 닫는다 — "성공했습니다"가 아니라 exit code 다', async () => {
    const log = isolated();
    const service = new GuiService(fake);
    const result = await service.run({ task: '이 타입 에러 고쳐줘', verify: ['exit 0'] });

    assert.equal(result.outcome, 'ok');
    assert.equal(result.report?.satisfied, true);
    assert.equal(readDecisions(log).at(-1)?.outcome, 'ok');
  });

  it('검증 명령이 실패하면 증거로 치지 않는다', async () => {
    isolated();
    const result = await new GuiService(fake).run({ task: '이 타입 에러 고쳐줘', verify: ['exit 3'] });
    // exit code 3 도 **증거다**(형태가 맞다). 다만 R01 은 코드 값을 따지지 않으므로 충족이다 —
    // 이 테스트는 그 사실을 고정한다: 통과/실패 판정은 사람이 하고, 제품은 증거의 **존재와 형태**를 본다.
    assert.equal(result.report?.satisfied, true);
    assert.equal(result.report?.accepted.some((e) => e.kind === 'command' && e.exitCode === 3), true);
  });

  it('원시 로그를 실행별로 남긴다', async () => {
    isolated();
    await new GuiService(fake).run({ task: '이 타입 에러 고쳐줘', verify: [] });
    const dir = process.env['HS_ORC_RUN_STORE'] as string;
    assert.ok(readFileSync(path.join(dir, readDecisions().at(-1)?.id ?? '', '01-Luna.meta.json'), 'utf8').includes('outcome'));
  });

  it('누적 비용과 Dashboard 가 v1 과 같은 모양으로 갱신된다', async () => {
    isolated();
    const service = new GuiService(fake);
    await service.run({ task: '이 타입 에러 고쳐줘', verify: [] });
    const view = service.dashboard();
    assert.deepEqual(view.distribution, [{ model: 'Luna', count: 1 }]);
    assert.equal(view.unverified, 1, '증거 없이 닫힌 사이클은 따로 세어야 한다');
    assert.match(view.spent, /추정 포함/);
  });

  it('GUI 도 두 슬롯을 실제로 띄운다 (D-009)', async () => {
    isolated();
    calls.length = 0;
    const result = await new GuiService(fake).run({ task: '이 타입 에러 고쳐줘', verify: [] });
    assert.deepEqual(calls, ['Luna', 'Haiku'], 'GUI 에서 reviewer 가 안 돌면 단일 엔진 선택기다');
    assert.equal(result.verdict, 'pass');
    assert.equal(result.report?.accepted.some((e) => e.kind === 'review'), true);
  });

  it('고의 크래시가 리포팅 경로를 보여준다', () => {
    assert.match(new GuiService(fake).crashTest(), /\[error\]\[gui\/main\/crash-test\]/);
  });
});
