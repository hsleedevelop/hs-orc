import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { assign } from '../assign.ts';
import { route } from '../pipeline.ts';
import { appendDecision, decisionLogPath, linesFor, newDecisionId, readDecisions } from '../decision-log.ts';
import { branchOf, decisionFor, firstLine, secondLine, sessionModel } from '../decide.ts';
import { reportError, reportNotice } from '../report.ts';
import { storeRun } from '../run-store.ts';

const matrix = loadMatrix();
const catalog = loadEngines();
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'hs-orc-'));
const row = (id: string) => matrix.assignments.find((a) => a.id === id)!;

describe('결정 로그 — 두 번 쓴다', () => {
  it('작업 1건이면 같은 id 의 줄이 정확히 2개다 (S6 완료 판정)', () => {
    const file = path.join(tmp(), 'log.jsonl');
    const plan = assign(matrix, catalog, row('R10'));
    const first = firstLine(matrix, plan, '아키텍처 설계 검토', '키워드');
    appendDecision(first, file);
    appendDecision(secondLine(first, 'unverified', '원시 로그 보존'), file);

    const lines = linesFor(first.id, file);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((l) => l.status), ['decided', 'ran']);
    assert.deepEqual(lines.map((l) => l.outcome), ['pending', 'unverified']);
  });

  it('2차는 갱신이 아니라 append 다 — 1차 줄이 그대로 남는다', () => {
    const file = path.join(tmp(), 'log.jsonl');
    const first = firstLine(matrix, assign(matrix, catalog, row('R01')), 't', 'r');
    appendDecision(first, file);
    appendDecision(secondLine(first, 'ok', 'exit 0'), file);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
    assert.equal(readDecisions(file)[0]?.outcome, 'pending');
  });

  it('검증 기록이 비면 그 사실을 남긴다 — "통과"로 채우지 않는다', () => {
    const first = firstLine(matrix, assign(matrix, catalog, row('R01')), 't', 'r');
    assert.equal(secondLine(first, 'unverified', '   ').verified, '(검증 기록 없음)');
  });

  it('두 슬롯 배정임을 로그에도 남긴다 (parallel_n=2, D-009)', () => {
    const first = firstLine(matrix, assign(matrix, catalog, row('R05')), 't', 'r');
    assert.equal(first.parallel_n, 2);
    assert.match(first.note ?? '', /reviewer fable/);
  });

  it('하한선에 걸린 결정은 기록 대상이 아니다 — 기본 경로는 안 남긴다 (SPEC §8)', () => {
    const direct = route(matrix, catalog, '이 아키텍처 설계 검토해줘', { gate: { irreversibleChange: true } });
    assert.equal(decisionFor(direct), null);
    assert.notEqual(decisionFor(route(matrix, catalog, '이 아키텍처 설계 검토해줘')), null);
  });

  it('깨진 줄이 섞여도 내 줄을 읽는다', () => {
    const file = path.join(tmp(), 'log.jsonl');
    const first = firstLine(matrix, assign(matrix, catalog, row('R01')), 't', 'r');
    appendDecision(first, file);
    assert.equal(readDecisions(file).length, 1);
  });

  it('같은 분에 두 번 결정해도 id 가 갈린다 — "id 당 2줄" 불변식을 지킨다', () => {
    const t = new Date(2026, 8, 20, 23, 32);
    const ids = new Set(Array.from({ length: 50 }, () => newDecisionId(t)));
    assert.ok(ids.size > 45, `같은 분에 id 가 뭉쳤다: ${ids.size}/50`);
    for (const id of ids) assert.match(id, /^0920-2332-/);
  });

  it('로그가 아직 없는 것은 정상이다 — 던지지 않는다', () => {
    assert.deepEqual(readDecisions(path.join(tmp(), 'none.jsonl')), []);
  });

  it('기본 경로는 머신 로컬이고 환경변수로 덮어쓸 수 있다', () => {
    assert.match(decisionLogPath({}), /\.claude\/logs\/delegation-router\.jsonl$/);
    assert.equal(decisionLogPath({ HS_ORC_DECISION_LOG: '/x/y.jsonl' }), '/x/y.jsonl');
    assert.match(newDecisionId(new Date(2026, 8, 20, 9, 5)), /^0920-0905-[0-9a-f]{3}$/);
  });
});

describe('다운시프트 판정은 AA 측정치로 한다', () => {
  it('벤더가 갈려도 비교된다 — Luna(37) < Fable(53) 이면 down', () => {
    assert.equal(branchOf(matrix, 'luna', 'fable'), 'down');
    assert.equal(branchOf(matrix, 'fable', 'fable'), 'keep');
    assert.equal(branchOf(matrix, 'fable', 'luna'), 'up_part');
  });

  it('세션 모델 기본값은 fable 이고 환경변수로 바꾼다', () => {
    assert.equal(sessionModel({}), 'fable');
    assert.equal(sessionModel({ HS_ORC_SESSION_MODEL: 'sonnet' }), 'sonnet');
  });

  it('R01 은 Fable 세션 기준 다운시프트다', () => {
    assert.equal(firstLine(matrix, assign(matrix, catalog, row('R01')), 't', 'r').downshifted, true);
  });
});

describe('에러 리포팅', () => {
  it('태그와 모듈 출처를 붙인다', () => {
    const r = reportError('adapters', 'spawn', new Error('boom'));
    assert.equal(r.severity, 'error');
    assert.equal(r.display, '[error][adapters/spawn] boom');
  });

  it('정상 비즈니스 상태는 에러로 올리지 않는다', () => {
    for (const tag of ['unclassified', 'gate-direct', 'budget-exceeded', 'max-iterations']) {
      assert.equal(reportError('pipeline', tag, new Error('x')).severity, 'notice', tag);
    }
  });

  it('사용자에게 보여줄 한 줄을 반환한다 — catch 후 무동작을 막는다', () => {
    assert.match(reportNotice('m', 't', '메시지').display, /\[notice\]\[m\/t\] 메시지/);
  });
});

describe('원시 로그 보존', () => {
  it('실행별로 stdout·stderr·meta 를 남긴다', () => {
    const root = tmp();
    const stored = storeRun('0920-0905', 1, 'Luna·medium', {
      rawStdout: 'OUT', rawStderr: 'ERR', meta: { outcome: 'ok' },
    }, root);
    assert.equal(stored.files.length, 3);
    assert.equal(readFileSync(path.join(stored.dir, stored.files[0]!), 'utf8'), 'OUT');
    assert.equal(readFileSync(path.join(stored.dir, stored.files[1]!), 'utf8'), 'ERR');
    assert.match(readFileSync(path.join(stored.dir, stored.files[2]!), 'utf8'), /"outcome": "ok"/);
  });
});
