import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMatrix } from '../../../data/matrix.ts';
import { loadEngines } from '../../../data/engines.ts';
import { route } from '../../../core/pipeline.ts';
import { Budget } from '../../../core/budget.ts';
import { Journal } from '../../../core/journal.ts';
import { SCREENS, dashboardView, runView, titleInfo } from '../model.ts';

const matrix = loadMatrix();
const catalog = loadEngines();

describe('화면 타이틀', () => {
  it('환경과 버전을 담는다 (SPEC §7)', () => {
    const t = titleInfo('Run');
    assert.match(t.text, /hs-orchestrator Run · .+ · v\d+\.\d+\.\d+/);
    assert.ok(t.env.length > 0);
  });

  it('디버그 화면은 프로덕션에서도 목록에 있다', () => {
    assert.ok(SCREENS.includes('Debug'));
    assert.equal(SCREENS.length, 6);
  });
});

describe('Run 화면', () => {
  it('비용을 승인 **전에** 보여주고 측정치임을 함께 표기한다', () => {
    const view = runView(route(matrix, catalog, '이 아키텍처 설계 검토해줘'), '이 아키텍처 설계 검토해줘');
    assert.equal(view.awaitingApproval, true);
    assert.equal(view.cost?.line, '$10.89 = primary $7.63 + reviewer $3.26');
    assert.equal(view.cost?.badge.grade, 'INDEPENDENT');
    assert.match(view.cost?.disclaimer ?? '', /실제 지출이 아니다/);
  });

  it('primary 와 reviewer 를 둘 다 보여준다 — 단일 엔진 선택기가 아니다', () => {
    const view = runView(route(matrix, catalog, '이 아키텍처 설계 검토해줘'), 'x');
    assert.ok(view.lines.some((l) => l.startsWith('primary')));
    assert.ok(view.lines.some((l) => l.startsWith('reviewer')));
  });

  it('하한선에 걸리면 비용도 승인도 없다', () => {
    const view = runView(route(matrix, catalog, '이 아키텍처 설계 검토해줘', { gate: { irreversibleChange: true } }), 'x');
    assert.equal(view.cost, null);
    assert.equal(view.awaitingApproval, false);
    assert.match(view.lines[0] ?? '', /하한선/);
  });

  it('분류 실패는 임의 배정 없이 그대로 보여준다', () => {
    const view = runView(route(matrix, catalog, '오늘 점심 뭐 먹지'), 'x');
    assert.equal(view.cost, null);
    assert.match(view.lines[0] ?? '', /해당 없음/);
  });
});

describe('Dashboard 화면', () => {
  it('검증 기록이 빈 사이클을 따로 센다 — "통과"로 세지 않는다', () => {
    const journal = new Journal();
    journal.append({ index: 1, unit: '턴', model: 'Luna', effort: 'medium', outcome: 'ok', evidence: 'e', change: 'c', verification: '' });
    journal.append({ index: 2, unit: '턴', model: 'Luna', effort: 'medium', outcome: 'ok', evidence: 'e', change: 'c', verification: 'exit 0' });
    const view = dashboardView(journal, new Budget(20));
    assert.equal(view.unverified, 1);
    assert.deepEqual(view.distribution, [{ model: 'Luna', count: 2 }]);
  });

  it('추정 비용이 섞이면 누적 표시에 드러난다', () => {
    const budget = new Budget(20);
    budget.charge('x', undefined, 1.5);
    assert.match(dashboardView(new Journal(), budget).spent, /추정 포함/);
  });
});
