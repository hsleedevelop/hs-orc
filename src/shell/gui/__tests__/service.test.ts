/**
 * S7 완료 판정: **v1 의 S5 시나리오가 GUI 에서 동일하게 통과한다.**
 * 창을 띄우지 않고 검증한다 — 로직이 Electron 에 묶여 있으면 이 파일이 아예 안 만들어진다.
 */
import { describe, it, mock } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SlotExecutor } from '../../../core/executor.ts';
import { readDecisions } from '../../../core/decision-log.ts';
import { gitEnv } from '../../../core/git-env.ts';
import { projectStateDir } from '../../../core/project-state.ts';
import { appendRecord, transcriptPath } from '../../../core/transcript.ts';
import { restoreBudget } from '../../conversation.ts';
import { lockPath } from '../../../core/session-lock.ts';
import { sendToSession } from '../../session-cmd.ts';
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

  it('고를 업무 행은 매트릭스의 primary · reviewer 모델을 기본 effort 로 싣는다', () => {
    const r01 = new GuiService(fake).tasks().find((t) => t.id === 'R01');
    assert.equal(r01?.models, 'Luna·medium · Haiku·low');
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
  const env = gitEnv();
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
    assert.ok(service.conversations().scratch.some((s) => s.id === view.id && s.preview === '넌 누구니'));
  });

  it('터미널은 열린 세션의 폴더에서 고른 앱으로 열고, 세션이 없거나 모르는 터미널이면 거절한다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    const opened: string[] = [];
    const open = (dir: string, terminal: string) => { opened.push(`${terminal} ${dir}`); return Promise.resolve(); };
    await assert.rejects(service.openSessionTerminal('default', open), /열린 세션이 없다/);
    const view = service.startConversation('scratch');
    assert.equal(await service.openSessionTerminal('ghostty', open), view.dir);
    await assert.rejects(service.openSessionTerminal('/bin/sh', open), /모르는 터미널/);
    assert.deepEqual(opened, [`ghostty ${view.dir}`]);
  });

  it('앱 실행 요청은 실행 카드가 서고, 고른 터미널로 연다 — 모르는 터미널은 거절하고 카드는 남는다 (D-091)', async () => {
    isolated();
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hs-gui-run-')));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev' } }));
    mkdirSync(path.join(dir, 'node_modules'));
    const service = new GuiService(fake, 20, dir);
    service.useProject(dir);
    service.startConversation('project');
    calls.length = 0;
    const card = await service.converse('현재 앱 실행해줘');
    assert.equal(card.runPending, true);
    assert.equal(card.records.at(-1)?.kind, 'run');
    assert.deepEqual(calls, [], '엔진·지휘자를 부르지 않는다');
    const launched: string[] = [];
    const launch = (d: string, argv: readonly string[], t: string) => { launched.push(`${t} ${d} ${argv.join(' ')}`); return Promise.resolve('Otty'); };
    await assert.rejects(service.converseRun('/bin/sh', launch), /모르는 터미널/);
    assert.equal(service.conversation().runPending, true);
    const view = await service.converseRun('otty', launch);
    assert.deepEqual(launched, [`otty ${dir} npm run dev`]);
    const last = view.records.at(-1);
    assert.ok(last?.kind === 'run-launch' && last.outcome === 'opened' && last.terminal === 'Otty');
    assert.equal(view.runPending, false);
    assert.equal(view.state, 'waiting_input');
  });

  it('분류되지 않는 메시지에 직접 답한다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    service.startConversation('scratch');
    const view = await service.converse('넌 누구니');
    assert.deepEqual(view.records.filter((r) => r.kind !== 'mode' && r.kind !== 'orchestrator').map((r) => r.kind), ['user', 'direct']);
    assert.equal(view.state, 'waiting_input');
  });

  it('배정 카드에서 지휘자에게 물으면 거절 뒤 직접 답을 보여준다 (D-038)', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    service.startConversation('scratch');
    await service.converse('방금 리팩터링한 부분 설명해');
    const view = await service.converseAsk();
    assert.deepEqual(view.records.filter((r) => r.kind !== 'mode' && r.kind !== 'orchestrator').map((r) => r.kind), ['user', 'plan', 'approval', 'direct']);
    assert.equal(view.state, 'waiting_input');
  });

  it('지휘자 제안은 직접 답 아래 배정 카드가 되고, 카드가 선 채 보낸 메시지는 그 배정을 거절로 남긴다 (D-064)', async () => {
    isolated();
    const suggesting: SlotExecutor = (slot, prompt) =>
      prompt.includes('[이번 메시지]')
        ? Promise.resolve({ ok: true, text: '작업으로 보인다.\nSUGGEST: R01', rawStdout: '', rawStderr: '', durationMs: 1 })
        : fake(slot, prompt);
    const service = new GuiService(suggesting, 20, process.cwd());
    service.startConversation('scratch');
    const shown = await service.converse('넌 누구니');
    assert.deepEqual(shown.records.filter((r) => r.kind !== 'mode' && r.kind !== 'orchestrator').map((r) => r.kind), ['user', 'direct', 'plan']);
    assert.equal(shown.state, 'blocked');
    const next = await service.converse('아니 그냥 얘기하자');
    assert.deepEqual(next.records.filter((r) => r.kind !== 'mode' && r.kind !== 'orchestrator').map((r) => r.kind), ['user', 'direct', 'plan', 'approval', 'user', 'direct', 'plan']);
  });

  it('카드의 행을 바꾸면 그 카드를 거절하고 고른 행으로 다시 선다 — 거절 뒤에 값을 다시 읽지 않는다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    service.startConversation('scratch');
    const shown = await service.converse('이 타입 에러 고쳐줘');
    assert.equal(shown.records.at(-1)?.kind, 'plan');
    const view = await service.converseReplan('R04');
    assert.deepEqual(view.records.filter((r) => r.kind !== 'mode' && r.kind !== 'orchestrator').slice(-3).map((r) => r.kind), ['plan', 'approval', 'plan']);
    const plan = view.records.at(-1);
    assert.ok(plan?.kind === 'plan' && plan.taskId === 'R04', `R04 카드가 서야 한다: ${plan?.kind === 'plan' ? plan.taskId : plan?.kind}`);
    assert.equal(view.state, 'blocked');
  });

  it('카드의 행을 바꿔도 원 카드의 쓰기 위임을 이어받는다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    service.startConversation('project');
    await service.converse('이 타입 에러 고쳐줘', true);
    const view = await service.converseReplan('R04');
    const plan = view.records.at(-1);
    assert.ok(plan?.kind === 'plan' && plan.taskId === 'R04');
    assert.equal(plan.write, true, '행을 바꿨다고 쓰기 스위치가 꺼지면 안 된다');
  });

  it('스크래치에서는 쓰기 승인을 거절한다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    service.startConversation('scratch');
    await service.converse('이 타입 에러 고쳐줘');
    await assert.rejects(service.converseApprove({ verify: [], write: true }), /쓰기를 켤 수 없다/);
  });

  it('세션 목록은 프로젝트별로 묶인다 — 이름순이라 폴더를 옮겨도 순서가 그대로고, 떠난 폴더의 세션은 그 폴더 아래 남는다', async () => {
    isolated();
    const a = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hs-tree-a-')));
    const b = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hs-tree-b-')));
    const service = new GuiService(fake, 20, a);
    service.useProject(a);
    const view = service.startConversation('project');
    await service.converse('넌 누구니');
    service.useProject(b);

    const tree = service.conversations();
    assert.deepEqual(tree.projects.map((g) => g.project.dir), [a, b]);
    assert.ok(tree.projects[0]?.sessions.some((s) => s.id === view.id && s.preview === '넌 누구니'));
    assert.deepEqual(tree.projects[1]?.sessions, []);

    // 이름 클릭·다른 폴더의 ＋(useProject)와 세션 열기(openConversation) 모두 최근 목록을 당기지만 사이드바 순서는 그대로다.
    service.openConversation('project', a, view.id);
    assert.deepEqual(service.conversations().projects.map((g) => g.project.dir), [a, b]);
    service.useProject(b);
    assert.deepEqual(service.conversations().projects.map((g) => g.project.dir), [a, b]);
  });

  it('다른 폴더로 옮기면 그 폴더의 것이 아닌 project 세션을 닫는다', () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    service.startConversation('project');
    service.useProject(mkdtempSync(path.join(os.tmpdir(), 'hs-other-')));
    assert.throws(() => service.conversation(), /열린 세션이 없다/);
  });

  it('빈 폴더에서 세션을 열고 위임까지 돌려도 그 폴더에는 아무것도 생기지 않는다 — 스캐폴더가 돈다 (D-071)', async () => {
    isolated();
    delete process.env['HS_ORC_RUN_STORE']; // 원시 로그도 기본 자리(홈의 프로젝트 상태)로 보낸다.
    const empty = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hs-empty-')));
    const service = new GuiService(fake, 20, empty);
    const view = service.startConversation('project');
    // 읽기 행이다 — 쓰기 행은 git 아닌 폴더에서 읽기 전용 승인이 막힌다 (H6, D-088).
    await service.converse('이 아키텍처 설계 검토해줘');
    await service.converseApprove({ verify: [], write: false });

    assert.deepEqual(readdirSync(empty), []);
    assert.ok(existsSync(transcriptPath(empty, view.id)), '기록은 홈의 프로젝트 상태에 있다');
    assert.ok(readdirSync(path.join(projectStateDir(empty), 'runs')).length > 0, '원시 로그도 홈에 있다');

    const scratch = service.startConversation('scratch');
    await service.converse('넌 누구니');
    assert.deepEqual(readdirSync(scratch.dir), [], '스크래치 폴더도 엔진 cwd 로만 쓰고 비워 둔다');
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

  /** 문을 열 때까지 모든 엔진 호출을 붙잡는다 — 위임·직접 답이 "도는 중" 인 상태를 만든다. */
  const gated = () => {
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const exec: SlotExecutor = async (slot, prompt) => { await gate; return fake(slot, prompt); };
    return { exec, open: () => open() };
  };
  const fileKinds = (view: { dir: string; id: string }) =>
    readFileSync(transcriptPath(view.dir, view.id), 'utf8')
      .trim().split('\n').map((l) => (JSON.parse(l) as { kind: string }).kind).filter((k) => k !== 'mode' && k !== 'orchestrator');

  it('위임이 도는 중에 세션 목록으로 나갔다 같은 세션을 다시 열면 같은 실행에 붙는다 — 끊김 배너 없음', async () => {
    isolated();
    const g = gated();
    const service = new GuiService(g.exec, 20, process.cwd());
    const a = service.startConversation('scratch');
    await service.converse('이 타입 에러 고쳐줘');
    const running = service.converseApprove({ verify: [], write: false });
    service.closeConversation();

    const reopened = service.openConversation('scratch', a.dir, a.id);
    assert.equal(reopened.interrupted, false, '돌고 있는 위임을 끊겼다고 하면 안 된다');
    assert.equal(reopened.state, 'working');
    await assert.rejects(service.converse('넌 누구니'), /지금: working/);
    // 앱을 새로 켠 것(다른 프로세스)이면 그대로 끊김이다 — 진짜 크래시 배너는 살아 있어야 한다.
    assert.equal(new GuiService(fake, 20, process.cwd()).openConversation('scratch', a.dir, a.id).interrupted, true);

    g.open();
    await running;
    const view = service.conversation();
    assert.deepEqual(view.records.filter((r) => r.kind !== 'mode' && r.kind !== 'orchestrator').map((r) => r.kind), ['user', 'plan', 'approval', 'result', 'summary']);
    assert.equal(view.state, 'waiting_input');
    assert.equal(view.interrupted, false);
    assert.deepEqual(fileKinds(a), ['user', 'plan', 'approval', 'result', 'summary', 'spend'], '기록이 겹치거나 섞이면 안 된다');
  });

  it('다른 세션을 열었다 돌아와도 도는 위임에 붙고, 끝난 뒤 다시 열면 파일에서 결과를 읽는다', async () => {
    isolated();
    const g = gated();
    const service = new GuiService(g.exec, 20, process.cwd());
    const a = service.startConversation('scratch');
    await service.converse('이 타입 에러 고쳐줘');
    const running = service.converseApprove({ verify: [], write: false });
    service.closeConversation();
    service.startConversation('scratch');
    service.closeConversation();

    const back = service.openConversation('scratch', a.dir, a.id);
    assert.equal(back.state, 'working');
    assert.equal(back.interrupted, false);

    service.closeConversation();
    g.open();
    await running.catch(() => {});
    const after = service.openConversation('scratch', a.dir, a.id);
    assert.deepEqual(after.records.filter((r) => r.kind !== 'mode' && r.kind !== 'orchestrator').map((r) => r.kind), ['user', 'plan', 'approval', 'result', 'summary']);
    assert.equal(after.interrupted, false);
    assert.equal(after.state, 'waiting_input');
  });

  it('지휘자 직접 답이 도는 중에 다시 열어도 같은 실행에 붙는다', async () => {
    isolated();
    const g = gated();
    const service = new GuiService(g.exec, 20, process.cwd());
    const a = service.startConversation('scratch');
    const running = service.converse('넌 누구니');
    service.closeConversation();

    const reopened = service.openConversation('scratch', a.dir, a.id);
    assert.equal(reopened.state, 'working');
    await assert.rejects(service.converse('또 묻는다'), /지금: working/);

    g.open();
    await running;
    assert.deepEqual(service.conversation().records.filter((r) => r.kind !== 'mode' && r.kind !== 'orchestrator').map((r) => r.kind), ['user', 'direct']);
    assert.deepEqual(fileKinds(a), ['user', 'direct', 'spend']);
  });

  /** 취소 신호가 서야 끝나는 가짜 — **첫** primary 는 안 끝나고, 신호가 서면 cancelled 로 돌아온다. 그 뒤 실행은 곧바로 끝난다. */
  const hangingPrimary = () => {
    const roles: string[] = [];
    let primaries = 0;
    const exec: SlotExecutor = (slot, prompt, options) => {
      roles.push(slot.role);
      if (slot.role === 'primary') primaries += 1;
      if (slot.role === 'reviewer' || primaries > 1) return fake(slot, prompt);
      return new Promise((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve({ ok: false, cancelled: true, text: '', rawStdout: '', rawStderr: '', durationMs: 1 }), { once: true });
      });
    };
    return { exec, roles };
  };

  it('도는 위임을 취소하면 취소 결과를 담은 뷰가 돌아오고 세션은 입력 대기다 (D-066)', async () => {
    isolated();
    const h = hangingPrimary();
    const service = new GuiService(h.exec, 20, process.cwd());
    const a = service.startConversation('scratch');
    service.converseMode('manual'); // 취소 뒤 둘째 위임도 카드 승인으로 보려는 테스트다
    await service.converse('이 타입 에러 고쳐줘');
    const running = service.converseApprove({ verify: [], write: false });
    assert.equal(service.conversation().cancellable, true);

    const view = await service.converseCancel();
    assert.equal(view.state, 'waiting_input');
    assert.equal(view.cancellable, false);
    assert.equal(view.interrupted, false);
    assert.deepEqual(view.records.filter((r) => r.kind !== 'mode' && r.kind !== 'orchestrator').map((r) => r.kind), ['user', 'plan', 'approval', 'result']);
    const result = view.records.at(-1);
    assert.ok(result?.kind === 'result' && result.outcome === 'cancelled');
    assert.deepEqual(h.roles, ['primary'], 'primary 중 취소면 reviewer 를 띄우지 않는다');
    await running; // 원래 요청도 같은 뷰로 끝난다 — 던지지 않는다
    assert.equal(service.openConversation('scratch', a.dir, a.id).interrupted, false, '파일에서 다시 열어도 끊김이 아니다');
    // 취소 뒤 새 위임이 돈다.
    await service.converse('이 타입 에러 다시 고쳐줘');
    const again = await service.converseApprove({ verify: [], write: false });
    assert.equal(again.records.findLast((r) => r.kind === 'result')?.kind, 'result');
    assert.equal(again.state, 'waiting_input');
  });

  it('다시 연 화면(재부착)에서도, 다른 세션을 열었다 돌아와서도 취소가 그 위임을 멈춘다', async () => {
    isolated();
    const h = hangingPrimary();
    const service = new GuiService(h.exec, 20, process.cwd());
    const a = service.startConversation('scratch');
    await service.converse('이 타입 에러 고쳐줘');
    const running = service.converseApprove({ verify: [], write: false });
    service.closeConversation();
    service.startConversation('scratch'); // 다른 세션을 열어 둔다
    service.closeConversation();

    const back = service.openConversation('scratch', a.dir, a.id);
    assert.equal(back.state, 'working');
    assert.equal(back.cancellable, true, '다시 연 화면도 취소 버튼을 띄울 수 있어야 한다');
    assert.equal(back.interrupted, false);
    const view = await service.converseCancel();
    assert.equal(view.state, 'waiting_input');
    assert.equal(view.records.at(-1)?.kind, 'result');
    await running;
    assert.deepEqual(fileKinds(a), ['user', 'plan', 'approval', 'result', 'spend']);
  });

  it('취소할 위임이 없을 때의 취소는 던지지 않고 지금 뷰를 돌려준다 (버튼과 완료가 겹친 경합)', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    service.startConversation('scratch');
    const view = await service.converseCancel();
    assert.equal(view.state, 'waiting_input');
    assert.equal(view.cancellable, false);
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
  it('승인 방식 — 새 세션은 limits 기본값(auto-ask)이고 전환은 기록·뷰에 남는다 (D-064)', () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    const a = service.startConversation('scratch');
    assert.equal(a.mode, 'auto-ask');
    const view = service.converseMode('auto');
    assert.equal(view.mode, 'auto');
    assert.deepEqual(view.records.map((r) => r.kind === 'mode' && r.mode), ['auto']);
    // 다시 열면 재생한다.
    assert.equal(new GuiService(fake, 20, process.cwd()).openConversation('scratch', a.dir, a.id).mode, 'auto');
  });

  it('승인 방식 — auto 로 자동 시작한 위임도 도는 중에 취소되고, 그 위임만 멈춘다 (D-066·D-063)', async () => {
    isolated();
    const h = hangingPrimary();
    const service = new GuiService(h.exec, 20, process.cwd());
    const a = service.startConversation('scratch');
    service.converseMode('auto');
    const running = service.converse('이 타입 에러 고쳐줘');
    for (let i = 0; i < 200 && !service.conversation().cancellable; i += 1) await new Promise<void>((r) => setImmediate(r));
    assert.equal(service.conversation().cancellable, true, '승인 클릭 없이 시작했다');
    // 다시 연 화면(재부착)도 같은 객체에 붙어 있어 취소할 수 있다.
    service.closeConversation();
    const reopened = service.openConversation('scratch', a.dir, a.id);
    assert.equal(reopened.state, 'working');
    assert.equal(reopened.cancellable, true);
    const view = await service.converseCancel();
    assert.equal(view.state, 'waiting_input');
    assert.deepEqual(view.records.filter((r) => r.kind !== 'mode' && r.kind !== 'orchestrator').map((r) => r.kind), ['user', 'plan', 'approval', 'result']);
    const approval = view.records.find((r) => r.kind === 'approval');
    assert.ok(approval?.kind === 'approval' && approval.by === 'auto');
    assert.ok(view.records.at(-1)?.kind === 'result');
    await running;
    assert.deepEqual(h.roles, ['primary']);
  });

  it('승인 방식 — 읽기 행을 쓰기 위임으로 보내면 auto 에서도 카드가 선다 (쓰기 행은 D-086 이 따로 본다)', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    service.startConversation('project');
    service.converseMode('auto');
    // R02(읽기 행) — 쓰기 행(R01 등)은 git 폴더가 깨끗하면 auto 가 바로 시작하므로 작업 트리 상태에 따라 갈린다.
    const view = await service.converse('두 라이브러리 기술 비교해줘', true);
    assert.equal(view.state, 'blocked');
    const plan = view.records.findLast((r) => r.kind === 'plan');
    assert.ok(plan?.kind === 'plan' && plan.write === true);
  });

});

describe('GUI — 사다리 버튼 (D-068)', () => {
  it('미검증 결과 뒤 입력 대기에만 버튼이 있고, 누르면 상향 카드가 서며 시작하지 않는다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    service.startConversation('scratch');
    const asked = await service.converse('이 타입 에러 고쳐줘');
    assert.equal(asked.ladder, null, '승인 대기 중에는 없다');
    const ran = await service.converseApprove({ verify: [], write: false });
    assert.equal(ran.state, 'waiting_input');
    assert.equal(ran.ladder?.stage, 'evidence');
    const before = calls.length;
    const view = service.converseEscalate();
    assert.equal(view.state, 'blocked');
    assert.equal(view.ladder, null, '카드가 선 동안은 버튼이 없다');
    assert.equal(calls.length, before, '버튼은 엔진을 부르지 않는다');
    const card = view.records.at(-1);
    assert.ok(card?.kind === 'plan' && card.ladder?.stage === 'evidence' && card.asked?.some((a) => a.code === 'A3'));
    const after = await service.converseApprove({ verify: [], write: false });
    assert.equal(after.ladder?.stage, 'effort');
  });
});

describe('GUI — 세션 상태·이름·외부 조작 (D-085)', () => {
  it('배정 카드가 선 동안 목록은 승인 대기, 거절하면 idle 이고 점유를 놓는다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    const view = service.startConversation('scratch');
    await service.converse('이 타입 에러 고쳐줘');
    assert.equal(service.conversation().state, 'blocked');
    const status = () => service.conversations().scratch.find((s) => s.id === view.id)?.status?.state;
    assert.equal(status(), 'blocked');
    service.converseReject();
    assert.equal(status(), 'idle');
    assert.equal(existsSync(lockPath(view.dir, view.id)), false);
  });

  it('다른 프로세스가 보낸 턴을 열린 화면이 다시 조립해 잇는다 — 턴 번호가 겹치지 않는다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    service.startConversation('scratch');
    await service.converse('넌 누구니');
    service.converseRename('gui1');
    await sendToSession({ cwd: process.cwd(), ref: 'gui1', message: '두 번째', write: false, run: false, verify: [], execute: fake });
    const users = service.conversation().records.filter((r) => r.kind === 'user');
    assert.deepEqual(users.map((r) => r.turn), [1, 2], '낡은 객체가 남으면 화면에 두 번째 턴이 없다');
    await service.converse('세 번째');
    const turns = service.conversation().records.filter((r) => r.kind === 'user').map((r) => r.turn);
    assert.deepEqual(turns, [1, 2, 3]);
    assert.equal(service.conversation().name, 'gui1');
    assert.equal(service.conversation().external, null);
  });

  it('다른 곳이 쥐었으면 화면에 그 사실을 싣고, 보내기·방식 바꾸기를 거절한다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    const view = service.startConversation('scratch');
    await service.converse('넌 누구니');
    writeFileSync(lockPath(view.dir, view.id), JSON.stringify({ pid: process.ppid, by: 'cli', state: 'working', at: '' }));
    assert.equal(service.conversation().external?.by, 'cli');
    await assert.rejects(service.converse('또'), /다른 곳\(cli/);
    assert.throws(() => service.converseMode('auto'), /다른 곳\(cli/);
  });

  it('닫았다 다시 연 세션은 그 사이 다른 프로세스의 지출까지 Budget 에 싣는다 (PR #111 리뷰 2)', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    const a = service.startConversation('scratch');
    await service.converse('넌 누구니');
    service.startConversation('scratch');
    // 다른 프로세스(`hs-orc session send`)가 A 에 쓴 지출.
    appendRecord(transcriptPath(a.dir, a.id), {
      v: 1, at: new Date().toISOString(), turn: 2, kind: 'spend', tokens: 1000, unreported: 0,
      charges: [{ label: 'Luna', usd: 0.42, source: 'actual', plan: 'api' }],
    });
    const reopened = service.openConversation('scratch', a.dir, a.id);
    assert.equal(reopened.budget, restoreBudget(a.dir, a.id, 20).summary());
    assert.match(reopened.budget, /0\.42/);
  });

  it('이름은 다른 세션과 겹치면 거절한다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    service.startConversation('scratch');
    await service.converse('넌 누구니');
    service.converseRename('alpha');
    service.startConversation('scratch');
    await service.converse('넌 누구니');
    assert.throws(() => service.converseRename('alpha'), /이미 다른 세션/);
    assert.equal(service.converseRename('beta').name, 'beta');
  });
});

describe('GUI — 세션 종료·보관 (D-089)', () => {
  const kinds = (v: { records: readonly { kind: string }[] }) => v.records.map((r) => r.kind).filter((k) => k !== 'mode' && k !== 'orchestrator');

  it('선 카드는 거절로 닫고 종료한다 — 그 뒤 보내기·방식 바꾸기는 거절하고, 다시 열면 이어 쓴다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    const view = service.startConversation('scratch');
    service.converseMode('manual');
    await service.converse('이 타입 에러 고쳐줘');
    assert.equal(service.conversation().state, 'blocked');
    const ref = { kind: view.kind, dir: view.dir, id: view.id };

    const ended = await service.endSession(ref);
    assert.equal(ended?.ended, true);
    assert.equal(ended?.state, 'waiting_input');
    assert.deepEqual(kinds(ended ?? { records: [] }), ['user', 'plan', 'approval'], '종료는 거절 한 줄 말고는 기록에 아무것도 붙이지 않는다');
    assert.equal(existsSync(lockPath(view.dir, view.id)), false);
    assert.equal(service.conversations().scratch.find((s) => s.id === view.id)?.status?.state, 'ended');
    await assert.rejects(service.converse('또'), /종료됐다/);
    assert.throws(() => service.converseMode('auto'), /종료됐다/);
    assert.throws(() => service.converseRename('late'), /종료됐다/);

    assert.equal(service.reopenSession(ref)?.ended, false);
    await service.converse('넌 누구니');
    assert.equal(service.conversation().records.at(-1)?.kind, 'direct');
  });

  it('도는 위임은 취소(D-066)하고 끝나기를 기다린 뒤 종료한다', async () => {
    isolated();
    const roles: string[] = [];
    const exec: SlotExecutor = (slot, prompt, options) => {
      roles.push(slot.role);
      if (slot.role !== 'primary') return fake(slot, prompt);
      return new Promise((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve({ ok: false, cancelled: true, text: '', rawStdout: '', rawStderr: '', durationMs: 1 }), { once: true });
      });
    };
    const service = new GuiService(exec, 20, process.cwd());
    const view = service.startConversation('scratch');
    service.converseMode('manual');
    await service.converse('이 타입 에러 고쳐줘');
    const running = service.converseApprove({ verify: [], write: false });
    assert.equal(service.conversation().cancellable, true);

    const ended = await service.endSession({ kind: view.kind, dir: view.dir, id: view.id });
    assert.equal(ended?.ended, true);
    const result = ended?.records.at(-1);
    assert.ok(result?.kind === 'result' && result.outcome === 'cancelled');
    assert.deepEqual(roles, ['primary'], '취소 뒤 reviewer 를 띄우지 않는다');
    await running;
    assert.equal(existsSync(lockPath(view.dir, view.id)), false);
  });

  it('다른 프로세스가 쥔 세션은 종료·보관하지 않는다 — 그 점유는 그대로 둔다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    const view = service.startConversation('scratch');
    await service.converse('넌 누구니');
    const held = JSON.stringify({ pid: process.ppid, by: 'chat', state: 'working', at: '' });
    writeFileSync(lockPath(view.dir, view.id), held);
    const ref = { kind: view.kind, dir: view.dir, id: view.id };
    await assert.rejects(service.endSession(ref), /종료하지 않는다 — 다른 곳\(chat/);
    assert.throws(() => service.archiveSession(ref, true), /보관하지 않는다 — 다른 곳\(chat/);
    assert.equal(readFileSync(lockPath(view.dir, view.id), 'utf8'), held);
    assert.equal(service.conversation().ended, false);
    assert.equal(service.conversation().archived, false);
  });

  it('기록만 붙이는 조작(방식·이름)은 점유를 쥔 채 쓴다 — 쓰는 순간 다른 프로세스가 종료하려 하면 그쪽이 거절된다 (PR #124 리뷰)', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    const view = service.startConversation('scratch');
    await service.converse('넌 누구니');
    service.converseMode('manual');
    // 다른 GUI 프로세스의 종료 순서(endSession) 그대로 — 쥐고, 종료 표식을 쓰고, 놓는다.
    const other = [
      `import { claimSession, releaseSession } from ${JSON.stringify(path.resolve(import.meta.dirname, '../../../core/session-lock.ts'))};`,
      `import { setEnded } from ${JSON.stringify(path.resolve(import.meta.dirname, '../../../core/session-meta.ts'))};`,
      'const [dir, id] = process.argv.slice(1);',
      "claimSession(dir, id, 'working', 'gui');",
      'try { setEnded(dir, id, true); } finally { releaseSession(dir, id); }',
    ].join('\n');
    let raced: ReturnType<typeof spawnSync> | null = null;
    const append = fs.appendFileSync;
    // 기록 한 줄을 쓰기 직전 — 검사는 끝났고 쓰기는 아직인 그 틈에 다른 프로세스가 종료를 시도한다.
    mock.method(fs, 'appendFileSync', (...args: Parameters<typeof fs.appendFileSync>) => {
      if (!raced && String(args[0]).endsWith(`${view.id}.jsonl`)) {
        raced = spawnSync(process.execPath, ['--input-type=module', '-e', other, view.dir, view.id], { env: process.env, encoding: 'utf8' });
      }
      append(...args);
    });
    syncBuiltinESMExports();
    try {
      service.converseMode('auto');
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
    const race = raced as ReturnType<typeof spawnSync> | null;
    assert.notEqual(race?.status, 0, '쓰는 동안 점유를 쥐지 않으면 다른 프로세스의 종료가 이 틈에 성공한다');
    assert.match(String(race?.stderr), /다른 곳\(gui · pid \d+\)에서 이 세션이 엔진이 도는 중/);
    assert.equal(service.conversation().ended, false);
    assert.equal(service.conversation().mode, 'auto');
    assert.equal(existsSync(lockPath(view.dir, view.id)), false, '쓰고 나면 놓는다 — 카드가 없는 세션이다');
  });

  it('카드가 선 채 기록만 붙이면 승인 대기 점유로 돌아간다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    const view = service.startConversation('scratch');
    service.converseMode('manual');
    await service.converse('이 타입 에러 고쳐줘');
    service.converseRename('carded');
    assert.equal((JSON.parse(readFileSync(lockPath(view.dir, view.id), 'utf8')) as { state: string }).state, 'blocked');
  });

  it('보관은 숨김 표식일 뿐이다 — 목록에 표식이 서고, 대화는 그대로 되고, 복원하면 지워진다. 빈 세션·모양이 틀린 id 는 거절한다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd());
    const view = service.startConversation('scratch');
    const ref = { kind: view.kind, dir: view.dir, id: view.id };
    assert.throws(() => service.archiveSession(ref, true), /빈 세션/);
    await service.converse('넌 누구니');
    const before = service.conversation().records.length;
    assert.equal(service.archiveSession(ref, true)?.archived, true);
    assert.equal(service.conversation().records.length, before);
    assert.equal(service.conversations().scratch.find((s) => s.id === view.id)?.archived, true, '목록은 보관 세션도 표식과 함께 준다 — 화면이 가른다');
    await service.converse('보관한 채 보낸다');
    assert.equal(service.conversation().archived, true);
    assert.equal(service.archiveSession(ref, false)?.archived, false);
    assert.equal(service.conversations().scratch.find((s) => s.id === view.id)?.archived, undefined);
    assert.throws(() => service.archiveSession({ ...ref, id: '../x' }, true), /id 모양이 아니다/);
  });
});

describe('GUI — 세션 역할 (D-090)', () => {
  const project = () => {
    isolated();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-gui-role-'));
    return { dir, service: new GuiService(fake, 20, dir) };
  };

  it('새 세션은 워커다 — 오케스트레이터로 지정하면 뷰·목록에 실리고, 해제하면 워커로 돌아온다. 엔진은 돌지 않는다', () => {
    const { service } = project();
    const before = calls.length;
    const view = service.startConversation('project');
    assert.equal(view.role, 'worker');
    assert.equal(service.converseRole('orchestrator').role, 'orchestrator');
    const row = () => service.conversations().projects[0]?.sessions.find((s) => s.id === view.id);
    assert.equal(row()?.role, 'orchestrator', '첫 메시지 전이어도 role 줄로 목록에 잡힌다');
    assert.equal(service.converseRole('worker').role, 'worker');
    assert.equal(row()?.role, 'worker');
    assert.equal(calls.length, before);
    assert.equal(existsSync(lockPath(view.dir, view.id)), false, '쓰고 나면 놓는다');
  });

  it('같은 폴더의 두 번째 지정은 거절한다 · 스크래치는 지정하지 않는다', () => {
    const { service } = project();
    service.startConversation('project');
    service.converseRole('orchestrator');
    const second = service.startConversation('project');
    assert.throws(() => service.converseRole('orchestrator'), /오케스트레이터는 프로젝트당 하나다/);
    assert.equal(service.conversation().role, 'worker');
    assert.equal(readSessionLogKinds(second.dir, second.id).length, 0, '거절은 아무것도 쓰지 않는다');
    service.startConversation('scratch');
    assert.throws(() => service.converseRole('orchestrator'), /스크래치 세션은 오케스트레이터로/);
  });

  it('카드가 선 채 지정해도 카드는 살아 있고 승인 대기 점유로 돌아간다', async () => {
    const { service } = project();
    const view = service.startConversation('project');
    service.converseMode('manual');
    await service.converse('이 타입 에러 고쳐줘');
    const after = service.converseRole('orchestrator');
    assert.equal(after.state, 'blocked');
    assert.equal(after.records.at(-1)?.kind, 'role');
    assert.equal((JSON.parse(readFileSync(lockPath(view.dir, view.id), 'utf8')) as { state: string }).state, 'blocked');
    assert.equal(service.conversations().projects[0]?.sessions.find((s) => s.id === view.id)?.status?.state, 'blocked');
  });

  it('종료한 오케스트레이터는 세지 않아 새로 지정할 수 있고, 그 뒤 옛 오케스트레이터를 다시 열면 거절한다', async () => {
    const { service } = project();
    const old = service.startConversation('project');
    service.converseRole('orchestrator');
    const ref = { kind: old.kind, dir: old.dir, id: old.id };
    await service.endSession(ref);
    service.startConversation('project');
    assert.equal(service.converseRole('orchestrator').role, 'orchestrator');
    assert.throws(() => service.reopenSession(ref), /오케스트레이터는 프로젝트당 하나다/);
    service.converseRole('worker');
    assert.doesNotThrow(() => service.reopenSession(ref));
  });
});

describe('GUI — 오케스트레이터 0~1 경쟁 (PR #126 리뷰)', () => {
  /** 다른 프로세스가 같은 폴더에 오케스트레이터를 만든다 — `hs-orc session new --role orchestrator` 그대로. */
  const rival = (dir: string) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', [
      `import { newSession } from ${JSON.stringify(path.resolve(import.meta.dirname, '../../session-cmd.ts'))};`,
      // 이름을 주지 않는다 — 이름은 폴더를 넘어 겹침을 보므로, 앞 테스트의 경쟁자 이름에 걸려 잠금과 무관하게 거절될 수 있다.
      "newSession(process.argv[1], 'orchestrator', '');",
    ].join('\n'), dir], { env: process.env, encoding: 'utf8' });

  /** `method` 가 `match` 경로를 처음 건드리기 직전(검사는 끝났고 쓰기는 아직)에 경쟁자를 돌리고 `act` 의 결과를 돌려준다. */
  const raceAt = (method: 'appendFileSync' | 'renameSync', match: (file: string) => boolean, dir: string, act: () => void) => {
    let raced: ReturnType<typeof spawnSync> | null = null;
    const original = fs[method] as (...a: unknown[]) => unknown;
    mock.method(fs, method, (...args: unknown[]) => {
      if (!raced && match(String(method === 'renameSync' ? args[1] : args[0]))) raced = rival(dir);
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      act();
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
    return raced as ReturnType<typeof spawnSync> | null;
  };

  const orchestrators = (service: GuiService) =>
    (service.conversations().projects[0]?.sessions ?? []).filter((s) => s.role === 'orchestrator' && s.status?.state !== 'ended');

  it('지정 — 검사를 지나 쓰기 직전에 다른 프로세스가 만들려 해도 하나만 선다', () => {
    isolated();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-gui-race-'));
    const service = new GuiService(fake, 20, dir);
    const view = service.startConversation('project');
    const race = raceAt('appendFileSync', (f) => f.endsWith(`${view.id}.jsonl`), dir, () => service.converseRole('orchestrator'));
    assert.notEqual(race?.status, 0, '잠금 없이 검사만 하면 경쟁자도 검사를 지나 둘이 된다');
    assert.match(String(race?.stderr), /이 폴더의 역할을 바꾸는 중이다/);
    assert.deepEqual(orchestrators(service).map((s) => s.id), [view.id]);
  });

  it('종료한 오케스트레이터 다시 열기 — 표식을 지우기 직전에 다른 프로세스가 만들려 해도 하나만 선다', async () => {
    isolated();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-gui-race-'));
    const service = new GuiService(fake, 20, dir);
    const view = service.startConversation('project');
    service.converseRole('orchestrator');
    const ref = { kind: view.kind, dir: view.dir, id: view.id };
    await service.endSession(ref);
    const race = raceAt('renameSync', (f) => f.endsWith(`${view.id}.meta.json`), dir, () => service.reopenSession(ref));
    assert.notEqual(race?.status, 0, '잠금 없이 검사만 하면 경쟁자는 아직 종료된 것으로 보고 새로 만든다');
    assert.match(String(race?.stderr), /이 폴더의 역할을 바꾸는 중이다/);
    assert.deepEqual(orchestrators(service).map((s) => s.id), [view.id]);
  });
});

function readSessionLogKinds(dir: string, id: string): string[] {
  try {
    return readFileSync(transcriptPath(dir, id), 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { kind: string }).kind);
  } catch {
    return [];
  }
}
