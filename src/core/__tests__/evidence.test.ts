import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMatrix } from '../../data/matrix.ts';
import { REQUIREMENTS, collect, outcomeOf, validate, type Evidence } from '../evidence.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changedFiles, runCommand, snapshotTests, testChanges } from '../evidence-gather.ts';

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

describe('나쁜 결과의 증거는 완료가 아니다 (D-043)', () => {
  const review = (verdict: 'pass' | 'fail'): Evidence => ({ kind: 'review', reviewer: 'Haiku·low', verdict, text: 't' });

  it('phase 없는 명령이 실패하면 rework 다 — "실행했다" 는 "통과했다" 가 아니다', () => {
    const red = collect(row('R01'), [cmd('npm test', 1)]);
    assert.equal(red.satisfied, true, '모양은 맞는 증거다 — 거절하지 않는다.');
    assert.deepEqual(red.contradictions, ['`npm test` exit=1']);
    assert.equal(outcomeOf(true, red), 'rework');
    assert.equal(outcomeOf(true, collect(row('R01'), [cmd('npm test', 0)])), 'ok');
  });

  it('before·reproduce 는 실패가 정상이고, 통과하면 오히려 rework 다', () => {
    assert.equal(outcomeOf(true, collect(row('R05'), [cmd('t', 1, 'before'), cmd('t', 0, 'after')])), 'ok');
    const noRepro = collect(row('R05'), [cmd('t', 0, 'before'), cmd('t', 0, 'after')]);
    assert.deepEqual(noRepro.contradictions, ['`before:t` 는 실패해야 하는 단계인데 exit 0']);
    assert.equal(outcomeOf(true, collect(row('R06'), [cmd('t', 1, 'reproduce'), cmd('t', 0, 'fix'), cmd('t', 1, 'regress')])), 'rework');
  });

  it('reviewer FAIL 은 증거가 모였어도 rework 다 — PASS 는 판정을 바꾸지 않는다', () => {
    assert.equal(outcomeOf(true, collect(row('R01'), [cmd('npm test', 0), review('fail')])), 'rework');
    assert.equal(outcomeOf(true, collect(row('R01'), [cmd('npm test', 0), review('pass')])), 'ok');
    assert.equal(outcomeOf(true, collect(row('R11'), [review('fail'), cmd('npm test', 0)])), 'rework');
  });

  it('순서: 실행 실패 → 나쁜 결과 → 증거 충족 — 증거가 없으면 unverified', () => {
    assert.equal(outcomeOf(false, collect(row('R01'), [cmd('npm test', 1)])), 'wrong');
    assert.equal(outcomeOf(true, collect(row('R01'), [])), 'unverified');
    assert.equal(outcomeOf(true, collect(row('R10'), [review('fail')])), 'rework', '요구가 덜 모였어도 나쁜 결과가 먼저다.');
  });
});

describe('돌지 못한 명령 (D-046)', () => {
  it('126·127·-1 은 phase 와 무관하게 나쁜 결과다 — before 의 127 을 재현으로 읽지 않는다', () => {
    const missing = collect(row('R05'), [cmd('no_such_cmd', 127, 'before'), cmd('t', 0, 'after')]);
    assert.match(missing.contradictions[0] ?? '', /`before:no_such_cmd` 가 실행되지 못했다 \(exit 127/);
    assert.equal(outcomeOf(true, missing), 'rework');
    assert.match(collect(row('R01'), [cmd('slow', -1)]).contradictions[0] ?? '', /시그널·시간 초과/);
  });
});

describe('기존 테스트 약화 (D-047)', () => {
  it('줄 추가·새 파일은 허용, 줄 변경·삭제·파일 삭제는 약화다 — 약화면 rework', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-tests-'));
    mkdirSync(path.join(dir, 't'));
    const put = (f: string, s: string) => writeFileSync(path.join(dir, 't', f), s, 'utf8');
    put('keep.test.ts', 'a\nb\n');
    put('grow.test.ts', 'a\nb\n');
    put('edit.test.ts', 'a\nb\n');
    put('gone.test.ts', 'a\n');
    const globs = ['t/*.test.ts'];
    const before = snapshotTests(globs, dir);
    put('grow.test.ts', 'a\nx\nb\ny\n');
    put('edit.test.ts', 'a\nB\n');
    rmSync(path.join(dir, 't', 'gone.test.ts'));
    put('new.test.ts', 'z\n');
    const e = testChanges(before, globs, dir);
    assert.deepEqual(e.added, ['`t/grow.test.ts` +2줄', '`t/new.test.ts` 새 파일']);
    assert.deepEqual(e.weakened, ['`t/edit.test.ts` 기존 줄이 바뀌거나 지워졌다', '`t/gone.test.ts` 가 지워졌다']);
    assert.equal(outcomeOf(true, collect(row('R01'), [cmd('npm test', 0), e])), 'rework');
    assert.equal(outcomeOf(true, collect(row('R01'), [cmd('npm test', 0), { ...e, weakened: [] }])), 'ok', '추가만이면 완료를 막지 않는다.');
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
