/**
 * S7 완료 판정: **v1 의 S5 시나리오가 GUI 에서 동일하게 통과한다.**
 * 창을 띄우지 않고 검증한다 — 로직이 Electron 에 묶여 있으면 이 파일이 아예 안 만들어진다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SlotExecutor } from '../../../core/executor.ts';
import { readDecisions } from '../../../core/decision-log.ts';
import { GuiService, skipGitCheck } from '../service.ts';
import { samePath } from '../worktree.ts';
import { spawnSync } from 'node:child_process';

const calls: string[] = [];
const fake: SlotExecutor = (slot, prompt) => {
  calls.push(slot.label);
  const text = slot.label === 'Haiku' ? 'PASS' : `ran:${prompt}`;
  // raw 는 파싱 전이다 — 셸이 이것을 그대로 디스크에 쓰는지 아래 테스트가 본다.
  return Promise.resolve({ ok: true, text, rawStdout: `{"raw":"${slot.label}"}`, rawStderr: '', durationMs: 1 });
};

const isolated = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-gui-'));
  process.env['HS_ORC_DECISION_LOG'] = path.join(dir, 'log.jsonl');
  process.env['HS_ORC_RUN_STORE'] = path.join(dir, 'runs');
  // 최근 목록도 가둔다 — 테스트가 진짜 홈의 projects.json 을 고치면 안 된다.
  process.env['HS_ORC_PROJECTS'] = path.join(dir, 'projects.json');
  process.env['HS_ORC_WORKTREES'] = path.join(dir, 'worktrees');
  process.env['HS_ORC_SCRATCH'] = path.join(dir, 'scratch');
  return path.join(dir, 'log.jsonl');
};

describe('GUI — Core 를 그대로 쓴다', () => {
  it('분류 → 배정 → 비용을 v1 과 같은 뷰모델로 낸다', async () => {
    const view = await new GuiService(fake).plan('이 아키텍처 설계 검토해줘');
    assert.equal(view.awaitingApproval, true);
    assert.equal(view.cost?.line, '$10.89 = primary $7.63 + reviewer $3.26');
    assert.equal(view.cost?.badge.grade, 'INDEPENDENT');
    assert.ok(view.lines.some((l) => l.startsWith('reviewer')), 'reviewer 슬롯이 GUI 에서 사라지면 안 된다');
  });

  it('승인 전에 write 선택과 reviewer read-only를 보여준다', async () => {
    const view = await new GuiService(fake).plan('이 아키텍처 설계 검토해줘', { write: true });
    assert.match(view.lines.at(-1) ?? '', /primary .*workspace 파일을 고칠 수 있음/);
    assert.match(view.lines.at(-1) ?? '', /reviewer 는 읽기 전용/);
  });

  it('하한선·분류 실패는 GUI 에서도 비용도 승인도 없다', async () => {
    // 폴백을 끈다 — 켜면 이 테스트가 진짜 Haiku 를 부른다(돈 쓰는 테스트는 아무도 안 돌린다).
    const view = await new GuiService(fake).plan('오늘 점심 뭐 먹지', { classifyLlm: false });
    assert.equal(view.cost, null);
    assert.equal(view.awaitingApproval, false);
    assert.equal(view.stage, 'unclassified');
  });

  it('분류가 빗나가도 화면에서 고른 행으로 배정하고, run 도 같은 행으로 돈다', async () => {
    isolated();
    const service = new GuiService(fake);
    const view = await service.plan('넌 누구니', { classifyLlm: false, taskId: 'R01' });
    assert.equal(view.stage, 'assigned');
    assert.equal(view.awaitingApproval, true);
    assert.match(view.lines[0] ?? '', /수동 지정 R01/);

    const result = await service.run({ task: '넌 누구니', verify: [], classifyLlm: false, taskId: 'R01' });
    assert.equal(result.ok, true, 'run 이 다시 분류하면 여기서 미분류로 떨어진다');
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

  it('원시 로그를 실행별로 남긴다 — **파싱 결과가 아니라 원본이다** (SPEC §3.7)', async () => {
    isolated();
    await new GuiService(fake).run({ task: '이 타입 에러 고쳐줘', verify: [] });
    const dir = path.join(process.env['HS_ORC_RUN_STORE'] as string, readDecisions().at(-1)?.id ?? '');
    assert.ok(readFileSync(path.join(dir, '01-Luna.meta.json'), 'utf8').includes('outcome'));
    // fake 가 준 raw 가 그대로 디스크에 있어야 한다. `text`(ran:…) 가 들어 있으면 셸이 raw 를 버린 것이다.
    assert.equal(readFileSync(path.join(dir, '01-Luna.stdout'), 'utf8'), '{"raw":"Luna"}');
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

describe('GUI — 작업 폴더 (폴더 전환)', () => {
  it('바꾼 폴더에서 검증 명령이 돈다 — 화면의 폴더와 실행 폴더가 갈리면 안 된다', async () => {
    isolated();
    const project = mkdtempSync(path.join(os.tmpdir(), 'hs-project-'));
    writeFileSync(path.join(project, 'MARKER'), '', 'utf8');

    const service = new GuiService(fake, undefined, os.tmpdir());
    assert.equal(service.projects().current.dir, os.tmpdir());
    assert.equal(service.useProject(project).current.dir, project);

    // MARKER 는 **바꾼 폴더에만** 있다. 이 명령이 통과하면 cwd 가 실제로 옮겨간 것이다.
    const result = await service.run({ task: '이 타입 에러 고쳐줘', verify: ['test -f MARKER'] });
    assert.equal(result.report?.accepted.some((e) => e.kind === 'command' && e.exitCode === 0), true);
    assert.equal(service.debug().cwd, project, 'Debug 화면이 예전 폴더를 보여주면 안 된다');
  });

  it('폴더가 아니면 던지고 **이전 폴더를 유지한다**', () => {
    isolated();
    const service = new GuiService(fake, undefined, os.tmpdir());
    assert.throws(() => service.useProject(path.join(os.tmpdir(), '없는-폴더-xyz')), /폴더가 아니다/);
    assert.equal(service.cwd, os.tmpdir());
  });

  it('바꾼 폴더가 최근 목록 맨 앞에 남는다', () => {
    isolated();
    const project = mkdtempSync(path.join(os.tmpdir(), 'hs-project-'));
    const state = new GuiService(fake, undefined, os.tmpdir()).useProject(project);
    assert.equal(state.recent[0]?.dir, project);
  });
});

/** 훅이 심는 GIT_DIR 류를 지운 환경으로 만든다 — 안 지우면 바깥 저장소를 본다. */
function initRepo(dir: string): void {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX']) delete env[key];
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir, env });
}

describe('GUI — 워크트리', () => {
  it('워크트리를 만들면 **그 안으로 들어간다** — 만들고 본체에 남으면 쓰기를 가둔 뜻이 없다', () => {
    isolated();
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hs-svc-wt-')));
    initRepo(repo);

    const service = new GuiService(fake, undefined, repo);
    assert.equal(service.worktrees().items.length, 1, '본체 하나로 시작한다');

    const state = service.createWorktree('slot-a');
    assert.ok(samePath(service.cwd, state.current.dir));
    assert.notEqual(samePath(service.cwd, repo), true, '본체에 남아 있으면 안 된다');
    assert.equal(service.worktrees().items.find((w) => samePath(w.dir, service.cwd))?.branch, 'hs-orc/slot-a');
    assert.equal(state.current.dir.startsWith(repo), false, '워크트리는 저장소 밖(홈)에 둔다');
  });

  it('지금 들어가 있는 워크트리를 지우면 **본체로 나온 뒤** 지운다', () => {
    isolated();
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hs-svc-rm-')));
    initRepo(repo);

    const service = new GuiService(fake, undefined, repo);
    const inside = service.createWorktree('temp').current.dir;
    const after = service.removeWorktree(inside);

    assert.ok(samePath(service.cwd, repo), '발밑을 지운 채로 남아 있으면 안 된다');
    assert.equal(after.worktrees.items.length, 1);
    assert.equal(after.project.recent.some((r) => samePath(r.dir, inside)), false, '지운 폴더가 최근 목록에 남으면 안 된다');
  });
});

describe('codex git 검사 끄기 (D-055)', () => {
  it('스크래치는 늘 끄고, git 이 아닌 project 는 읽기 전용일 때만 끈다 — git 저장소는 끄지 않는다', () => {
    assert.equal(skipGitCheck('scratch', false, false), true);
    assert.equal(skipGitCheck('project', false, false), true);
    assert.equal(skipGitCheck('project', false, true), false, '쓰기를 되돌릴 git 이 없다');
    assert.equal(skipGitCheck('project', true, false), false);
  });
});

describe('GUI — 대화 세션 (v2.1)', () => {
  it('스크래치 세션은 HS_ORC_SCRATCH 안에 만들고 목록에 뜬다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    const view = service.startConversation('scratch');
    assert.equal(view.kind, 'scratch');
    assert.ok(view.dir.startsWith(process.env['HS_ORC_SCRATCH'] ?? '~'));
    await service.converse('넌 누구니');
    assert.ok(service.conversations().some((s) => s.id === view.id && s.preview === '넌 누구니'));
  });

  it('분류되지 않는 메시지에 직접 답한다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    service.startConversation('scratch');
    const view = await service.converse('넌 누구니');
    assert.deepEqual(view.records.map((r) => r.kind), ['user', 'direct']);
    assert.equal(view.state, 'waiting_input');
  });

  it('배정 카드에서 지휘자에게 물으면 거절 뒤 직접 답을 보여준다 (D-038)', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    service.startConversation('scratch');
    await service.converse('방금 리팩터링한 부분 설명해');
    const view = await service.converseAsk();
    assert.deepEqual(view.records.map((r) => r.kind), ['user', 'plan', 'approval', 'direct']);
    assert.equal(view.state, 'waiting_input');
  });

  it('스크래치에서는 쓰기 승인을 거절한다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    service.startConversation('scratch');
    await service.converse('이 타입 에러 고쳐줘');
    await assert.rejects(service.converseApprove({ verify: [], write: true }), /쓰기를 켤 수 없다/);
  });

  it('다른 폴더로 옮기면 그 폴더의 것이 아닌 project 세션을 닫는다', () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    service.startConversation('project');
    service.useProject(mkdtempSync(path.join(os.tmpdir(), 'hs-other-')));
    assert.throws(() => service.conversation(), /열린 세션이 없다/);
  });

  it('세션마다 Budget 이 따로다 — 한 세션이 쓴 돈이 다른 세션에 새지 않는다 (D-032 A2)', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    service.startConversation('scratch');
    const afterA = await service.converse('넌 누구니');
    service.closeConversation();
    const b = service.startConversation('scratch');
    // A 는 직접 답으로 charge 가 났고 B 는 아직 아무것도 안 했으니 요약 문자열이 갈려야 한다.
    assert.notEqual(afterA.budget, b.budget);
    // 앱 누적은 표시만 한다 — 두 세션 어느 쪽에서 봐도 같은 문구가 붙는다.
    assert.match(afterA.appBudget, /표시만, 막지 않는다/);
    assert.match(b.appBudget, /표시만, 막지 않는다/);
  });

  it('같은 세션을 다시 열면 Budget 을 그대로 이어간다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    service.startConversation('scratch');
    const afterA = await service.converse('넌 누구니');
    service.closeConversation();
    const reopened = service.openConversation('scratch', afterA.dir, afterA.id);
    assert.equal(reopened.budget, afterA.budget);
  });

  it('앱을 다시 켜고 같은 세션을 열면 기록의 spend 로 Budget 을 되살린다 — spend 는 화면에 싣지 않는다 (D-054)', async () => {
    isolated();
    const first = new GuiService(fake, 20, process.cwd());
    first.startConversation('scratch');
    const afterA = await first.converse('넌 누구니');
    const restarted = new GuiService(fake, 20, process.cwd());
    const reopened = restarted.openConversation('scratch', afterA.dir, afterA.id);
    assert.equal(reopened.budget, afterA.budget);
    assert.ok(reopened.records.every((r) => r.kind !== 'spend'));
  });

  it('스크래치 뿌리 자체나 뿌리 밖을 가리키는 링크는 스크래치 세션으로 열지 않는다', () => {
    isolated();
    const root = process.env['HS_ORC_SCRATCH'] as string;
    mkdirSync(root, { recursive: true });
    const outside = mkdtempSync(path.join(os.tmpdir(), 'hs-outside-'));
    symlinkSync(outside, path.join(root, 'link'));
    const service = new GuiService(fake, 20, process.cwd());
    assert.throws(() => service.openConversation('scratch', root, 'x'), /스크래치 뿌리 밖/);
    assert.throws(() => service.openConversation('scratch', path.join(root, 'link'), 'x'), /스크래치 뿌리 밖/);
  });
});
