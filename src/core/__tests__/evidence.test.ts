import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMatrix } from '../../data/matrix.ts';
import { REQUIREMENTS, collect, validate, type Evidence } from '../evidence.ts';
import { changedFiles, runCommand } from '../evidence-gather.ts';

const matrix = loadMatrix();
const row = (id: string) => matrix.assignments.find((a) => a.id === id)!;
const cmd = (c: string, exitCode: number, phase?: string): Evidence => ({
  kind: 'command', cmd: c, exitCode, output: 'o', ...(phase ? { phase } : {}),
});

describe('요구 증거 표', () => {
  it('11행 전부에 증거 요구가 있다 — 빈 행은 "무조건 완료"가 된다', () => {
    for (const a of matrix.assignments) {
      assert.ok((REQUIREMENTS[a.id] ?? []).length > 0, `${a.id} 에 증거 요구가 없다`);
    }
    assert.equal(Object.keys(REQUIREMENTS).length, 11);
  });

  it('증거 요구가 없는 행은 충족으로 치지 않는다', () => {
    const fake = { ...row('R01'), id: 'R99' };
    assert.equal(collect(fake, [cmd('x', 0)]).satisfied, false);
  });
});

describe('"성공했습니다"는 증거가 아니다', () => {
  it('exit code 없는 명령은 거절한다', () => {
    const bad = { kind: 'command', cmd: 'npm test', exitCode: NaN, output: '전부 통과했습니다' } as unknown as Evidence;
    assert.match(validate(bad) ?? '', /exit code/);
    const r = collect(row('R01'), [bad]);
    assert.equal(r.satisfied, false);
    assert.equal(r.rejected.length, 1);
  });

  it('인용은 file:line 형태여야 한다', () => {
    assert.equal(validate({ kind: 'citation', ref: 'src/a.ts:42', quote: 'q' }), null);
    assert.match(validate({ kind: 'citation', ref: '코드를 확인했습니다', quote: 'q' }) ?? '', /file:line/);
  });

  it('측정값은 환경 표기가 있어야 한다 — 다른 환경의 값은 비교할 수 없다', () => {
    assert.match(validate({ kind: 'measurement', label: 'p95', value: 12, env: '  ' }) ?? '', /측정 환경/);
  });

  it('절 내용이 사실상 비면 거절한다', () => {
    assert.match(validate({ kind: 'document-section', name: '대안', text: 'ok' }) ?? '', /사실상 비었다/);
  });

  it('시그널로 죽은 명령은 exit code -1 로 남아 "성공"으로 읽히지 않는다', () => {
    const e = runCommand('kill -9 $$', process.cwd());
    assert.equal(e.kind === 'command' && e.exitCode !== 0, true);
  });
});

describe('행별 충족 판정', () => {
  it('R01 은 test 실행 결과 하나로 닫힌다', () => {
    assert.equal(collect(row('R01'), [cmd('npm test', 0)]).satisfied, true);
    assert.equal(collect(row('R01'), []).satisfied, false);
  });

  it('R05 는 수정 전/후 두 단계가 다 있어야 한다', () => {
    const only = collect(row('R05'), [cmd('t', 1, 'before'), cmd('t', 0, 'before')]);
    assert.equal(only.satisfied, false);
    assert.match(only.missing.join(), /빠진 단계: after/);
    assert.equal(collect(row('R05'), [cmd('t', 1, 'before'), cmd('t', 0, 'after')]).satisfied, true);
  });

  it('R06 은 재현→수정→회귀 3단계를 요구한다', () => {
    const r = collect(row('R06'), [cmd('t', 1, 'reproduce'), cmd('t', 0, 'fix'), cmd('t', 0, 'regress')]);
    assert.equal(r.satisfied, true);
    assert.equal(collect(row('R06'), [cmd('t', 1, 'reproduce'), cmd('t', 0, 'fix')]).satisfied, false);
  });

  it('R07 은 같은 환경 3점 측정을 요구한다', () => {
    const m = (label: string, value: number): Evidence => ({ kind: 'measurement', label, value, env: 'm1-local' });
    assert.equal(collect(row('R07'), [m('base', 10), m('after', 8)]).satisfied, false);
    assert.equal(collect(row('R07'), [m('base', 10), m('after', 8), m('remeasure', 8.1)]).satisfied, true);
  });

  it('R10 은 대안·제약·실행계획 세 절이 분리돼야 한다', () => {
    const sec = (name: string): Evidence => ({ kind: 'document-section', name, text: '내용이 충분히 길다' });
    const missing = collect(row('R10'), [sec('대안'), sec('제약'), sec('요약')]);
    assert.equal(missing.satisfied, false);
    assert.match(missing.missing.join(), /빠진 절: 실행계획/);
    assert.equal(collect(row('R10'), [sec('대안'), sec('제약'), sec('실행계획')]).satisfied, true);
  });

  it('R11 은 독립 리뷰 + 실제 검사를 둘 다 요구한다', () => {
    const review: Evidence = { kind: 'review', reviewer: 'Fable', verdict: 'pass', text: 'ok' };
    assert.equal(collect(row('R11'), [review]).satisfied, false);
    assert.equal(collect(row('R11'), [review, cmd('deploy-check', 0)]).satisfied, true);
  });

  it('R03 은 acceptance test 가 구현보다 앞이어야 한다', () => {
    const order = (a: string, b: string): Evidence => ({
      kind: 'ordering', earlierLabel: 'acceptance test', earlier: a, laterLabel: '구현 시작', later: b,
    });
    assert.equal(collect(row('R03'), [order('2026-09-20T01:00:00Z', '2026-09-20T02:00:00Z')]).satisfied, true);
    assert.equal(collect(row('R03'), [order('2026-09-20T03:00:00Z', '2026-09-20T02:00:00Z')]).satisfied, false);
  });
});

describe('기계적 수집', () => {
  it('명령을 실제로 돌려 exit code 를 받는다', () => {
    assert.deepEqual(
      [runCommand('exit 0'), runCommand('exit 7')].map((e) => (e.kind === 'command' ? e.exitCode : null)),
      [0, 7],
    );
  });

  it('변경 파일은 git 이 진실이다 — 모델이 말한 목록을 믿지 않는다', () => {
    const e = changedFiles();
    assert.equal(e.kind, 'changed-files');
  });
});
