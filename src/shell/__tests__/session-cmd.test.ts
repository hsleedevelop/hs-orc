/**
 * `hs-orc session` (D-085) — 다른 세션·오케스트레이터가 id·이름으로 세션을 다룬다. 실행기는 전부 가짜다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { gitEnv } from '../../core/git-env.ts';
import os from 'node:os';
import path from 'node:path';
import type { SlotExecutor } from '../../core/executor.ts';
import type { RowClassifier } from '../../adapters/jev.ts';
import type { ApprovalMode } from '../../data/limits.ts';
import { Journal } from '../../core/journal.ts';
import { lockPath } from '../../core/session-lock.ts';
import { prepareSession, readSessionLog } from '../../core/transcript.ts';
import { assembleSession, restoreBudget } from '../conversation.ts';
import { knownSessions, resolveSession } from '../session-registry.ts';
import { listLines, nameSession, parseSessionArgs, sendToSession } from '../session-cmd.ts';

const calls: string[] = [];
const fake: SlotExecutor = (slot, prompt) => {
  calls.push(slot.label);
  return Promise.resolve({ ok: true, text: slot.label === 'Haiku' ? 'PASS' : `ran:${prompt.slice(0, 20)}`, rawStdout: '', rawStderr: '', durationMs: 1 });
};

/** 홈을 가둔 새 project 세션 하나 — 이름을 붙여 기록 파일을 만든다(첫 메시지 전 세션은 목록에 없다). */
function fixture(name: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hs-session-cmd-'));
  process.env['HS_ORC_SCRATCH'] = path.join(root, 'scratch');
  process.env['HS_ORC_PROJECTS'] = path.join(root, 'projects.json');
  process.env['HS_ORC_DECISION_LOG'] = path.join(root, 'log.jsonl');
  process.env['HS_ORC_RUN_STORE'] = path.join(root, 'runs');
  const dir = path.join(root, 'proj');
  mkdirSync(dir);
  const { id } = prepareSession('project', dir);
  const session = assembleSession({ approvalMode: 'manual', kind: 'project', dir, id, budget: restoreBudget(dir, id), journal: new Journal(), execute: fake });
  session.rename(name);
  return { root, dir, id };
}

describe('session — 인자', () => {
  it('명령마다 받는 옵션만 받는다 — 무시되는 옵션은 던진다', () => {
    assert.deepEqual(parseSessionArgs([]), { cmd: 'help' });
    assert.deepEqual(parseSessionArgs(['ls', '--json']), { cmd: 'ls', json: true });
    assert.deepEqual(parseSessionArgs(['send', 'web', '고쳐줘', '--run', '--verify', 'npm test']), { cmd: 'send', ref: 'web', message: '고쳐줘', write: false, run: true, verify: ['npm test'] });
    assert.deepEqual(parseSessionArgs(['show', 'web', '--tail', '3']), { cmd: 'show', ref: 'web', tail: 3, json: false });
    assert.deepEqual(parseSessionArgs(['name', 'web', '']), { cmd: 'name', ref: 'web', name: '' });
    assert.throws(() => parseSessionArgs(['ls', '--run']), /ls 에는 --run/);
    assert.throws(() => parseSessionArgs(['send', 'web']), /인자 2개/);
    assert.throws(() => parseSessionArgs(['send', 'web', '  ']), /비었다/);
    assert.throws(() => parseSessionArgs(['kill', 'web']), /모르는 명령/);
  });
});

describe('session — id·이름으로 찾기', () => {
  it('부른 폴더가 아니어도 출처 표식으로 찾고, id·이름 둘 다 받는다', () => {
    const { dir, id } = fixture('web');
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'hs-session-cwd-'));
    assert.equal(resolveSession(elsewhere, id).dir, dir);
    assert.equal(resolveSession(elsewhere, 'web').id, id);
    assert.throws(() => resolveSession(elsewhere, 'nope'), /그런 세션이 없다/);
    assert.match(listLines(knownSessions(elsewhere)).join('\n'), new RegExp(`${id}  web +idle`));
  });

  it('이름은 다른 세션과 겹칠 수 없고, 모양이 틀리면 던진다', () => {
    const a = fixture('api');
    const b = fixture('other');
    assert.throws(() => nameSession(b.dir, b.id, 'api'), /이미 다른 세션/);
    assert.throws(() => nameSession(b.dir, b.id, '1abc'), /영문자로 시작/);
    assert.match(nameSession(b.dir, b.id, 'api2').line, /이름 {3}→ api2/);
    assert.equal(resolveSession(a.dir, 'api2').id, b.id);
  });
});

describe('session — send', () => {
  it('직접 답 한 턴을 찍고 놓는다', async () => {
    const { root, dir, id } = fixture('chat1');
    const out = await sendToSession({ cwd: root, ref: 'chat1', message: '넌 누구니', write: false, run: false, verify: [], execute: fake });
    assert.equal(out.exitCode, 0);
    assert.deepEqual(out.records.filter((r) => r.kind !== 'spend' && r.kind !== 'mode').map((r) => r.kind), ['user', 'direct']);
    assert.match(out.lines.join('\n'), new RegExp(`상태   idle · ${id} \\(chat1\\)`));
    assert.equal(knownSessions(root).find((s) => s.id === id)?.status?.state, 'idle', '끝나면 점유를 놓는다');
    assert.equal(readSessionLog(dir, id).records.filter((r) => r.kind === 'user').length, 1);
  });

  it('--run 없이 선 배정은 거절로 남기고, --run 이면 그 카드를 승인해 위임 결과까지 간다', async () => {
    fixture('task1');
    const shown = await sendToSession({ cwd: process.cwd(), ref: 'task1', message: '이 타입 에러 고쳐줘', write: false, run: false, verify: [], execute: fake });
    assert.ok(shown.records.some((r) => r.kind === 'plan'));
    assert.ok(shown.records.some((r) => r.kind === 'approval' && !r.approved));
    assert.match(shown.lines.join('\n'), /제시만 했다/);

    const ran = await sendToSession({ cwd: process.cwd(), ref: 'task1', message: '이 타입 에러 고쳐줘', write: false, run: true, verify: [], execute: fake });
    assert.ok(ran.records.some((r) => r.kind === 'approval' && r.approved));
    assert.ok(ran.records.some((r) => r.kind === 'result'));
    assert.match(ran.lines.join('\n'), /상태 {3}완료 · /);
  });

  it('다른 곳이 쥐고 있으면 보내지 않는다', async () => {
    const { dir, id } = fixture('held');
    writeFileSync(lockPath(dir, id), JSON.stringify({ pid: process.ppid, by: 'gui', state: 'blocked', at: '' }));
    const before = readSessionLog(dir, id).records.length;
    await assert.rejects(sendToSession({ cwd: dir, ref: 'held', message: '넌 누구니', write: false, run: false, verify: [], execute: fake }), /배정 카드가 승인을 기다리는 중/);
    assert.equal(readSessionLog(dir, id).records.length, before);
  });
});

describe('session — 이름과 승인 방식', () => {
  it('첫 메시지 전에 이름만 붙인 세션은 새 세션의 기본 방식으로 연다 — 옛 세션(manual)으로 오인하지 않는다', () => {
    const { dir, id } = fixture('fresh');
    const reopened = assembleSession({ approvalMode: 'auto', kind: 'project', dir, id, budget: restoreBudget(dir, id), journal: new Journal(), execute: fake });
    assert.equal(reopened.mode, 'auto');
  });
});

/**
 * auto 가 실제로 클릭 없이 시작하는 배정 — 규칙이 고르는 읽기 행(R10). 쓰기 행(R01 등)은 git 아닌 폴더에서 auto 여도 묻는다 (D-086 H6)
 * — 그 메시지로는 자동 승인이 일어나지 않아 아래 회귀들이 아무것도 재지 않는다.
 */
const READ_ROW = '이 아키텍처 설계 검토해줘';

describe('session — 재시도 카드 (PR #111 리뷰 3)', () => {
  it('auto 세션의 자동 위임이 예외로 끝나 선 재시도 카드는 --run 이 있어도 승인하지 않는다 — primary 는 한 번만 돈다', async () => {
    const { dir, id } = fixture('retry1');
    let primary = 0;
    const boom: SlotExecutor = (slot, prompt, options) => {
      if (slot.role === 'primary') {
        primary += 1;
        if (primary === 1) return Promise.reject(new Error('spawn 실패'));
      }
      return fake(slot, prompt, options);
    };
    assembleSession({ kind: 'project', dir, id, budget: restoreBudget(dir, id), journal: new Journal(), execute: fake }).setMode('auto');
    const out = await sendToSession({ cwd: dir, ref: 'retry1', message: READ_ROW, write: false, run: true, verify: [], execute: boom });
    assert.equal(primary, 1, `기록: ${out.records.map((r) => r.kind).join(',')}`);
    assert.ok(out.records.some((r) => r.kind === 'plan' && r.retry === true), '재시도 카드가 서야 이 경로다');
    const closing = out.records.at(-1);
    assert.ok(closing?.kind === 'approval' && !closing.approved, `카드는 거절로 닫는다: ${out.records.map((r) => r.kind).join(',')}`);
    assert.match(out.lines.join('\n'), /재시도 카드는 자동으로 승인하지 않는다/);
  });
});

describe('session — --run 이 없으면 위임을 시작하지 않는다 (PR #111 리뷰 5, 전하 결정)', () => {
  it('auto 세션이어도 --run 없는 send 는 위임 엔진을 부르지 않고 카드를 거절로 남긴다 — 세션 방식은 그대로다', async () => {
    const { dir, id } = fixture('auto1');
    assembleSession({ kind: 'project', dir, id, budget: restoreBudget(dir, id), journal: new Journal(), execute: fake }).setMode('auto');
    const delegated: string[] = [];
    const watch: SlotExecutor = (slot, prompt, options) => {
      delegated.push(slot.role);
      return fake(slot, prompt, options);
    };
    const out = await sendToSession({ cwd: dir, ref: 'auto1', message: READ_ROW, write: false, run: false, verify: [], execute: watch });
    assert.deepEqual(delegated, [], `기록: ${out.records.map((r) => r.kind).join(',')}`);
    assert.ok(out.records.some((r) => r.kind === 'approval' && !r.approved));
    const reopened = assembleSession({ kind: 'project', dir, id, budget: restoreBudget(dir, id), journal: new Journal(), execute: fake });
    assert.equal(reopened.mode, 'auto', 'GUI·chat 에서는 auto 가 그대로다');
  });
});

describe('session — --run 게이트와 D-086 쓰기 행 자동 시작', () => {
  it('깨끗한 git 폴더의 auto 세션이라도 --run 없는 send 는 쓰기 행(R01) 위임을 시작하지 않는다 — --run 이면 쓰기로 시작한다', async () => {
    const { dir, id } = fixture('gitw');
    const git = spawnSync('git', ['init', '-q', dir], { env: gitEnv() });
    assert.equal(git.status, 0, git.stderr.toString());
    assembleSession({ kind: 'project', dir, id, budget: restoreBudget(dir, id), journal: new Journal(), execute: fake }).setMode('auto');
    const roles: string[] = [];
    const watch: SlotExecutor = (slot, prompt, options) => {
      roles.push(slot.role);
      return fake(slot, prompt, options);
    };
    const shown = await sendToSession({ cwd: dir, ref: 'gitw', message: '이 타입 에러 고쳐줘', write: false, run: false, verify: [], execute: watch });
    assert.equal(roles.length, 0, `기록: ${shown.records.map((r) => r.kind).join(',')}`);
    const card = shown.records.find((r) => r.kind === 'plan');
    assert.ok(card?.kind === 'plan' && card.write === true, '쓰기 행 카드는 쓰기가 켜진 채 선다 (D-086)');
    assert.ok(shown.records.some((r) => r.kind === 'approval' && !r.approved));

    // 대조: --run 이면 D-086 대로 클릭 없이 쓰기로 시작한다 — 위 0 회가 이 경로를 막은 결과임을 보인다.
    const ran = await sendToSession({ cwd: dir, ref: 'gitw', message: '이 타입 에러 고쳐줘', write: false, run: true, verify: [], execute: watch });
    assert.ok(ran.records.some((r) => r.kind === 'approval' && r.approved && r.write && r.by === 'auto'), `기록: ${ran.records.map((r) => r.kind).join(',')}`);
    assert.ok(roles.includes('primary'));
  });
});

/** 깨끗한 git 폴더의 이름 붙은 세션 — 방식을 기록으로 굳힌다. */
function gitFixture(name: string, mode: ApprovalMode) {
  const f = fixture(name);
  const git = spawnSync('git', ['init', '-q', f.dir], { env: gitEnv() });
  assert.equal(git.status, 0, git.stderr.toString());
  assembleSession({ kind: 'project', dir: f.dir, id: f.id, budget: restoreBudget(f.dir, f.id), journal: new Journal(), execute: fake }).setMode(mode);
  return f;
}

describe('session — --run 은 카드의 쓰기 값을 따른다 (D-085 결정 5-a, 재검증 리뷰)', () => {
  for (const mode of ['manual', 'auto-ask'] as const) {
    it(`${mode} 세션: 깨끗한 git 폴더의 쓰기 행(R01) 카드를 --run 이 --write 없이도 쓰기로 승인한다`, async () => {
      const { dir } = gitFixture(`w-${mode}`, mode);
      const out = await sendToSession({ cwd: dir, ref: `w-${mode}`, message: '이 타입 에러 고쳐줘', write: false, run: true, verify: [], execute: fake });
      const approval = out.records.find((r) => r.kind === 'approval');
      assert.ok(approval?.kind === 'approval' && approval.approved && approval.write, `기록: ${JSON.stringify(approval)}`);
    });
  }

  it('쓰기 행 카드 + 미커밋 변경(H5) + --run(--write 없음) 이면 실행하지 않고 거절로 남긴다 — 엔진 0회·exit 1', async () => {
    const { dir } = gitFixture('w-dirty', 'manual');
    writeFileSync(path.join(dir, 'draft.txt'), '커밋 안 한 변경');
    const roles: string[] = [];
    const watch: SlotExecutor = (slot, prompt, options) => {
      roles.push(slot.role);
      return fake(slot, prompt, options);
    };
    const out = await sendToSession({ cwd: dir, ref: 'w-dirty', message: '이 타입 에러 고쳐줘', write: false, run: true, verify: [], execute: watch });
    assert.equal(roles.length, 0, `기록: ${out.records.map((r) => r.kind).join(',')}`);
    const approval = out.records.find((r) => r.kind === 'approval');
    assert.ok(approval?.kind === 'approval' && !approval.approved, '거절로 남긴다');
    assert.equal(out.exitCode, 1);
    assert.match(out.lines.join('\n'), /미커밋 변경 1개가 있다 \(H5\) — 실행하지 않고 거절로 남겼다\. 커밋하거나 --write 로 명시하라/);
  });
});

describe('session — GENERAL 읽기 답도 --run 이 있어야 돈다 (D-085 결정 5)', () => {
  it('auto 세션 · Jev GENERAL: --run 없으면 읽기 슬롯을 부르지 않고, --run 이면 읽기 답이 돈다', async () => {
    const { dir, id } = fixture('general1');
    assembleSession({ kind: 'project', dir, id, budget: restoreBudget(dir, id), journal: new Journal(), execute: fake }).setMode('auto');
    const general: RowClassifier = () => Promise.resolve({ choice: 'GENERAL', probabilities: { GENERAL: 0.95, NONE: 0.05 }, confidence: 0.95, inputTokens: 1, outputTokens: 1, elapsedMs: 1 });
    const labels: string[] = [];
    const watch: SlotExecutor = (slot, prompt, options) => {
      labels.push(slot.label);
      return fake(slot, prompt, options);
    };
    const ask = '이 프로젝트의 세션 기록은 어디에 저장되나';
    const shown = await sendToSession({ cwd: dir, ref: 'general1', message: ask, write: false, run: false, verify: [], execute: watch, classifier: general });
    assert.ok(!labels.some((l) => l.startsWith('읽기')), `불린 슬롯: ${labels.join(',')}`);
    assert.ok(shown.records.some((r) => r.kind === 'direct' && r.general === true && r.read === undefined));

    const ran = await sendToSession({ cwd: dir, ref: 'general1', message: ask, write: false, run: true, verify: [], execute: watch, classifier: general });
    assert.ok(ran.records.some((r) => r.kind === 'direct' && r.read?.by === 'auto'), `기록: ${ran.records.map((r) => r.kind).join(',')}`);
  });
});
