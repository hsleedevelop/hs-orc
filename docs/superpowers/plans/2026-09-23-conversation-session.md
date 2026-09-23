# 대화 세션 (v2.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자가 project 또는 scratch 세션으로 들어가 orc 와 대화하면, orc 가 메시지마다 직접 답하거나(Haiku·low) 매트릭스대로 위임하고(승인 → 두 슬롯 → 증거), 결과를 대화로 되돌려 요약·다음 제안을 낸다.

**Architecture:** Core 에 헤드리스 `ConversationSession` 을 둔다. 대화의 진실은 세션 폴더의 append-only JSONL(`transcript.ts`)이다. 라우팅은 기존 결정론 파이프라인(`routeWithFallback`) 그대로, 모델은 지휘자(`conductor.ts` — 직접 답·요약)에만 쓴다. 위임 실행은 `GuiService.run` 에서 Core 의 `delegate.ts` 로 내려 GUI·세션이 같은 규칙을 쓴다. GUI 는 Run 폼을 세션 목록 + 채팅 화면으로 대체한다.

**Tech Stack:** Node ≥ 22.18 타입 스트리핑(TS 6, 빌드 없음), `node:test`, Electron 44 + React 19(렌더러만 esbuild 번들, JSX 없음), 엔진 CLI(claude·codex·cursor-agent).

**Spec:** `docs/SPEC.md` v0.2 §3.1·§3.8·§4·§6.4·§7.1·§8~§10 · 결정 `docs/DECISIONS.md` D-031 · 제품 `docs/PRD.md` v0.2 FR-12~15

## Global Constraints

- tsconfig `erasableSyntaxOnly: true` — enum·namespace·**파라미터 프로퍼티(`constructor(private x)`) 금지**. 필드를 선언하고 생성자에서 대입한다.
- tsconfig `exactOptionalPropertyTypes: true` — 선택 필드에 `undefined` 를 싣지 않는다. `...(x ? { x } : {})` 로 펼친다.
- tsconfig `verbatimModuleSyntax: true` — 타입만 쓰는 import 는 `import type` / `type X` 로 적는다.
- `src/core/` 는 `src/shell/` 을 import 하지 않는다 (eslint 가 막는다, SPEC §1).
- 렌더러는 JSX 를 쓰지 않는다 — `createElement as h` (D-019).
- 테스트는 소스 옆 `__tests__/`, `node:test` + `node:assert/strict`, `it` 이름은 행위 기술형 한국어. **테스트는 실제 엔진을 띄우지 않고 홈을 건드리지 않는다** — 실행기는 가짜를 주입하고 `HS_ORC_DECISION_LOG`·`HS_ORC_RUN_STORE`·`HS_ORC_PROJECTS`·`HS_ORC_WORKTREES`·`HS_ORC_SCRATCH` 를 tmp 로 돌린다. 분류는 `classifyLlm: false`.
- 단일 테스트 실행: `node --test <파일>`. 게이트: `npm run gate` (matrix:check → type-check → lint → test). 커밋 훅이 게이트를 다시 돈다.
- 새 의존성을 추가하지 않는다.
- 커밋 메시지는 한국어 conventional(`feat(core): …`), 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- 직접 답·요약 모델은 **Haiku·low 고정** (Q11). 라우팅(분류·하한선·배정)을 모델에 넘기지 않는다 (G1).
- 직접 답은 **항상 읽기 전용**, 승인 없음, 비용 한 줄, 누적 상한 공유 (SPEC §6.4.2).
- **reviewer 는 resume 하지 않는다**. resume 실패는 새 세션으로 조용히 떨어지지 않는다 (SPEC §3.8·§6.4.3).
- 맥락 기본값: `contextTurns` 6, `contextChars` 6000 (SPEC §9).
- 스크래치: `~/.hs-orc/scratch/<id>/` (`HS_ORC_SCRATCH` 로 뿌리 변경), git 아님, **쓰기를 켤 수 없다**.

## File Structure

| 파일 | 책임 | 작업 |
|---|---|---|
| `src/core/transcript.ts` | 세션 id·폴더·기록 파일 경로, append/read, 목록 | 1, 8 |
| `src/core/conductor.ts` | 지휘자 슬롯, 직접 답 프롬프트·`SUGGEST` 읽기, 요약 프롬프트, 다음 제안 | 2, 6 |
| `src/core/session.ts` | `ConversationSession` — send/planAs/approve/reject, 상태, resume 정책 | 3, 4, 6, 11 |
| `src/core/context.ts` | 맥락 자르기, 직전 요약 | 4 |
| `src/core/delegate.ts` | 위임 1건 실행 (GuiService.run 에서 내려옴) | 5, 11 |
| `src/core/classify-llm.ts` · `pipeline.ts` | 분류 폴백에 직전 요약 hint | 4 |
| `src/core/assign.ts` | `resolveSlot` export | 2 |
| `src/core/duo.ts` · `executor.ts` | primary resume 전달, sessionId 반환, nonGit | 7, 10, 11 |
| `src/adapters/*` · `src/data/engines.ts` · `data/engines.json` | nonGit 인자, 세션 id 파싱, resume argv | 7, 10 |
| `src/data/limits.ts` · `data/limits.json` | `contextTurns`·`contextChars` | 4 |
| `src/shell/gui/service.ts` · `main.ts` · `preload.cjs` | 세션 API·IPC | 5, 8 |
| `src/shell/gui/renderer/app.ts` · `index.html` | 세션 목록·채팅 화면, Sessions→Agents | 9 |
| `docs/PLAN.md` | S10 기록 | 12 |

---

### Task 1: 대화 기록 저장소

**Files:**
- Create: `src/core/transcript.ts`
- Test: `src/core/__tests__/transcript.test.ts`

**Interfaces:**
- Consumes: `newDecisionId(now?: Date): string` (`src/core/decision-log.ts`)
- Produces:
  - `type SessionKind = 'project' | 'scratch'`, `type SessionState = 'waiting_input' | 'working' | 'blocked'`
  - `interface EngineSessionRef { engine: string; modelId: string; effort: string; id: string }`
  - `type TranscriptEntry` (kind: `user`·`direct`·`plan`·`approval`·`result`·`summary`·`error` — 아래 코드 그대로), `type TranscriptRecord = TranscriptEntry & { v: 1; at: string; turn: number }`
  - `scratchRoot(env?)`, `transcriptPath(dir, id)`, `newSessionId(now?)`, `prepareSession(kind, projectDir, env?) → { dir, id }`, `appendRecord(file, record)`, `readTranscript(file) → { records, broken }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// src/core/__tests__/transcript.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRecord, prepareSession, readTranscript, transcriptPath, type TranscriptRecord } from '../transcript.ts';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'hs-transcript-'));
const user = (turn: number, text: string): TranscriptRecord => ({ v: 1, at: '2026-09-23T00:00:00.000Z', turn, kind: 'user', text });

describe('대화 기록 (SPEC §6.4.1)', () => {
  it('append 한 순서대로 다시 읽는다', () => {
    const file = transcriptPath(tmp(), '0923-1200-abc');
    appendRecord(file, user(1, '안녕'));
    appendRecord(file, user(2, '다음'));
    const loaded = readTranscript(file);
    assert.deepEqual(loaded.records.map((r) => r.turn), [1, 2]);
    assert.equal(loaded.broken, 0);
  });

  it('깨진 줄은 건너뛰고 센다 — 조용히 줄어든 대화는 거짓이다', () => {
    const file = transcriptPath(tmp(), 'x');
    appendRecord(file, user(1, 'a'));
    appendFileSync(file, '{깨진\n{"v":2,"turn":9}\n');
    appendRecord(file, user(2, 'b'));
    const loaded = readTranscript(file);
    assert.deepEqual(loaded.records.map((r) => r.turn), [1, 2]);
    assert.equal(loaded.broken, 2);
  });

  it('아직 없는 기록은 빈 대화다 — 던지지 않는다', () => {
    assert.deepEqual(readTranscript(path.join(tmp(), 'none.jsonl')), { records: [], broken: 0 });
  });

  it('스크래치는 HS_ORC_SCRATCH 안에 폴더를 만들고, project 는 만들지 않는다', () => {
    const root = tmp();
    const scratch = prepareSession('scratch', '/unused', { HS_ORC_SCRATCH: root });
    assert.equal(path.dirname(scratch.dir), root);
    assert.ok(existsSync(scratch.dir));
    assert.equal(path.basename(scratch.dir), scratch.id);
    const project = prepareSession('project', '/some/project', { HS_ORC_SCRATCH: root });
    assert.equal(project.dir, '/some/project');
    assert.match(project.id, /^\d{4}-\d{4}-[0-9a-f]{3}$/);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test src/core/__tests__/transcript.test.ts`
Expected: FAIL — `Cannot find module '../transcript.ts'`

- [ ] **Step 3: 최소 구현**

```ts
// src/core/transcript.ts
/**
 * 대화 기록 (SPEC §6.4.1, D-031).
 *
 * **세션의 진실은 이 파일이다** — 엔진의 세션 파일이 아니다. 턴마다 벤더가 바뀌는 제품에서
 * 엔진 쪽 기록을 진실로 삼으면 교차 벤더 순간 대화가 끊긴다.
 * append-only JSONL. 결정 로그와 같은 규칙으로 읽는다: 깨진 줄은 건너뛰고 **센다**.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newDecisionId } from './decision-log.ts';

export type SessionKind = 'project' | 'scratch';
/** AO 어휘 (D-031). `blocked` 는 위임 승인 대기다 — 그 상태에서는 아무것도 자동으로 진행하지 않는다. */
export type SessionState = 'waiting_input' | 'working' | 'blocked';

/** 이어 붙일 수 있는 엔진 세션 (SPEC §3.8). resume 은 엔진·모델·effort 가 모두 같을 때만 한다. */
export interface EngineSessionRef {
  readonly engine: string;
  readonly modelId: string;
  readonly effort: string;
  readonly id: string;
}

export type TranscriptEntry =
  | { readonly kind: 'user'; readonly text: string }
  | {
      readonly kind: 'direct';
      readonly text: string;
      /** 지휘자가 제안한 행. 없으면 null — 행을 추측하지 않는다. */
      readonly suggest: string | null;
      /** 화면에 찍을 비용 한 줄. 말없이 도는 유료 호출은 없다 (D-026). */
      readonly cost: string;
      /** 분류 폴백이 돌았다는 사실 같은, 답보다 먼저 알려야 할 줄들. */
      readonly notes: readonly string[];
    }
  | {
      readonly kind: 'plan';
      readonly taskId: string;
      readonly title: string;
      readonly reason: string;
      readonly primary: string;
      readonly reviewer: string;
      readonly estimateUsd: number;
      readonly notes: readonly string[];
    }
  | { readonly kind: 'approval'; readonly approved: boolean; readonly write: boolean }
  | {
      readonly kind: 'result';
      readonly outcome: 'ok' | 'unverified' | 'wrong';
      readonly verdict: 'pass' | 'fail' | 'unknown';
      readonly text: string;
      readonly review: string;
      readonly evidence: string;
      readonly decisionId: string;
      readonly engineSession?: EngineSessionRef;
    }
  | { readonly kind: 'summary'; readonly text: string; readonly next: string }
  | { readonly kind: 'error'; readonly text: string };

export type TranscriptRecord = TranscriptEntry & { readonly v: 1; readonly at: string; readonly turn: number };

export function scratchRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env['HS_ORC_SCRATCH'] ?? path.join(os.homedir(), '.hs-orc', 'scratch');
}

export const transcriptPath = (dir: string, id: string): string =>
  path.join(dir, '.hs-orc', 'sessions', `${id}.jsonl`);

/** 세션 id 는 결정 로그와 같은 모양이다 — 두 기록을 사람이 눈으로 잇는다 (SPEC §6.4.1). */
export const newSessionId = (now = new Date()): string => newDecisionId(now);

/**
 * 세션 폴더를 정한다. scratch 는 **여기서 만든다** — 엔진이 cwd 를 요구한다.
 * project 는 만들지 않는다: 폴더 검증은 D-029 의 `validateProject` 가 이미 했다.
 */
export function prepareSession(
  kind: SessionKind,
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { dir: string; id: string } {
  const id = newSessionId();
  if (kind === 'project') return { dir: projectDir, id };
  const dir = path.join(scratchRoot(env), id);
  mkdirSync(dir, { recursive: true });
  return { dir, id };
}

export function appendRecord(file: string, record: TranscriptRecord): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

export interface LoadedTranscript {
  readonly records: TranscriptRecord[];
  /** 깨진 줄 수. 0 이 아니면 화면이 그 사실을 보여준다. */
  readonly broken: number;
}

export function readTranscript(file: string): LoadedTranscript {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { records: [], broken: 0 }; // 아직 없는 기록은 정상 상태다.
  }
  const records: TranscriptRecord[] = [];
  let broken = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as TranscriptRecord;
      if (parsed.v !== 1 || typeof parsed.turn !== 'number') {
        broken += 1;
        continue;
      }
      records.push(parsed);
    } catch {
      broken += 1;
    }
  }
  return { records, broken };
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test src/core/__tests__/transcript.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/core/transcript.ts src/core/__tests__/transcript.test.ts
git commit -m "feat(core): 대화 기록 — 세션의 진실은 append-only JSONL 이다 (D-031, SPEC §6.4.1)"
```

---

### Task 2: 지휘자 — 직접 답

**Files:**
- Create: `src/core/conductor.ts`
- Modify: `src/core/assign.ts:53` (`function resolveSlot` → `export function resolveSlot`)
- Test: `src/core/__tests__/conductor.test.ts`

**Interfaces:**
- Consumes: `resolveSlot(catalog: Engines, slot: Slot, effort: Effort, role: SlotRole): ResolvedSlot` (assign.ts), `SlotExecutor`·`SlotRun` (executor.ts)
- Produces:
  - `conductorSlot(catalog: Engines): ResolvedSlot` — haiku·low, **role `reviewer`**, label `지휘자·Haiku`
  - `buildDirectPrompt(matrix: Matrix, context: string, message: string): string`
  - `parseSuggest(matrix: Matrix, text: string): { body: string; suggest: string | null }`
  - `interface DirectAnswer { run: SlotRun; body: string; suggest: string | null }`
  - `directAnswer(conduct: SlotExecutor, slot: ResolvedSlot, matrix: Matrix, context: string, message: string): Promise<DirectAnswer>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// src/core/__tests__/conductor.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { buildDirectPrompt, conductorSlot, directAnswer, parseSuggest } from '../conductor.ts';
import type { SlotExecutor } from '../executor.ts';

const matrix = loadMatrix();
const catalog = loadEngines();

describe('지휘자 — 직접 답 (SPEC §6.4.2)', () => {
  it('Haiku·low 이고, 쓰기를 줄 수 없는 reviewer 자리로 뜬다', () => {
    const slot = conductorSlot(catalog);
    assert.equal(slot.model, 'haiku');
    assert.equal(slot.effort, 'low');
    assert.equal(slot.role, 'reviewer');
    assert.equal(slot.label, '지휘자·Haiku');
  });

  it('마지막 줄의 SUGGEST 만 제안으로 읽고 본문에서 뗀다', () => {
    assert.deepEqual(parseSuggest(matrix, '타입 수정 작업이다.\nSUGGEST: R01'), { body: '타입 수정 작업이다.', suggest: 'R01' });
  });

  it('NONE·없는 행·마지막 줄이 아닌 SUGGEST 는 제안이 아니다', () => {
    assert.equal(parseSuggest(matrix, '잡담\nSUGGEST: NONE').suggest, null);
    assert.equal(parseSuggest(matrix, '이상한 행\nSUGGEST: R99').suggest, null);
    const mid = parseSuggest(matrix, 'SUGGEST: R01\n그런데 한 줄 더');
    assert.equal(mid.suggest, null);
    assert.equal(mid.body, 'SUGGEST: R01\n그런데 한 줄 더');
  });

  it('프롬프트는 읽기 전용·결과 날조 금지·행 목록·최근 대화를 싣는다', () => {
    const prompt = buildDirectPrompt(matrix, '사용자: 앞 질문', '넌 누구니');
    assert.match(prompt, /파일을 고치거나 명령을 실행하지 않는다/);
    assert.match(prompt, /결과를 지어내지 않는다/);
    assert.match(prompt, /R01\t/);
    assert.match(prompt, /\[최근 대화\]\n사용자: 앞 질문/);
    assert.ok(prompt.endsWith('넌 누구니'));
  });

  it('맥락이 비면 [최근 대화] 절을 만들지 않는다', () => {
    assert.doesNotMatch(buildDirectPrompt(matrix, '', 'hi'), /최근 대화/);
  });

  it('실행기를 한 번 부르고 제안을 읽어 돌려준다', async () => {
    const prompts: string[] = [];
    const conduct: SlotExecutor = (_slot, prompt) => {
      prompts.push(prompt);
      return Promise.resolve({ ok: true, text: '안녕하세요.\nSUGGEST: NONE', rawStdout: '', rawStderr: '', durationMs: 1 });
    };
    const answer = await directAnswer(conduct, conductorSlot(catalog), matrix, '', '넌 누구니');
    assert.equal(prompts.length, 1);
    assert.equal(answer.body, '안녕하세요.');
    assert.equal(answer.suggest, null);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test src/core/__tests__/conductor.test.ts`
Expected: FAIL — `Cannot find module '../conductor.ts'`

- [ ] **Step 3: `resolveSlot` 를 export 하고 지휘자를 구현한다**

`src/core/assign.ts:53` 한 줄만 바꾼다:

```ts
export function resolveSlot(catalog: Engines, slot: Slot, effort: Effort, role: SlotRole): ResolvedSlot {
```

```ts
// src/core/conductor.ts
/**
 * 지휘자 (SPEC §6.4.2·§6.4.4, D-031).
 *
 * **라우팅을 하지 않는다.** 배정은 결정론 코드(pipeline)가 한다 — G1 을 모델 판단에 넘기지 않는다.
 * 지휘자가 하는 일은 둘뿐이다: 하한선·미분류 메시지에 **직접 답**하고, 위임 결과를 **요약**한다.
 * 모델은 Haiku·low 고정이다 (Q11 — 분류 폴백과 같은 계층).
 */
import type { Engines } from '../data/engines.ts';
import type { Matrix } from '../data/matrix.ts';
import { resolveSlot, type ResolvedSlot } from './assign.ts';
import type { SlotExecutor, SlotRun } from './executor.ts';

/**
 * role 을 `reviewer` 로 둔다 — `createExecutor` 가 **쓰기를 절대 주지 않는 자리**다.
 * 직접 답은 세션의 쓰기 스위치와 무관하게 읽기 전용이어야 하고(SPEC §6.4.2),
 * 그 강제를 호출자의 주의에 맡기지 않는다.
 */
export function conductorSlot(catalog: Engines): ResolvedSlot {
  return resolveSlot(
    catalog,
    { model: 'haiku', vendor: 'anthropic', efforts: ['low'], label: '지휘자·Haiku' },
    'low',
    'reviewer',
  );
}

export function buildDirectPrompt(matrix: Matrix, context: string, message: string): string {
  const rows = matrix.assignments.map((a) => `${a.id}\t${a.task}`).join('\n');
  return [
    '너는 hs-orc 의 지휘자다. 사용자와 대화로 짧게 답한다.',
    '규칙:',
    '- 파일을 고치거나 명령을 실행하지 않는다.',
    '- 개발 작업을 대신 수행하거나 그 결과를 지어내지 않는다. 작업 요청이면 무엇을 하게 될지 한두 문장으로 말하고, 아래 업무 목록에서 맞는 행을 제안한다.',
    '- 마지막 줄은 반드시 `SUGGEST: <행 id>` 또는 `SUGGEST: NONE` 이다.',
    '',
    '[업무 목록]',
    rows,
    ...(context ? ['', '[최근 대화]', context] : []),
    '',
    '[이번 메시지]',
    message,
  ].join('\n');
}

const SUGGEST_LINE = /^SUGGEST:\s*(R\d{2}|NONE)\s*$/i;

/**
 * **마지막 줄만** 읽는다 — reviewer 판정(`parseVerdict`)과 같은 규칙이다.
 * 본문 중간의 SUGGEST 는 제안이 아니다. 없는 행 id 는 버린다 — 행을 추측하지 않는다.
 */
export function parseSuggest(matrix: Matrix, text: string): { body: string; suggest: string | null } {
  const lines = text.trimEnd().split('\n');
  const match = SUGGEST_LINE.exec(lines.at(-1)?.trim() ?? '');
  if (!match) return { body: text.trim(), suggest: null };
  const id = (match[1] ?? 'NONE').toUpperCase();
  const known = matrix.assignments.some((a) => a.id === id);
  return { body: lines.slice(0, -1).join('\n').trim(), suggest: id !== 'NONE' && known ? id : null };
}

export interface DirectAnswer {
  readonly run: SlotRun;
  readonly body: string;
  readonly suggest: string | null;
}

export async function directAnswer(
  conduct: SlotExecutor,
  slot: ResolvedSlot,
  matrix: Matrix,
  context: string,
  message: string,
): Promise<DirectAnswer> {
  const run = await conduct(slot, buildDirectPrompt(matrix, context, message));
  return { run, ...parseSuggest(matrix, run.text) };
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test src/core/__tests__/conductor.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/core/conductor.ts src/core/assign.ts src/core/__tests__/conductor.test.ts
git commit -m "feat(core): 지휘자 직접 답 — Haiku·low, 읽기 전용, SUGGEST 는 마지막 줄만 (Q11, SPEC §6.4.2)"
```

---

### Task 3: 대화 세션 — 메시지 1건 (가장 작은 end-to-end)

**Files:**
- Create: `src/core/session.ts`
- Test: `src/core/__tests__/session.test.ts`

**Interfaces:**
- Consumes: Task 1 `transcript.ts` 전부, Task 2 `conductorSlot`·`directAnswer`, `routeWithFallback(matrix, catalog, task, options)` (pipeline.ts — options: `cwd`, `classifyLlm`, `taskId`), `Budget.charge(label, actualUsd, estimateUsd, meteredUsd, plan)`·`countTokens(usage)`·`limitReached()`·`summary()`, `estimateUsd(matrix, slot)`, `Journal`
- Produces:
  - `class SessionStateError extends Error`
  - `interface SessionDeps { matrix; catalog; kind: SessionKind; dir: string; id: string; budget: Budget; journal: Journal; conduct: SlotExecutor; executorFor: (write: boolean) => SlotExecutor; classifyLlm?: boolean; context?: ContextLimits; now?: () => Date }` — `ContextLimits` 는 Task 4 에서 생긴다. **이 Task 에서는 `context?` 필드를 넣지 않는다**(Task 4 가 추가).
  - `class ConversationSession { constructor(deps); readonly file; get state(); get kind(); get dir(); get id(); records(); send(message): Promise<TranscriptRecord[]>; planAs(taskId): Promise<TranscriptRecord[]> }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// src/core/__tests__/session.test.ts
/**
 * 대화 세션 (SPEC §6.4). 실행기는 전부 가짜다 — 이 파일이 돈을 쓰면 아무도 안 돌린다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { Budget } from '../budget.ts';
import { Journal } from '../journal.ts';
import type { SlotExecutor, SlotRun } from '../executor.ts';
import { ConversationSession, SessionStateError } from '../session.ts';

const matrix = loadMatrix();
const catalog = loadEngines();
const reply = (text: string, ok = true): SlotRun => ({ ok, text, rawStdout: '', rawStderr: '', durationMs: 1 });

/** 지휘자 가짜: 요약 요청이면 요약을, 아니면 직접 답을 준다. */
const conductSpy = (direct = '저는 hs-orc 입니다.\nSUGGEST: NONE', ok = true) => {
  const prompts: string[] = [];
  const exec: SlotExecutor = (_slot, prompt) => {
    prompts.push(prompt);
    return Promise.resolve(reply(prompt.startsWith('아래 위임 결과') ? '요약 한 줄' : direct, ok));
  };
  return { exec, prompts };
};

/** 위임 가짜: reviewer(Haiku) 는 PASS, primary 는 받은 프롬프트를 되돌린다. */
const delegateSpy = () => {
  const calls: { label: string; prompt: string }[] = [];
  const exec: SlotExecutor = (slot, prompt) => {
    calls.push({ label: slot.label, prompt });
    return Promise.resolve(reply(slot.label === 'Haiku' ? 'PASS' : `ran:${prompt}`));
  };
  return { exec, calls };
};

const make = (conduct: SlotExecutor, dir = mkdtempSync(path.join(os.tmpdir(), 'hs-session-')), execute = delegateSpy().exec) => {
  const budget = new Budget(20, 2_000_000);
  const session = new ConversationSession({
    matrix, catalog, kind: 'project', dir, id: '0923-1200-aaa',
    budget, journal: new Journal(), conduct, executorFor: () => execute, classifyLlm: false,
  });
  return { session, budget, dir };
};

describe('대화 세션 — 메시지 1건 (SPEC §6.4.2)', () => {
  it('분류되는 메시지는 배정을 남기고 승인 대기로 멈춘다 — 지휘자를 부르지 않는다', async () => {
    const c = conductSpy();
    const { session } = make(c.exec);
    const out = await session.send('이 타입 에러 고쳐줘');
    assert.deepEqual(out.map((r) => r.kind), ['user', 'plan']);
    const plan = out[1];
    assert.ok(plan?.kind === 'plan' && /^R\d{2}$/.test(plan.taskId));
    assert.equal(session.state, 'blocked');
    assert.equal(c.prompts.length, 0);
  });

  it('분류되지 않는 메시지는 지휘자가 직접 답하고 비용을 남긴다 — 승인 없이', async () => {
    const c = conductSpy();
    const { session, budget } = make(c.exec);
    const out = await session.send('넌 누구니');
    assert.deepEqual(out.map((r) => r.kind), ['user', 'direct']);
    const direct = out[1];
    assert.ok(direct?.kind === 'direct');
    assert.equal(direct.text, '저는 hs-orc 입니다.');
    assert.equal(direct.suggest, null);
    assert.equal(session.state, 'waiting_input');
    assert.equal(budget.charges[0]?.label, '지휘자·Haiku·low');
  });

  it('제안된 행을 고르면 같은 메시지로 배정을 받는다 — 새 메시지를 만들지 않는다', async () => {
    const c = conductSpy('타입 수정 요청으로 보인다.\nSUGGEST: R01');
    const { session } = make(c.exec);
    const first = await session.send('넌 누구니');
    assert.ok(first[1]?.kind === 'direct' && first[1].suggest === 'R01');
    const out = await session.planAs('R01');
    assert.deepEqual(out.map((r) => r.kind), ['plan']);
    assert.ok(out[0]?.kind === 'plan' && out[0].taskId === 'R01');
    assert.equal(session.records().filter((r) => r.kind === 'user').length, 1);
    assert.equal(session.state, 'blocked');
  });

  it('직접 답이 실패하면 사유를 남기고 입력 대기로 돌아간다 — 조용히 삼키지 않는다', async () => {
    const { session } = make(conductSpy('', false).exec);
    const out = await session.send('넌 누구니');
    assert.deepEqual(out.map((r) => r.kind), ['user', 'error']);
    assert.equal(session.state, 'waiting_input');
  });

  it('승인 대기 중에는 새 메시지를 받지 않는다', async () => {
    const { session } = make(conductSpy().exec);
    await session.send('이 타입 에러 고쳐줘');
    await assert.rejects(session.send('또'), SessionStateError);
  });

  it('다시 열면 턴을 이어 가고, 남은 배정은 되살리지 않는다', async () => {
    const c = conductSpy();
    const { dir } = make(c.exec);
    const first = make(c.exec, dir).session;
    await first.send('이 타입 에러 고쳐줘');
    const reopened = make(c.exec, dir).session;
    assert.equal(reopened.state, 'waiting_input');
    await reopened.send('넌 누구니');
    assert.equal(reopened.records().at(-1)?.turn, 2);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test src/core/__tests__/session.test.ts`
Expected: FAIL — `Cannot find module '../session.ts'`

- [ ] **Step 3: 최소 구현**

```ts
// src/core/session.ts
/**
 * 대화 세션 (SPEC §6.4, D-031). **헤드리스다** — 셸은 이것을 부르고 기록을 그린다.
 * 셸마다 따로 두면 같은 메시지에 셸마다 다르게 답한다 (D-026 전례).
 *
 * 메시지 1건: 기록 → 라우팅(결정론 파이프라인 그대로) → 배정이면 승인 대기(`blocked`),
 * 아니면 지휘자 직접 답. 다음 위임을 **스스로 시작하지 않는다** (D-015).
 */
import type { Engines } from '../data/engines.ts';
import type { Matrix } from '../data/matrix.ts';
import type { Budget } from './budget.ts';
import { conductorSlot, directAnswer } from './conductor.ts';
import { estimateUsd, type SlotExecutor } from './executor.ts';
import type { Journal } from './journal.ts';
import { routeWithFallback } from './pipeline.ts';
import {
  appendRecord,
  readTranscript,
  transcriptPath,
  type SessionKind,
  type SessionState,
  type TranscriptEntry,
  type TranscriptRecord,
} from './transcript.ts';

export class SessionStateError extends Error {
  override name = 'SessionStateError';
}

export interface SessionDeps {
  readonly matrix: Matrix;
  readonly catalog: Engines;
  readonly kind: SessionKind;
  readonly dir: string;
  readonly id: string;
  /** 세션을 여러 개 열어도 누적 상한은 하나다 (D-030) — 셸이 같은 Budget 을 넘긴다. */
  readonly budget: Budget;
  readonly journal: Journal;
  /** 직접 답·요약 전용. 지휘자 슬롯이 reviewer 자리라 쓰기는 어차피 붙지 않는다. */
  readonly conduct: SlotExecutor;
  /** 위임 실행기. 쓰기 여부는 승인 때 정해진다 (D-025). */
  readonly executorFor: (write: boolean) => SlotExecutor;
  /** D-026: 끄면 유료 분류 폴백이 없다. 테스트는 끈다. */
  readonly classifyLlm?: boolean;
  readonly now?: () => Date;
}

const why = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class ConversationSession {
  readonly file: string;
  private readonly deps: SessionDeps;
  private turn: number;
  private stateValue: SessionState = 'waiting_input';

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.file = transcriptPath(deps.dir, deps.id);
    // 다시 열면 턴 번호를 이어 간다. 끝에 승인 안 된 배정이 남아 있어도 **되살리지 않는다** —
    // 그 사이 비용·폴더가 바뀌었을 수 있다. 화면은 그 카드를 보여주되 승인 버튼은 없다.
    this.turn = readTranscript(this.file).records.reduce((max, r) => Math.max(max, r.turn), 0);
  }

  get state(): SessionState {
    return this.stateValue;
  }
  get kind(): SessionKind {
    return this.deps.kind;
  }
  get dir(): string {
    return this.deps.dir;
  }
  get id(): string {
    return this.deps.id;
  }

  records(): TranscriptRecord[] {
    return readTranscript(this.file).records;
  }

  async send(message: string): Promise<TranscriptRecord[]> {
    this.require('waiting_input', '메시지 전송');
    const text = message.trim();
    if (!text) return [];
    this.turn += 1;
    const user = this.append({ kind: 'user', text });
    return [user, ...(await this.route(text))];
  }

  /** 제안된 행(또는 사용자가 고른 행)으로 **마지막 메시지**의 배정을 받는다. 새 메시지를 만들지 않는다. */
  async planAs(taskId: string): Promise<TranscriptRecord[]> {
    this.require('waiting_input', '행 지정');
    const last = this.records().findLast((r) => r.kind === 'user');
    if (last?.kind !== 'user') throw new SessionStateError('배정할 메시지가 없다.');
    return this.route(last.text, taskId);
  }

  private append(entry: TranscriptEntry): TranscriptRecord {
    const record = { ...entry, v: 1, at: (this.deps.now?.() ?? new Date()).toISOString(), turn: this.turn } as TranscriptRecord;
    appendRecord(this.file, record);
    return record;
  }

  private require(state: SessionState, action: string): void {
    if (this.stateValue !== state) {
      throw new SessionStateError(`${action}은(는) ${state} 상태에서만 한다 (지금: ${this.stateValue}).`);
    }
  }

  private async route(text: string, taskId?: string): Promise<TranscriptRecord[]> {
    const { matrix, catalog, dir } = this.deps;
    const routed = await routeWithFallback(matrix, catalog, text, {
      cwd: dir,
      ...(this.deps.classifyLlm === undefined ? {} : { classifyLlm: this.deps.classifyLlm }),
      ...(taskId ? { taskId } : {}),
    });
    const notes = routed.fallback ? [routed.fallback.line] : [];
    const result = routed.result;
    if (result.stage !== 'assigned') return this.answer(text, notes);

    const { plan } = result;
    const { primary, reviewer } = plan.slots;
    this.stateValue = 'blocked';
    return [
      this.append({
        kind: 'plan',
        taskId: plan.assignment.id,
        title: plan.assignment.task,
        reason: result.reason,
        primary: `${primary.label}·${primary.effort} → ${primary.engine}/${primary.modelId}`,
        reviewer: `${reviewer.label}·${reviewer.effort} → ${reviewer.engine}/${reviewer.modelId}`,
        estimateUsd: plan.cost.totalUsd,
        notes,
      }),
    ];
  }

  private async answer(text: string, notes: readonly string[]): Promise<TranscriptRecord[]> {
    const { matrix, catalog, budget, conduct } = this.deps;
    if (budget.limitReached()) {
      return [this.append({ kind: 'error', text: `누적 상한에 닿아 직접 답도 시작하지 않는다 (${budget.summary()}).` })];
    }
    const slot = conductorSlot(catalog);
    this.stateValue = 'working';
    try {
      const answer = await directAnswer(conduct, slot, matrix, '', text);
      const charge = budget.charge(`${slot.label}·${slot.effort}`, answer.run.actualUsd, estimateUsd(matrix, slot), answer.run.meteredUsd, slot.plan);
      budget.countTokens(answer.run.usage);
      if (!answer.run.ok) {
        return [this.append({ kind: 'error', text: `직접 답을 받지 못했다: ${answer.run.text || '엔진이 실패했다'}` })];
      }
      return [
        this.append({
          kind: 'direct',
          text: answer.body,
          suggest: answer.suggest,
          cost: `$${charge.usd.toFixed(4)} ${charge.source}`,
          notes,
        }),
      ];
    } catch (error) {
      return [this.append({ kind: 'error', text: `직접 답을 받지 못했다: ${why(error)}` })];
    } finally {
      this.stateValue = 'waiting_input';
    }
  }
}
```

> 승인 대기 중인 배정(`pending`)은 Task 6 에서 붙는다 — `noUnusedLocals` 가 켜져 있어 읽히지 않는 private 필드를 지금 두면 type-check 가 실패한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test src/core/__tests__/session.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 게이트 후 커밋**

Run: `npm run type-check && npm run lint`
Expected: 오류 없음

```bash
git add src/core/session.ts src/core/__tests__/session.test.ts
git commit -m "feat(core): 대화 세션 — 메시지는 배정(승인 대기) 또는 직접 답으로 끝난다 (G6, SPEC §6.4.2)"
```

---

### Task 4: 맥락 전달 — 최근 N턴, 분류 폴백 hint

**Files:**
- Create: `src/core/context.ts`
- Modify: `src/data/limits.ts` (Limits 에 두 키), `data/limits.json`, `src/core/classify-llm.ts` (`buildClassifyPrompt`·`classifyWithModel` 에 `hint`), `src/core/pipeline.ts` (`FallbackOptions.hint` 전달), `src/core/session.ts` (맥락·hint 사용)
- Test: `src/core/__tests__/context.test.ts`, `src/core/__tests__/classify-llm.test.ts` (1건 추가), `src/core/__tests__/session.test.ts` (1건 추가)

**Interfaces:**
- Consumes: `TranscriptRecord` (Task 1)
- Produces:
  - `interface ContextLimits { contextTurns: number; contextChars: number }`
  - `buildContext(records: readonly TranscriptRecord[], limits: ContextLimits, range: { before: number; after?: number }): string` — `turn` 이 `after < turn < before` 인 `user`·`direct`·`summary` 만
  - `lastSummary(records): string | null`
  - `Limits.contextTurns`, `Limits.contextChars`
  - `buildClassifyPrompt(matrix, task, hint?: string)`, `classifyWithModel(..., { hint?: string })`, `FallbackOptions.hint?: string`
  - `SessionDeps.context?: ContextLimits` (없으면 `loadLimits()` 값)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// src/core/__tests__/context.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, lastSummary } from '../context.ts';
import type { TranscriptRecord } from '../transcript.ts';

const at = '2026-09-23T00:00:00.000Z';
const records: TranscriptRecord[] = [
  { v: 1, at, turn: 1, kind: 'user', text: '넌 누구니' },
  { v: 1, at, turn: 1, kind: 'direct', text: 'hs-orc 다', suggest: null, cost: '$0', notes: [] },
  { v: 1, at, turn: 2, kind: 'user', text: '타입 고쳐줘' },
  { v: 1, at, turn: 2, kind: 'plan', taskId: 'R01', title: 't', reason: 'r', primary: 'p', reviewer: 'v', estimateUsd: 1, notes: [] },
  { v: 1, at, turn: 2, kind: 'result', outcome: 'ok', verdict: 'pass', text: '엔진 원문 긴 출력', review: '', evidence: 'e', decisionId: 'd' },
  { v: 1, at, turn: 2, kind: 'summary', text: '타입을 고쳤다\n둘째 줄', next: '' },
  { v: 1, at, turn: 3, kind: 'user', text: '지금 메시지' },
];
const wide = { contextTurns: 6, contextChars: 6000 };

describe('맥락 자르기 (SPEC §6.4.3)', () => {
  it('user·direct·summary 만 싣고 엔진 원문·배정·결과는 싣지 않는다', () => {
    const text = buildContext(records, wide, { before: 3 });
    assert.match(text, /사용자: 넌 누구니/);
    assert.match(text, /orc: hs-orc 다/);
    assert.match(text, /orc\(위임 결과 요약\): 타입을 고쳤다/);
    assert.doesNotMatch(text, /엔진 원문/);
    assert.doesNotMatch(text, /지금 메시지/);
  });

  it('최근 N턴만 싣는다', () => {
    const text = buildContext(records, { contextTurns: 1, contextChars: 6000 }, { before: 3 });
    assert.doesNotMatch(text, /넌 누구니/);
    assert.match(text, /타입 고쳐줘/);
  });

  it('글자 상한을 넘으면 앞을 자르고 잘렸다고 표시한다', () => {
    const text = buildContext(records, { contextTurns: 6, contextChars: 20 }, { before: 3 });
    assert.equal(text.length, 20);
    assert.ok(text.startsWith('…'));
  });

  it('after 이후 턴만 고른다 — resume 한 엔진은 그 뒤 대화만 받는다', () => {
    const text = buildContext(records, wide, { before: 3, after: 1 });
    assert.doesNotMatch(text, /넌 누구니/);
    assert.match(text, /타입 고쳐줘/);
  });

  it('직전 요약의 첫 줄을 돌려준다', () => {
    assert.equal(lastSummary(records), '타입을 고쳤다');
    assert.equal(lastSummary(records.slice(0, 2)), null);
  });
});
```

`src/core/__tests__/classify-llm.test.ts` 의 기존 `describe` 안에 추가:

```ts
  it('hint 가 있으면 직전 맥락을 작업 앞에 한 줄로 싣는다 — 없으면 싣지 않는다', () => {
    const withHint = buildClassifyPrompt(matrix, '그거 테스트도', '타입 에러를 고쳤다');
    assert.match(withHint, /직전 맥락: 타입 에러를 고쳤다\n작업: 그거 테스트도$/);
    assert.doesNotMatch(buildClassifyPrompt(matrix, '그거 테스트도'), /직전 맥락/);
  });
```

(`matrix`·`buildClassifyPrompt` 가 그 파일에 import 돼 있지 않으면 `import { loadMatrix } from '../../data/matrix.ts'` · `const matrix = loadMatrix();` · `import { buildClassifyPrompt } from '../classify-llm.ts'` 를 추가한다.)

`src/core/__tests__/session.test.ts` 의 `describe` 안에 추가:

```ts
  it('다음 직접 답에 앞 턴 대화를 싣는다 (G7)', async () => {
    const c = conductSpy();
    const { session } = make(c.exec);
    await session.send('넌 누구니');
    await session.send('뭘 할 수 있어');
    assert.match(c.prompts[1] ?? '', /\[최근 대화\]\n사용자: 넌 누구니\norc: 저는 hs-orc 입니다\./);
    assert.doesNotMatch(c.prompts[1] ?? '', /\[최근 대화\][^[]*뭘 할 수 있어/);
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test src/core/__tests__/context.test.ts src/core/__tests__/classify-llm.test.ts src/core/__tests__/session.test.ts`
Expected: FAIL — `context.ts` 없음, hint 테스트 실패, 세션 맥락 테스트 실패

- [ ] **Step 3: 구현**

```ts
// src/core/context.ts
/**
 * 맥락 자르기 (SPEC §6.4.3).
 * rolling 요약은 두지 않는다 — 최근 N턴 자르기로 시작하고, 부족하다는 실측이 나오면 연다.
 * 엔진 원시 출력(`result` 본문)은 싣지 않는다. 요약이 그 자리를 대신한다.
 */
import type { TranscriptRecord } from './transcript.ts';

export interface ContextLimits {
  readonly contextTurns: number;
  readonly contextChars: number;
}

function line(r: TranscriptRecord): string | null {
  switch (r.kind) {
    case 'user':
      return `사용자: ${r.text}`;
    case 'direct':
      return `orc: ${r.text}`;
    case 'summary':
      return r.text ? `orc(위임 결과 요약): ${r.text}${r.next ? ` · 다음 제안: ${r.next}` : ''}` : null;
    default:
      return null;
  }
}

export function buildContext(
  records: readonly TranscriptRecord[],
  limits: ContextLimits,
  range: { readonly before: number; readonly after?: number },
): string {
  const after = range.after ?? 0;
  const picked = records.filter((r) => r.turn < range.before && r.turn > after && line(r) !== null);
  const turns = new Set([...new Set(picked.map((r) => r.turn))].slice(-limits.contextTurns));
  const text = picked
    .filter((r) => turns.has(r.turn))
    .map(line)
    .join('\n');
  return text.length <= limits.contextChars ? text : `…${text.slice(-(limits.contextChars - 1))}`;
}

/** 분류 폴백 hint (SPEC §6.4.2). 규칙 분류기에는 섞지 않는다 — G1. */
export function lastSummary(records: readonly TranscriptRecord[]): string | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i];
    if (r?.kind === 'summary' && r.text) return r.text.split('\n')[0] ?? null;
  }
  return null;
}
```

`src/data/limits.ts` 의 `Limits` 에 추가:

```ts
  /** 대화 세션이 프롬프트에 싣는 최근 턴 수 (SPEC §6.4.3). */
  readonly contextTurns: number;
  /** 그 맥락의 글자 상한. 넘으면 앞을 자른다. */
  readonly contextChars: number;
```

`data/limits.json` 에 추가 (`tokenBudgetRationale` 뒤):

```json
  "contextTurns": 6,
  "contextChars": 6000,
  "contextRationale": "대화 세션 맥락 (SPEC §6.4.3, D-031). rolling 요약 없이 최근 N턴 자르기로 시작한다. 엔진 원문은 싣지 않으므로 6턴·6000자면 요약·질문 수준의 대화가 들어간다."
```

`src/core/classify-llm.ts`:

```ts
export function buildClassifyPrompt(matrix: Matrix, task: string, hint?: string): string {
  const rows = matrix.assignments.map((a) => `${a.id}\t${a.task}`).join('\n');
  return [
    '아래 업무 목록 중 주어진 작업에 가장 맞는 행의 id 하나만 출력하라.',
    '설명·문장부호 없이 id만. 맞는 행이 없으면 NONE 만 출력하라.',
    '',
    rows,
    '',
    // 대화 세션의 후속 메시지("그거 테스트도")는 앞 맥락 없이는 분류가 안 된다 (SPEC §6.4.2).
    ...(hint ? [`직전 맥락: ${hint}`] : []),
    `작업: ${task}`,
  ].join('\n');
}
```

`classifyWithModel` 의 options 타입에 `hint?: string;` 을 더하고 프롬프트 줄을 바꾼다:

```ts
    prompt: buildClassifyPrompt(matrix, task, options.hint),
```

`src/core/pipeline.ts` 의 `FallbackOptions` 에 추가:

```ts
  /** 대화 세션의 직전 요약 한 줄 (SPEC §6.4.2). **LLM 폴백에만** 간다 — 규칙 분류기에는 섞지 않는다. */
  readonly hint?: string;
```

`routeWithFallback` 의 `classifyWithModel` 호출을 바꾼다:

```ts
    const guessed = await classifyWithModel(matrix, catalog, task, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.hint === undefined ? {} : { hint: options.hint }),
    });
```

`src/core/session.ts`:
- import 추가: `import { loadLimits } from '../data/limits.ts';` · `import { buildContext, lastSummary, type ContextLimits } from './context.ts';`
- `SessionDeps` 에 `readonly context?: ContextLimits;` 추가
- 클래스에 헬퍼 추가:

```ts
  private get contextLimits(): ContextLimits {
    return this.deps.context ?? loadLimits();
  }
```

- `route()` 의 `routeWithFallback` 옵션에 hint 를 싣는다 (행을 직접 고른 경우는 분류를 안 하므로 싣지 않는다):

```ts
    const hint = taskId ? null : lastSummary(this.records());
    const routed = await routeWithFallback(matrix, catalog, text, {
      cwd: dir,
      ...(this.deps.classifyLlm === undefined ? {} : { classifyLlm: this.deps.classifyLlm }),
      ...(taskId ? { taskId } : {}),
      ...(hint ? { hint } : {}),
    });
```

- `answer()` 의 `directAnswer(conduct, slot, matrix, '', text)` 를 맥락을 싣게 바꾼다:

```ts
      const context = buildContext(this.records(), this.contextLimits, { before: this.turn });
      const answer = await directAnswer(conduct, slot, matrix, context, text);
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test src/core/__tests__/context.test.ts src/core/__tests__/classify-llm.test.ts src/core/__tests__/session.test.ts`
Expected: PASS

- [ ] **Step 5: 게이트 후 커밋**

Run: `npm run gate`
Expected: 전부 통과 (`Limits` 를 리터럴로 만드는 테스트가 있으면 두 키를 채운다)

```bash
git add src/core/context.ts src/core/__tests__/context.test.ts src/data/limits.ts data/limits.json src/core/classify-llm.ts src/core/pipeline.ts src/core/session.ts src/core/__tests__/classify-llm.test.ts src/core/__tests__/session.test.ts
git commit -m "feat(core): 맥락 전달 — 최근 6턴·6000자, 분류 폴백에만 직전 요약 hint (G7, SPEC §6.4.3)"
```

---

### Task 5: 위임 실행을 Core 로 내린다 (`delegate.ts`)

**Files:**
- Create: `src/core/delegate.ts`
- Modify: `src/shell/gui/service.ts` (`run()` 이 `delegate()` 를 부른다, 안 쓰게 된 import 제거)
- Test: `src/core/__tests__/delegate.test.ts` (기존 `src/shell/gui/__tests__/service.test.ts` 가 동작 보존을 증명한다)

**Interfaces:**
- Consumes: `firstLine(matrix, plan, task, reason)`·`secondLine(first, outcome, verified)` (decide.ts), `appendDecision`, `runDuo(matrix, plan, execute, task, budget, options?)`, `collect`, `runCommand`·`changedFiles`, `storeRun`·`runStoreRoot`, `reportError`, `Journal.append/records`
- Produces:
  - `interface DelegateInput { matrix; plan: AssignmentPlan; reason: string; title: string; prompt: string; verify: readonly string[]; cwd: string; execute: SlotExecutor; budget: Budget; journal: Journal; note?: string }`
  - `interface Delegated { ok: boolean; text: string; outcome: 'ok' | 'unverified' | 'wrong'; report: EvidenceReport; verdict: Verdict; review?: string; decisionId: string }`
  - `delegate(input: DelegateInput): Promise<Delegated>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// src/core/__tests__/delegate.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMatrix } from '../../data/matrix.ts';
import { loadEngines } from '../../data/engines.ts';
import { assign } from '../assign.ts';
import { Budget } from '../budget.ts';
import { readDecisions } from '../decision-log.ts';
import { delegate } from '../delegate.ts';
import type { SlotExecutor } from '../executor.ts';
import { Journal } from '../journal.ts';

const matrix = loadMatrix();
const catalog = loadEngines();
const row = (id: string) => matrix.assignments.find((a) => a.id === id)!;

describe('위임 1건 (SPEC §4 5~7단계)', () => {
  it('결정 로그에는 사용자 문장을, 엔진에는 맥락이 붙은 프롬프트를 보내고 note 로 세션을 잇는다', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-delegate-'));
    const log = path.join(dir, 'log.jsonl');
    process.env['HS_ORC_DECISION_LOG'] = log;
    process.env['HS_ORC_RUN_STORE'] = path.join(dir, 'runs');
    const prompts: string[] = [];
    const execute: SlotExecutor = (slot, prompt) => {
      prompts.push(prompt);
      return Promise.resolve({ ok: true, text: slot.label === 'Haiku' ? 'PASS' : 'ran', rawStdout: '', rawStderr: '', durationMs: 1 });
    };

    const d = await delegate({
      matrix, plan: assign(matrix, catalog, row('R01')), reason: '수동 지정 R01',
      title: '타입 고쳐줘', prompt: '[최근 대화]\n사용자: 앞\n\n[이번 요청]\n타입 고쳐줘',
      verify: [], cwd: process.cwd(), execute, budget: new Budget(20, 2_000_000), journal: new Journal(),
      note: 'session 0923-1200-aaa',
    });

    const lines = readDecisions(log).filter((r) => r.id === d.decisionId);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.task, '타입 고쳐줘');
    assert.match(lines[0]?.note ?? '', / · session 0923-1200-aaa$/);
    assert.match(prompts[0] ?? '', /^\[최근 대화\]/);
    assert.equal(d.outcome, 'unverified');
    assert.equal(d.verdict, 'pass');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test src/core/__tests__/delegate.test.ts`
Expected: FAIL — `Cannot find module '../delegate.ts'`

- [ ] **Step 3: `GuiService.run` 의 본문을 옮긴다**

```ts
// src/core/delegate.ts
/**
 * 위임 1건 실행 (SPEC §4 의 5~7단계). **배정이 끝난 뒤의 모든 것**이다:
 * 결정 로그 1차 → 두 슬롯 → 원시 로그 → 증거 → journal → 결정 로그 2차.
 *
 * 원래 `GuiService.run` 안(셸)에 있었다. 대화 세션(Core)이 같은 일을 해야 해서 내려왔다 —
 * 두 곳에 두면 증거·로그 규칙이 갈린다.
 */
import type { Matrix } from '../data/matrix.ts';
import type { AssignmentPlan } from './assign.ts';
import type { Budget } from './budget.ts';
import { appendDecision } from './decision-log.ts';
import { firstLine, secondLine } from './decide.ts';
import { runDuo, type Verdict } from './duo.ts';
import { collect, type Evidence, type EvidenceReport } from './evidence.ts';
import { changedFiles, runCommand } from './evidence-gather.ts';
import type { SlotExecutor } from './executor.ts';
import type { Journal } from './journal.ts';
import { reportError } from './report.ts';
import { runStoreRoot, storeRun } from './run-store.ts';

export interface DelegateInput {
  readonly matrix: Matrix;
  readonly plan: AssignmentPlan;
  readonly reason: string;
  /** 결정 로그에 남는 작업 문장 — 사용자가 쓴 그대로다. */
  readonly title: string;
  /** 엔진에 보내는 프롬프트. 대화 세션은 맥락을 붙여 넘긴다 (SPEC §6.4.3). */
  readonly prompt: string;
  readonly verify: readonly string[];
  readonly cwd: string;
  readonly execute: SlotExecutor;
  readonly budget: Budget;
  readonly journal: Journal;
  /** 결정 로그 1차 `note` 끝에 붙인다 — 세션 id 로 대화 기록과 잇는다 (SPEC §8). */
  readonly note?: string;
}

export interface Delegated {
  readonly ok: boolean;
  readonly text: string;
  readonly outcome: 'ok' | 'unverified' | 'wrong';
  readonly report: EvidenceReport;
  readonly verdict: Verdict;
  readonly review?: string;
  readonly decisionId: string;
}

export async function delegate(input: DelegateInput): Promise<Delegated> {
  const { matrix, plan, budget, journal } = input;
  const slot = plan.slots.primary;
  // 1차 결정 로그 — 배정을 확정한 이 시점에 남긴다 (SPEC §8).
  const first = firstLine(matrix, plan, input.title, input.reason);
  const decision = input.note ? { ...first, note: `${first.note ?? ''} · ${input.note}` } : first;
  appendDecision(decision);

  // **두 슬롯을 실제로 돌린다** (D-009) — primary 만 돌리면 단일 엔진 선택기다.
  const duo = await runDuo(matrix, plan, input.execute, input.prompt, budget);
  const run = duo.primary;
  const charge = budget.charges.at(-1);

  let stored = '';
  try {
    stored = storeRun(decision.id, journal.records.length + 1, slot.label, {
      rawStdout: run.rawStdout,
      rawStderr: run.rawStderr,
      meta: { outcome: run.ok ? 'ok' : 'failed', durationMs: run.durationMs, modelId: slot.modelId, verdict: duo.verdict },
    }, runStoreRoot(input.cwd)).dir;
  } catch (error) {
    // catch 후 무동작 금지.
    process.stderr.write(`${reportError('run-store', 'persist', error).display}\n`);
  }

  const evidence: Evidence[] = [...duo.evidence, ...input.verify.filter((v) => v.trim()).map((v) => runCommand(v, input.cwd))];
  if (evidence.length > 0) evidence.push(changedFiles(input.cwd));
  const report = collect(plan.assignment, evidence);

  journal.append({
    index: journal.records.length + 1,
    unit: '실행',
    model: slot.label,
    effort: slot.effort,
    outcome: run.ok ? 'ok' : 'failed',
    evidence: `운영 기준: ${plan.assignment.operatingCriterion}`,
    change: run.text.slice(0, 200),
    // 증거가 모였을 때만 채운다. 빈 값은 "통과"가 아니라 "검증 안 함"이다.
    verification: report.satisfied ? report.summary : '',
    ...(charge ? { charge } : {}),
  });

  // 2차 — 같은 id 로 append. 증거가 모였을 때만 ok 다 (SPEC §5).
  const outcome = !run.ok ? 'wrong' : report.satisfied ? 'ok' : 'unverified';
  appendDecision(secondLine(decision, outcome, [stored && `원시 로그 ${stored}`, report.summary].filter(Boolean).join(' · ')));

  return {
    ok: run.ok,
    text: run.text,
    outcome,
    report,
    verdict: duo.verdict,
    ...(duo.review ? { review: duo.review.text.slice(0, 2000) } : {}),
    decisionId: decision.id,
  };
}
```

> `budget.charges.at(-1)` 은 reviewer 가 돌았으면 reviewer 의 charge 다 — **기존 동작 그대로 옮긴 것**이다. 이 계획에서 고치지 않는다 (Task 12 후속 목록에 올린다).

`src/shell/gui/service.ts` 의 `run()` 에서 `const slot = …` 부터 `return { ok: run.ok, … }` 까지를 아래로 바꾼다:

```ts
    const execute =
      this.execute ??
      createExecutor(loadEngines(), this.workdir, loadLimits().runTimeoutMs, { write: payload.write === true });
    const d = await delegate({
      matrix,
      plan: result.plan,
      reason: result.reason,
      title: payload.task,
      prompt: payload.task,
      verify: payload.verify,
      cwd: this.workdir,
      execute,
      budget: this.budget,
      journal: this.journal,
    });
    return {
      ok: d.ok,
      text: d.text,
      outcome: d.outcome,
      report: d.report,
      verdict: d.verdict,
      ...(d.review ? { review: d.review } : {}),
      budget: this.budget.summary(),
      journal: this.journal.render(),
    };
```

import 에 `import { delegate } from '../../core/delegate.ts';` 를 더하고, `npm run lint`·`npm run type-check` 가 미사용이라 보고하는 import(`runDuo`·`appendDecision`·`firstLine`·`secondLine`·`runStoreRoot`·`storeRun`·`collect`·`Evidence`·`changedFiles`·`runCommand`)를 지운다. `EvidenceReport`·`reportError` 는 다른 곳에서 쓰므로 남는다.

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test src/core/__tests__/delegate.test.ts src/shell/gui/__tests__/service.test.ts`
Expected: PASS — 기존 GUI S5 시나리오 테스트 전부 그대로 통과(동작 보존)

- [ ] **Step 5: 게이트 후 커밋**

Run: `npm run gate`

```bash
git add src/core/delegate.ts src/core/__tests__/delegate.test.ts src/shell/gui/service.ts
git commit -m "refactor(core): 위임 실행을 GuiService.run 에서 core/delegate 로 내린다 — 세션과 GUI 가 같은 규칙을 쓴다"
```

---

### Task 6: 승인·거절·결과 처리

**Files:**
- Modify: `src/core/conductor.ts` (요약 프롬프트·다음 제안), `src/core/session.ts` (`approve`·`reject`)
- Test: `src/core/__tests__/conductor.test.ts`, `src/core/__tests__/session.test.ts`

**Interfaces:**
- Consumes: Task 5 `delegate`·`Delegated`, `nextStage(done)`·`STAGE_LABEL` (ladder.ts), `Verdict` (duo.ts)
- Produces:
  - `buildSummaryPrompt(title: string, d: Pick<Delegated, 'text' | 'verdict' | 'outcome' | 'report'>): string` — 첫 줄이 `아래 위임 결과` 로 시작한다
  - `nextSuggestion(outcome: 'ok' | 'unverified' | 'wrong', verdict: Verdict): string`
  - `ConversationSession.approve(options?: { verify?: readonly string[]; write?: boolean }): Promise<TranscriptRecord[]>`
  - `ConversationSession.reject(): TranscriptRecord[]`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/core/__tests__/conductor.test.ts` 에 import `buildSummaryPrompt, nextSuggestion` 을 더하고 추가:

```ts
describe('지휘자 — 결과 처리 (SPEC §6.4.4)', () => {
  it('요약 프롬프트는 날조 금지와 판정·증거·outcome 을 싣는다', () => {
    const prompt = buildSummaryPrompt('타입 고쳐줘', {
      text: '고쳤다', verdict: 'pass', outcome: 'unverified',
      report: { satisfied: false, missing: [], rejected: [], accepted: [], summary: '증거 0/1' },
    });
    assert.ok(prompt.startsWith('아래 위임 결과'));
    assert.match(prompt, /지어내지 않는다/);
    assert.match(prompt, /\[reviewer 판정\] pass/);
    assert.match(prompt, /\[증거\] 증거 0\/1/);
    assert.match(prompt, /\[outcome\] unverified/);
  });

  it('검증된 통과면 다음 제안이 없다', () => {
    assert.equal(nextSuggestion('ok', 'pass'), '');
  });

  it('미검증·실패·FAIL 이면 사다리의 첫 단계를 코드가 제안한다 — 모델이 정하지 않는다', () => {
    for (const [outcome, verdict] of [['unverified', 'pass'], ['wrong', 'unknown'], ['ok', 'fail']] as const) {
      assert.match(nextSuggestion(outcome, verdict), /코드·로그·재현 조건 보강/);
    }
  });
});
```

`src/core/__tests__/session.test.ts` 의 import 에 `readDecisions` (`../decision-log.ts`) 를 더하고, 파일 위에 격리 헬퍼를 둔다:

```ts
const isolate = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hs-session-log-'));
  process.env['HS_ORC_DECISION_LOG'] = path.join(dir, 'log.jsonl');
  process.env['HS_ORC_RUN_STORE'] = path.join(dir, 'runs');
  return path.join(dir, 'log.jsonl');
};
```

그리고 새 `describe` 를 추가:

```ts
describe('대화 세션 — 승인·결과 처리 (SPEC §6.4.4)', () => {
  it('승인하면 두 슬롯을 돌리고 결과·요약을 남긴 뒤 입력 대기로 돌아간다', async () => {
    const log = isolate();
    const d = delegateSpy();
    const { session } = make(conductSpy().exec, undefined, d.exec);
    await session.send('이 타입 에러 고쳐줘');
    const out = await session.approve();
    assert.deepEqual(out.map((r) => r.kind), ['approval', 'result', 'summary']);
    assert.equal(session.state, 'waiting_input');
    assert.equal(d.calls.length, 2);
    const result = out[1];
    assert.ok(result?.kind === 'result');
    assert.equal(readDecisions(log).filter((r) => r.id === result.decisionId).length, 2);
    assert.match(readDecisions(log)[0]?.note ?? '', /session 0923-1200-aaa$/);
  });

  it('증거가 없으면 요약 옆에 사다리 첫 단계를 제안한다', async () => {
    isolate();
    const { session } = make(conductSpy().exec);
    await session.send('이 타입 에러 고쳐줘');
    const summary = (await session.approve()).at(-1);
    assert.ok(summary?.kind === 'summary');
    assert.equal(summary.text, '요약 한 줄');
    assert.match(summary.next, /코드·로그·재현 조건 보강/);
  });

  it('검증 명령이 통과하면 다음 제안이 없다', async () => {
    isolate();
    const { session } = make(conductSpy().exec);
    await session.send('이 타입 에러 고쳐줘');
    const summary = (await session.approve({ verify: ['exit 0'] })).at(-1);
    assert.ok(summary?.kind === 'summary' && summary.next === '');
  });

  it('위임 프롬프트에 앞 대화를 싣고, 결정 로그에는 사용자 문장만 남긴다', async () => {
    const log = isolate();
    const d = delegateSpy();
    const { session } = make(conductSpy().exec, undefined, d.exec);
    await session.send('넌 누구니');
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    assert.match(d.calls[0]?.prompt ?? '', /^\[최근 대화\]\n사용자: 넌 누구니/);
    assert.match(d.calls[0]?.prompt ?? '', /\[이번 요청\]\n이 타입 에러 고쳐줘$/);
    assert.equal(readDecisions(log)[0]?.task, '이 타입 에러 고쳐줘');
  });

  it('다음 직접 답은 앞 위임의 요약을 맥락으로 받는다 (G7)', async () => {
    isolate();
    const c = conductSpy();
    const { session } = make(c.exec);
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    await session.send('넌 누구니');
    assert.match(c.prompts.at(-1) ?? '', /orc\(위임 결과 요약\): 요약 한 줄/);
  });

  it('거절하면 실행하지 않고 입력 대기로 돌아간다', async () => {
    const d = delegateSpy();
    const { session } = make(conductSpy().exec, undefined, d.exec);
    await session.send('이 타입 에러 고쳐줘');
    const out = session.reject();
    assert.ok(out[0]?.kind === 'approval' && out[0].approved === false);
    assert.equal(session.state, 'waiting_input');
    assert.equal(d.calls.length, 0);
  });

  it('스크래치 세션은 쓰기 승인을 거절하고 승인 대기에 남는다', async () => {
    const budget = new Budget(20, 2_000_000);
    const session = new ConversationSession({
      matrix, catalog, kind: 'scratch', dir: mkdtempSync(path.join(os.tmpdir(), 'hs-scratch-')), id: '0923-1200-bbb',
      budget, journal: new Journal(), conduct: conductSpy().exec, executorFor: () => delegateSpy().exec, classifyLlm: false,
    });
    await session.send('이 타입 에러 고쳐줘');
    await assert.rejects(session.approve({ write: true }), SessionStateError);
    assert.equal(session.state, 'blocked');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test src/core/__tests__/conductor.test.ts src/core/__tests__/session.test.ts`
Expected: FAIL — `buildSummaryPrompt`·`nextSuggestion`·`approve`·`reject` 없음

- [ ] **Step 3: 구현**

`src/core/conductor.ts` 에 추가 (import: `import type { Delegated } from './delegate.ts';` · `import type { Verdict } from './duo.ts';` · `import { STAGE_LABEL, nextStage } from './ladder.ts';`):

```ts
export function buildSummaryPrompt(title: string, d: Pick<Delegated, 'text' | 'verdict' | 'outcome' | 'report'>): string {
  return [
    '아래 위임 결과를 사용자에게 3줄 이내로 요약하라.',
    '새 사실을 지어내지 않는다. reviewer 판정과 증거 상태를 그대로 전한다.',
    '',
    `[요청] ${title}`,
    `[reviewer 판정] ${d.verdict}`,
    `[증거] ${d.report.summary}`,
    `[outcome] ${d.outcome}`,
    '[primary 출력 앞부분]',
    d.text.slice(0, 3000),
  ].join('\n');
}

/**
 * 다음 제안은 **코드가 계산한다** (SPEC §6.4.4) — 상향 판단을 모델에 넘기지 않는다 (G1).
 * v2.1 세션은 상향을 **실행하지 않으므로** 언제나 사다리의 첫 단계를 제안한다 (SPEC §2.4 순서).
 */
export function nextSuggestion(outcome: 'ok' | 'unverified' | 'wrong', verdict: Verdict): string {
  if (outcome === 'ok' && verdict !== 'fail') return '';
  const stage = nextStage([]);
  return stage ? `사다리 다음 단계: ${STAGE_LABEL[stage]} — 그 뒤에 다시 위임한다` : '';
}
```

`src/core/session.ts` — import 추가: `import type { AssignmentPlan } from './assign.ts';` · `import { buildSummaryPrompt, nextSuggestion } from './conductor.ts';` (기존 conductor import 에 합친다) · `import { delegate, type Delegated } from './delegate.ts';`.

`const why = …` 위에 타입을 둔다:

```ts
interface Pending {
  /** 사용자가 쓴 문장 그대로. 결정 로그에 이것이 남는다. */
  readonly title: string;
  readonly plan: AssignmentPlan;
  readonly reason: string;
}
```

클래스 필드 `private stateValue …` 아래에 `private pending: Pending | null = null;` 를 두고, `route()` 의 `this.stateValue = 'blocked';` **바로 위**에 한 줄:

```ts
    this.pending = { title: text, plan, reason: result.reason };
```

클래스에 메서드 추가:

```ts
  async approve(options: { readonly verify?: readonly string[]; readonly write?: boolean } = {}): Promise<TranscriptRecord[]> {
    this.require('blocked', '승인');
    const pending = this.pending;
    if (!pending) throw new SessionStateError('승인할 배정이 없다.');
    const write = options.write === true;
    if (write && this.deps.kind === 'scratch') {
      throw new SessionStateError('스크래치 세션은 쓰기를 켤 수 없다 (SPEC §6.4.1).');
    }
    const { matrix, dir, budget, journal } = this.deps;
    const out = [this.append({ kind: 'approval', approved: true, write })];
    this.pending = null;
    this.stateValue = 'working';
    try {
      const context = buildContext(this.records(), this.contextLimits, { before: this.turn });
      const prompt = context ? `[최근 대화]\n${context}\n\n[이번 요청]\n${pending.title}` : pending.title;
      const d = await delegate({
        matrix,
        plan: pending.plan,
        reason: pending.reason,
        title: pending.title,
        prompt,
        verify: options.verify ?? [],
        cwd: dir,
        execute: this.deps.executorFor(write),
        budget,
        journal,
        note: `session ${this.deps.id}`,
      });
      out.push(
        this.append({
          kind: 'result',
          outcome: d.outcome,
          verdict: d.verdict,
          text: d.text.slice(0, 4000),
          review: d.review ?? '',
          evidence: d.report.summary,
          decisionId: d.decisionId,
        }),
      );
      out.push(...(await this.summarize(pending.title, d)));
    } catch (error) {
      out.push(this.append({ kind: 'error', text: `위임이 끝나지 못했다: ${why(error)}` }));
    } finally {
      this.stateValue = 'waiting_input';
    }
    return out;
  }

  reject(): TranscriptRecord[] {
    this.require('blocked', '거절');
    this.pending = null;
    this.stateValue = 'waiting_input';
    return [this.append({ kind: 'approval', approved: false, write: false })];
  }

  /** 모델은 요약만 한다. 다음 제안은 코드가 계산한다 (SPEC §6.4.4). 요약이 실패해도 제안은 남긴다. */
  private async summarize(title: string, d: Delegated): Promise<TranscriptRecord[]> {
    const next = nextSuggestion(d.outcome, d.verdict);
    const { matrix, catalog, budget, conduct } = this.deps;
    if (budget.limitReached()) {
      return [
        this.append({ kind: 'error', text: `누적 상한에 닿아 요약을 시작하지 않는다 (${budget.summary()}) — 결과 카드를 본다.` }),
        this.append({ kind: 'summary', text: '', next }),
      ];
    }
    const slot = conductorSlot(catalog);
    try {
      const run = await conduct(slot, buildSummaryPrompt(title, d));
      budget.charge(`${slot.label}·${slot.effort}`, run.actualUsd, estimateUsd(matrix, slot), run.meteredUsd, slot.plan);
      budget.countTokens(run.usage);
      if (!run.ok) {
        return [
          this.append({ kind: 'error', text: `요약을 받지 못했다 — 결과 카드를 본다: ${run.text || '엔진이 실패했다'}` }),
          this.append({ kind: 'summary', text: '', next }),
        ];
      }
      return [this.append({ kind: 'summary', text: run.text.trim(), next })];
    } catch (error) {
      return [
        this.append({ kind: 'error', text: `요약을 받지 못했다 — 결과 카드를 본다: ${why(error)}` }),
        this.append({ kind: 'summary', text: '', next }),
      ];
    }
  }
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test src/core/__tests__/conductor.test.ts src/core/__tests__/session.test.ts`
Expected: PASS

- [ ] **Step 5: 게이트 후 커밋**

Run: `npm run gate`

```bash
git add src/core/conductor.ts src/core/session.ts src/core/__tests__/conductor.test.ts src/core/__tests__/session.test.ts
git commit -m "feat(core): 세션 승인·거절·결과 처리 — 모델은 요약만, 다음 제안은 코드가 (SPEC §6.4.4)"
```

---

### Task 7: 스크래치에서 codex 가 돌게 한다 (`nonGit`)

**Files:**
- Modify: `src/data/engines.ts` (`EngineSpec.nonGitArgv?`), `data/engines.json` (codex 선언 + `$evidence.nonGit`), `src/adapters/types.ts` (`RunRequest.nonGit?`), `src/adapters/resolve.ts` (`InvocationOptions.nonGit?`, argv), `src/adapters/engine.ts` (argvFor 전달), `src/core/executor.ts` (`ExecutorOptions.nonGit?`)
- Test: `src/adapters/__tests__/resolve.test.ts`

**Interfaces:**
- Produces: `EngineSpec.nonGitArgv?: readonly string[]`, `RunRequest.nonGit?: boolean`, `InvocationOptions.nonGit?: boolean`, `ExecutorOptions.nonGit?: boolean`

- [ ] **Step 1: 전제를 실측한다 (사용량 1회)**

codex 가 git 밖에서 실제로 거절하는지 확인한다. **거절하지 않으면 이 Task 를 건너뛰고 Task 12 후속 목록에 "불필요 확인"으로 적는다.**

```bash
D=$(mktemp -d) && cd "$D" && codex exec --json -m gpt-5.6-luna -c model_reasoning_effort=low "Reply with exactly: ok" </dev/null; echo "exit=$?"
```

Expected: 비정상 종료, 메시지에 `--skip-git-repo-check` 언급

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`src/adapters/__tests__/resolve.test.ts` 에 추가 (파일의 기존 import 로 `buildInvocation`·`loadEngines` 를 쓴다):

```ts
describe('git 밖 실행 (스크래치, SPEC §6.4.1)', () => {
  const catalog = loadEngines();
  it('codex 는 nonGit 이면 --skip-git-repo-check 를 붙인다', () => {
    const { argv } = buildInvocation(catalog, 'luna', 'low', 'hi', { engine: 'codex', nonGit: true });
    assert.ok(argv.includes('--skip-git-repo-check'));
  });
  it('기본은 붙이지 않는다 — git 검사가 지키던 것을 project 세션에서 버리지 않는다', () => {
    const { argv } = buildInvocation(catalog, 'luna', 'low', 'hi', { engine: 'codex' });
    assert.ok(!argv.includes('--skip-git-repo-check'));
  });
  it('선언이 없는 엔진은 nonGit 이어도 아무것도 붙이지 않는다', () => {
    const plain = buildInvocation(catalog, 'haiku', 'low', 'hi', { engine: 'claude' }).argv;
    const nonGit = buildInvocation(catalog, 'haiku', 'low', 'hi', { engine: 'claude', nonGit: true }).argv;
    assert.deepEqual(nonGit, plain);
  });
});
```

- [ ] **Step 3: 실패를 확인한다**

Run: `node --test src/adapters/__tests__/resolve.test.ts`
Expected: FAIL — 첫 테스트 (그리고 `nonGit` 타입 오류)

- [ ] **Step 4: 구현**

`src/data/engines.ts` 의 `EngineSpec` 에 추가:

```ts
  /**
   * git 저장소 밖에서 돌 때 필요한 인자. codex exec 는 없으면 거절한다.
   * **스크래치 세션에만** 붙인다 — 쓰기가 꺼진 자리라 git 검사가 지키던 것이 없다 (SPEC §6.4.1).
   */
  readonly nonGitArgv?: readonly string[];
```

`data/engines.json` — `engines.codex` 에 `"nonGitArgv": ["--skip-git-repo-check"]` 를 추가하고, `$evidence` 에 한 줄:

```json
    "nonGit": "codex exec 는 git 저장소 밖에서 --skip-git-repo-check 없이 거절한다 (2026-09-23 실측). 스크래치 세션에만 붙인다 — 쓰기를 켤 수 없는 자리다. project 세션(git 이 아닌 폴더 포함)에는 붙이지 않는다."
```

`src/adapters/types.ts` 의 `RunRequest` 에 추가:

```ts
  /** 스크래치 세션 — git 저장소 밖이다. 엔진이 선언한 `nonGitArgv` 를 붙인다. */
  readonly nonGit?: boolean;
```

`src/adapters/resolve.ts` 의 `InvocationOptions` 에 `readonly nonGit?: boolean;` 을 추가하고, `buildInvocation` 의 write 인자를 붙인 **뒤**, `return` 앞에:

```ts
  if (options.nonGit === true && spec.nonGitArgv) argv.push(...spec.nonGitArgv);
```

`src/adapters/engine.ts` 의 `argvFor` 옵션에:

```ts
      ...(req.nonGit === true ? { nonGit: true } : {}),
```

`src/core/executor.ts` — `ExecutorOptions` 에 추가:

```ts
  /** 스크래치 세션 (SPEC §6.4.1). git 밖에서 돌려야 하는 엔진에 그 인자를 붙인다. */
  readonly nonGit?: boolean;
```

그리고 `createExecutor` 의 `start({...})` 에:

```ts
      ...(options.nonGit === true ? { nonGit: true } : {}),
```

- [ ] **Step 5: 통과를 확인한다**

Run: `node --test src/adapters/__tests__/resolve.test.ts && npm run gate`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add src/data/engines.ts data/engines.json src/adapters/types.ts src/adapters/resolve.ts src/adapters/engine.ts src/core/executor.ts src/adapters/__tests__/resolve.test.ts
git commit -m "feat(adapters): 스크래치 세션에서 codex 가 돈다 — nonGit 일 때만 --skip-git-repo-check (SPEC §6.4.1)"
```

---

### Task 8: GUI 서비스·IPC — 세션 API

**Files:**
- Modify: `src/core/transcript.ts` (`listSessions`·`listScratchSessions`), `src/shell/gui/service.ts`, `src/shell/gui/main.ts`, `src/shell/gui/preload.cjs`
- Test: `src/core/__tests__/transcript.test.ts` (1건), `src/shell/gui/__tests__/service.test.ts` (4건)

**Interfaces:**
- Consumes: Task 1~7 전부
- Produces:
  - `interface SessionSummary { id: string; dir: string; kind: SessionKind; lastAt: string; preview: string }`, `listSessions(dir, kind): SessionSummary[]`, `listScratchSessions(env?): SessionSummary[]`
  - `interface SessionView { id: string; kind: SessionKind; dir: string; state: SessionState; records: TranscriptRecord[]; broken: number; budget: string }`
  - `GuiService`: 생성자 4번째 인자 `classifyLlm?: boolean`; `conversations(): SessionSummary[]`, `startConversation(kind)`, `openConversation(kind, dir, id)`, `conversation(): SessionView`, `converse(text)`, `conversePlanAs(taskId)`, `converseApprove({ verify, write })`, `converseReject()`, `closeConversation()` — 모두 `SessionView`(close 는 void) 를 돌려준다. `useProject` 가 다른 폴더의 project 세션을 닫는다.
  - IPC 채널: `conv-list` · `conv-start` · `conv-open` · `conv-view` · `conv-send` · `conv-plan-as` · `conv-approve` · `conv-reject` · `conv-close` (기존 `sessions` 채널은 FR-9 에이전트 조회라 그대로 둔다)
  - preload: `convList()`, `convStart(kind)`, `convOpen({kind, dir, id})`, `convView()`, `convSend(text)`, `convPlanAs(taskId)`, `convApprove({verify, write})`, `convReject()`, `convClose()`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/core/__tests__/transcript.test.ts` 에 추가 (import 에 `listSessions` 추가):

```ts
  it('폴더의 세션을 최근 것부터 나열하고 첫 메시지를 미리보기로 쓴다', () => {
    const dir = tmp();
    appendRecord(transcriptPath(dir, 'a'), { ...user(1, '옛날'), at: '2026-09-22T00:00:00.000Z' });
    appendRecord(transcriptPath(dir, 'b'), { ...user(1, '최근'), at: '2026-09-23T00:00:00.000Z' });
    const list = listSessions(dir, 'project');
    assert.deepEqual(list.map((s) => [s.id, s.preview]), [['b', '최근'], ['a', '옛날']]);
    assert.deepEqual(listSessions(path.join(dir, 'none'), 'project'), []);
  });
```

`src/shell/gui/__tests__/service.test.ts` 의 `isolated()` 에 한 줄 추가:

```ts
  process.env['HS_ORC_SCRATCH'] = path.join(dir, 'scratch');
```

그리고 새 `describe` 추가 (`fake` 는 파일 위에 이미 있다 — 지휘자 라벨 `지휘자·Haiku` 는 `Haiku` 가 아니므로 `ran:<prompt>` 을 돌려준다):

```ts
describe('GUI — 대화 세션 (v2.1)', () => {
  it('스크래치 세션은 HS_ORC_SCRATCH 안에 만들고 목록에 뜬다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd(), false);
    const view = service.startConversation('scratch');
    assert.equal(view.kind, 'scratch');
    assert.ok(view.dir.startsWith(process.env['HS_ORC_SCRATCH'] ?? '~'));
    await service.converse('넌 누구니');
    assert.ok(service.conversations().some((s) => s.id === view.id && s.preview === '넌 누구니'));
  });

  it('분류되지 않는 메시지에 직접 답한다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd(), false);
    service.startConversation('scratch');
    const view = await service.converse('넌 누구니');
    assert.deepEqual(view.records.map((r) => r.kind), ['user', 'direct']);
    assert.equal(view.state, 'waiting_input');
  });

  it('스크래치에서는 쓰기 승인을 거절한다', async () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd(), false);
    service.startConversation('scratch');
    await service.converse('이 타입 에러 고쳐줘');
    await assert.rejects(service.converseApprove({ verify: [], write: true }), /쓰기를 켤 수 없다/);
  });

  it('다른 폴더로 옮기면 그 폴더의 것이 아닌 project 세션을 닫는다', () => {
    isolated();
    const service = new GuiService(fake, 20, process.cwd(), false);
    service.startConversation('project');
    service.useProject(mkdtempSync(path.join(os.tmpdir(), 'hs-other-')));
    assert.throws(() => service.conversation(), /열린 세션이 없다/);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test src/core/__tests__/transcript.test.ts src/shell/gui/__tests__/service.test.ts`
Expected: FAIL — `listSessions`·`startConversation` 없음

- [ ] **Step 3: 구현**

`src/core/transcript.ts` 에 추가 (import 에 `readdirSync`):

```ts
export interface SessionSummary {
  readonly id: string;
  readonly dir: string;
  readonly kind: SessionKind;
  readonly lastAt: string;
  readonly preview: string;
}

export function listSessions(dir: string, kind: SessionKind): SessionSummary[] {
  const folder = path.join(dir, '.hs-orc', 'sessions');
  let names: string[];
  try {
    names = readdirSync(folder).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return []; // 세션을 한 번도 안 연 폴더다 — 정상이다.
  }
  return names
    .map((name): SessionSummary => {
      const { records } = readTranscript(path.join(folder, name));
      const first = records.find((r) => r.kind === 'user');
      return {
        id: name.slice(0, -'.jsonl'.length),
        dir,
        kind,
        lastAt: records.at(-1)?.at ?? '',
        preview: first?.kind === 'user' ? first.text.slice(0, 60) : '',
      };
    })
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export function listScratchSessions(env: NodeJS.ProcessEnv = process.env): SessionSummary[] {
  const root = scratchRoot(env);
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  return dirs.flatMap((d) => listSessions(path.join(root, d), 'scratch'));
}
```

`src/shell/gui/service.ts`:

import 추가:

```ts
import { ConversationSession } from '../../core/session.ts';
import {
  listScratchSessions,
  listSessions,
  prepareSession,
  readTranscript,
  scratchRoot,
  type SessionKind,
  type SessionState,
  type SessionSummary,
  type TranscriptRecord,
} from '../../core/transcript.ts';
import path from 'node:path';
```

타입 추가:

```ts
export interface SessionView {
  readonly id: string;
  readonly kind: SessionKind;
  readonly dir: string;
  readonly state: SessionState;
  readonly records: readonly TranscriptRecord[];
  /** 깨진 줄 수 — 0 이 아니면 화면이 알린다. */
  readonly broken: number;
  readonly budget: string;
}
```

클래스 필드·생성자:

```ts
  private readonly classifyLlm: boolean | undefined;
  private session: ConversationSession | null = null;

  constructor(execute?: SlotExecutor, budgetUsd = loadLimits().budgetUsd, cwd = process.cwd(), classifyLlm?: boolean) {
    this.budget = new Budget(budgetUsd, loadLimits().tokenBudget);
    this.execute = execute;
    this.workdir = cwd;
    this.classifyLlm = classifyLlm;
  }
```

`useProject` 의 `this.workdir = validateProject(dir);` 바로 뒤에:

```ts
    // 화면의 폴더와 세션의 폴더가 갈리면 안 된다 (D-029) — 다른 폴더의 project 세션은 닫는다.
    if (this.session?.kind === 'project' && !samePath(this.session.dir, this.workdir)) this.session = null;
```

메서드 추가:

```ts
  conversations(): SessionSummary[] {
    return [...listSessions(this.workdir, 'project'), ...listScratchSessions()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  startConversation(kind: SessionKind): SessionView {
    const { dir, id } = prepareSession(kind, this.workdir);
    return this.attach(kind, dir, id);
  }

  /** project 세션은 그 폴더로 **먼저 옮긴다** — 화면의 폴더가 세션의 폴더다. 스크래치는 스크래치 뿌리 안이어야 한다. */
  openConversation(kind: SessionKind, dir: string, id: string): SessionView {
    if (kind === 'project') {
      this.useProject(dir);
    } else if (path.relative(scratchRoot(), dir).startsWith('..')) {
      throw new Error(`스크래치 뿌리 밖의 폴더다: ${dir}`);
    }
    return this.attach(kind, dir, id);
  }

  conversation(): SessionView {
    const s = this.requireConversation();
    return {
      id: s.id,
      kind: s.kind,
      dir: s.dir,
      state: s.state,
      records: s.records(),
      broken: readTranscript(s.file).broken,
      budget: this.budget.summary(),
    };
  }

  async converse(text: string): Promise<SessionView> {
    await this.requireConversation().send(text);
    return this.conversation();
  }

  async conversePlanAs(taskId: string): Promise<SessionView> {
    await this.requireConversation().planAs(taskId);
    return this.conversation();
  }

  async converseApprove(payload: { verify: readonly string[]; write: boolean }): Promise<SessionView> {
    await this.requireConversation().approve(payload);
    return this.conversation();
  }

  converseReject(): SessionView {
    this.requireConversation().reject();
    return this.conversation();
  }

  closeConversation(): void {
    this.session = null;
  }

  private requireConversation(): ConversationSession {
    if (!this.session) throw new Error('열린 세션이 없다.');
    return this.session;
  }

  private attach(kind: SessionKind, dir: string, id: string): SessionView {
    const catalog = loadEngines();
    const timeout = loadLimits().runTimeoutMs;
    const nonGit = kind === 'scratch';
    this.session = new ConversationSession({
      matrix: loadMatrix(),
      catalog,
      kind,
      dir,
      id,
      budget: this.budget,
      journal: this.journal,
      conduct: this.execute ?? createExecutor(catalog, dir, timeout, { nonGit }),
      executorFor: (write) => this.execute ?? createExecutor(catalog, dir, timeout, { write, nonGit }),
      ...(this.classifyLlm === undefined ? {} : { classifyLlm: this.classifyLlm }),
    });
    return this.conversation();
  }
```

`src/shell/gui/main.ts` 에 핸들러 추가:

```ts
ipcMain.handle('conv-list', () => service.conversations());
ipcMain.handle('conv-start', (_e, kind: SessionKind) => service.startConversation(kind));
ipcMain.handle('conv-open', (_e, p: { kind: SessionKind; dir: string; id: string }) => service.openConversation(p.kind, p.dir, p.id));
ipcMain.handle('conv-view', () => service.conversation());
ipcMain.handle('conv-send', (_e, text: string) => service.converse(text));
ipcMain.handle('conv-plan-as', (_e, taskId: string) => service.conversePlanAs(taskId));
ipcMain.handle('conv-approve', (_e, p: { verify: string[]; write: boolean }) => service.converseApprove(p));
ipcMain.handle('conv-reject', () => service.converseReject());
ipcMain.handle('conv-close', () => service.closeConversation());
```

(`import type { SessionKind } from '../../core/transcript.ts';` 추가.)

`src/shell/gui/preload.cjs` 의 `exposeInMainWorld('orc', { … })` 에 추가:

```js
  convList: () => ipcRenderer.invoke('conv-list'),
  convStart: (kind) => ipcRenderer.invoke('conv-start', kind),
  convOpen: (payload) => ipcRenderer.invoke('conv-open', payload),
  convView: () => ipcRenderer.invoke('conv-view'),
  convSend: (text) => ipcRenderer.invoke('conv-send', text),
  convPlanAs: (taskId) => ipcRenderer.invoke('conv-plan-as', taskId),
  convApprove: (payload) => ipcRenderer.invoke('conv-approve', payload),
  convReject: () => ipcRenderer.invoke('conv-reject'),
  convClose: () => ipcRenderer.invoke('conv-close'),
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test src/core/__tests__/transcript.test.ts src/shell/gui/__tests__/service.test.ts && npm run gate`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/core/transcript.ts src/core/__tests__/transcript.test.ts src/shell/gui/service.ts src/shell/gui/main.ts src/shell/gui/preload.cjs src/shell/gui/__tests__/service.test.ts
git commit -m "feat(gui): 세션 API·IPC — project·scratch 진입, 폴더를 옮기면 남의 세션을 닫는다 (FR-12)"
```

---

### Task 9: GUI 화면 — 세션 목록·채팅, Sessions → Agents

**Files:**
- Modify: `src/shell/gui/renderer/app.ts`, `src/shell/gui/renderer/index.html` (CSS 몇 줄)

**Interfaces:**
- Consumes: Task 8 preload API, 기존 `orc.tasks()`·`orc.projects()`·`ProjectBar`·`planLine`·`card`·`text`·`elide`·`why`·`useAsync`
- Produces: 화면 `Session`(목록 또는 채팅) · `Dashboard` · `Agents` · `Reviews` · `Debug`. v2 `RunScreen`·`ResultCards` 는 제거한다 (SPEC §7.1 — Run 폼은 세션 화면으로 대체).

- [ ] **Step 1: 타입·브리지를 바꾼다**

`app.ts` 상단:
- `SCREENS` 를 `['Session', 'Dashboard', 'Agents', 'Reviews', 'Debug'] as const` 로 바꾼다.
- `RunView`·`EvidenceReport`·`RunResult`·`Planned` 인터페이스와 `Bridge` 의 `plan`·`run` 멤버를 지운다 (IPC 채널 자체는 남는다 — 테스트·CLI 동등성용).
- 아래 타입과 `Bridge` 멤버를 추가한다:

```ts
type SessionKind = 'project' | 'scratch';
type SessionState = 'waiting_input' | 'working' | 'blocked';
type Rec =
  | { kind: 'user'; turn: number; text: string }
  | { kind: 'direct'; turn: number; text: string; suggest: string | null; cost: string; notes: string[] }
  | { kind: 'plan'; turn: number; taskId: string; title: string; reason: string; primary: string; reviewer: string; estimateUsd: number; notes: string[] }
  | { kind: 'approval'; turn: number; approved: boolean; write: boolean }
  | { kind: 'result'; turn: number; outcome: string; verdict: string; text: string; review: string; evidence: string; decisionId: string }
  | { kind: 'summary'; turn: number; text: string; next: string }
  | { kind: 'error'; turn: number; text: string };
interface SessionView { id: string; kind: SessionKind; dir: string; state: SessionState; records: Rec[]; broken: number; budget: string }
interface SessionSummary { id: string; dir: string; kind: SessionKind; lastAt: string; preview: string }
```

```ts
  convList(): Promise<SessionSummary[]>;
  convStart(kind: SessionKind): Promise<SessionView>;
  convOpen(payload: { kind: SessionKind; dir: string; id: string }): Promise<SessionView>;
  convView(): Promise<SessionView>;
  convSend(text: string): Promise<SessionView>;
  convPlanAs(taskId: string): Promise<SessionView>;
  convApprove(payload: { verify: string[]; write: boolean }): Promise<SessionView>;
  convReject(): Promise<SessionView>;
  convClose(): Promise<void>;
```

- [ ] **Step 2: `RunScreen`·`ResultCards` 를 지우고 두 컴포넌트를 넣는다**

`// ── Run ──` 절 전체(`interface Planned` 부터 `ResultCards` 끝까지)를 아래로 바꾼다:

```ts
// ── 세션 ───────────────────────────────────────────────────
const lines = (s: string): string[] => s.split('\n').map((v) => v.trim()).filter(Boolean);

function SessionList(props: { onOpen: (v: SessionView) => void; onError: (m: string) => void }): ReactElement {
  const list = useAsync(() => orc.convList());
  const [busy, setBusy] = useState(false);
  const start = (kind: SessionKind) => {
    setBusy(true);
    orc.convStart(kind).then(props.onOpen, (e: unknown) => props.onError(why(e))).finally(() => setBusy(false));
  };
  const open = (s: SessionSummary) => {
    orc.convOpen({ kind: s.kind, dir: s.dir, id: s.id }).then(props.onOpen, (e: unknown) => props.onError(why(e)));
  };
  return h('div', { className: 'stack' },
    card('새 세션',
      h('div', { className: 'row' },
        h('button', { className: 'btn accent', disabled: busy, onClick: () => start('project') }, '이 폴더에서 시작'),
        h('button', { className: 'btn', disabled: busy, onClick: () => start('scratch') }, '스크래치'),
        h('span', { className: 'hint' }, '스크래치는 폴더 없이 시작한다 — 쓰기를 켤 수 없다'))),
    card('최근 세션',
      !list ? text('불러오는 중…', 'dim')
      : list.length === 0 ? text('아직 없다', 'dim')
      : h('table', null, h('tbody', null, ...list.map((s) =>
          h('tr', { key: `${s.dir}/${s.id}`, className: 'clickable', onClick: () => open(s) },
            h('td', { className: 'mono dim' }, s.kind === 'scratch' ? '스크래치' : elide(s.dir, 30)),
            h('td', null, s.preview || '(빈 세션)'),
            h('td', { className: 'mono dim' }, s.lastAt.slice(0, 16).replace('T', ' '))))))));
}

function SessionScreen(props: { view: SessionView; rows: TaskRow[]; onChange: (v: SessionView) => void; onClose: () => void }): ReactElement {
  const { view, onChange } = props;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState('');
  const [verify, setVerify] = useState('');
  const [write, setWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  // 새 기록·진행 표시가 뜨면 그 자리로 간다 — 입력 아래에 가려 "아무 일 없음"으로 보이지 않게.
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [view.records.length, busy]);

  const act = (p: Promise<SessionView>) => {
    setBusy(true);
    setError('');
    p.then(onChange, (e: unknown) => setError(why(e))).finally(() => { setBusy(false); setSending(''); });
  };
  const send = () => {
    const t = draft.trim();
    if (!t) return;
    setDraft('');
    setSending(t);
    act(orc.convSend(t));
  };

  const last = view.records.at(-1);
  const canType = view.state === 'waiting_input' && !busy;

  const planCard = (r: Extract<Rec, { kind: 'plan' }>, i: number, active: boolean): ReactNode =>
    h('section', { key: i, className: 'card' },
      h('span', { className: 'label' }, `배정 · ${r.taskId}`),
      ...r.notes.map((n, j) => h('div', { key: `n${j}`, className: 'hint' }, n)),
      planLine(`분류 ${r.taskId} ${r.title}  (${r.reason})`, 0),
      planLine(`primary  ${r.primary}`, 1),
      planLine(`reviewer ${r.reviewer}`, 2),
      planLine(`비용 예상 $${r.estimateUsd}`, 3),
      active
        ? h('div', { className: 'stack', style: { padding: 0, width: '100%', marginTop: 10 } },
            h('div', { className: 'row' },
              // 행을 바꾸면 이 배정을 거절하고 새 행으로 다시 받는다 — 승인은 화면에 찍힌 그 배정으로만 간다.
              h('select', {
                value: r.taskId,
                disabled: busy,
                onChange: (e: { target: { value: string } }) => act(orc.convReject().then(() => orc.convPlanAs(e.target.value))),
              }, ...props.rows.map((row) => h('option', { key: row.id, value: row.id }, `${row.id} · ${row.task}`))),
              h('span', { className: 'hint' }, '업무 행 직접 지정')),
            h('textarea', {
              className: 'code', rows: 2, value: verify, placeholder: '검증 명령 · 한 줄에 하나 (예: npm test)',
              onChange: (e: { target: { value: string } }) => setVerify(e.target.value),
            }),
            h('label', { className: 'toggle' },
              h('input', {
                type: 'checkbox', checked: write && view.kind !== 'scratch', disabled: view.kind === 'scratch',
                onChange: (e: { target: { checked: boolean } }) => setWrite(e.target.checked),
              }),
              h('span', { className: 'track' }),
              h('span', { className: 'text' },
                view.kind === 'scratch' ? '스크래치는 쓰기를 켤 수 없다'
                : write ? h('b', null, 'primary 슬롯이 이 폴더의 파일을 고칠 수 있다')
                : 'primary 슬롯 파일 쓰기 (--write)',
                h('span', { className: 'dim' }, ' · reviewer 는 언제나 읽기 전용'))),
            h('div', { className: 'row' },
              h('button', {
                className: 'btn accent', disabled: busy,
                onClick: () => act(orc.convApprove({ verify: lines(verify), write: write && view.kind !== 'scratch' })),
              }, busy ? '실행 중…' : `승인하고 실행 · 두 슬롯${write && view.kind !== 'scratch' ? ' · 쓰기 켜짐' : ''}`),
              h('button', { className: 'btn', disabled: busy, onClick: () => act(orc.convReject()) }, '거절')))
        : null);

  const record = (r: Rec, i: number): ReactNode => {
    switch (r.kind) {
      case 'user':
        return h('div', { key: i, className: 'bubble user' }, r.text);
      case 'direct': {
        const suggest = r.suggest;
        return h('div', { key: i, className: 'bubble orc' },
          ...r.notes.map((n, j) => h('div', { key: `n${j}`, className: 'hint' }, n)),
          h('div', null, r.text),
          h('div', { className: 'hint' }, `직접 답 · 지휘자 Haiku·low · ${r.cost}`),
          suggest && r === last && view.state === 'waiting_input'
            ? h('button', { className: 'btn accent', disabled: busy, onClick: () => act(orc.convPlanAs(suggest)) }, `${suggest} 로 위임`)
            : null);
      }
      case 'plan':
        return planCard(r, i, r === last && view.state === 'blocked');
      case 'approval':
        return h('div', { key: i, className: 'hint' }, r.approved ? `승인${r.write ? ' · 쓰기 켜짐' : ''}` : '거절');
      case 'result':
        return h('section', { key: i, className: 'card' },
          h('span', { className: 'label' }, `위임 결과 · ${r.decisionId}`),
          h('div', { className: 'row' },
            h('span', { className: `chip ${r.verdict}` }, r.verdict.toUpperCase()),
            h('span', { className: r.outcome === 'ok' ? 'good mono' : 'warn mono' }, `outcome = ${r.outcome}`)),
          h('div', { className: r.outcome === 'ok' ? 'good mono' : 'warn mono' }, r.evidence),
          h('pre', { style: { marginTop: 10 } }, r.text || '(빈 출력)'),
          r.review ? h('pre', { style: { marginTop: 10 } }, r.review) : null);
      case 'summary':
        return h('div', { key: i, className: 'bubble orc' },
          r.text ? h('div', null, r.text) : null,
          r.next ? h('div', { className: 'warn' }, r.next) : null);
      case 'error':
        return h('div', { key: i, className: 'banner error' }, r.text);
    }
  };

  return h('div', { className: 'stack' },
    h('div', { className: 'row' },
      h('span', { className: 'mono dim' }, view.kind === 'scratch' ? `스크래치 · ${elide(view.dir, 50)}` : elide(view.dir, 60)),
      h('div', { className: 'spacer' }),
      h('span', { className: 'dim mono' }, view.budget),
      h('button', { className: 'btn', onClick: props.onClose }, '세션 목록')),
    view.broken > 0 ? h('div', { className: 'banner error' }, `기록에 깨진 줄 ${view.broken}개 — 건너뛰고 보여준다`) : null,
    ...view.records.map(record),
    sending ? h('div', { className: 'bubble user dim' }, sending) : null,
    busy ? text(view.state === 'blocked' || last?.kind === 'plan' ? '실행 중…' : '생각 중…', 'dim') : null,
    error ? h('div', { className: 'banner error' }, error) : null,
    h('div', { ref: endRef }),
    card(null,
      h('textarea', {
        rows: 3, value: draft, disabled: !canType,
        placeholder: view.state === 'blocked' ? '배정을 승인하거나 거절해야 다음 메시지를 받는다' : '메시지 · ⌘↵ 전송',
        onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
        onKeyDown: (e: { key: string; metaKey: boolean; ctrlKey: boolean; preventDefault: () => void }) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
        },
      }),
      h('div', { className: 'row', style: { marginTop: 10 } },
        h('div', { className: 'spacer' }),
        h('button', { className: 'btn accent', disabled: !canType || !draft.trim(), onClick: send }, '전송'))));
}
```

- [ ] **Step 3: `SessionsScreen` 을 `AgentsScreen` 으로, `App` 을 바꾼다**

- `const SessionsScreen = …` 의 이름을 `AgentsScreen` 으로 바꾸고 `card('세션', …)` 라벨을 `card('에이전트 세션', …)` 로 바꾼다 (FR-9 — 대화 세션과 이름이 겹치면 안 된다, SPEC §7.1).
- `App` 에 상태 두 개와 효과 하나를 추가한다:

```ts
  const [conv, setConv] = useState<SessionView | null>(null);
  const [rows, setRows] = useState<TaskRow[]>([]);
  useEffect(() => { orc.tasks().then(setRows, (e: unknown) => setError(why(e))); }, []);
```

- `ProjectBar` 의 `onChange` 를 폴더가 바뀌면 그 폴더의 것이 아닌 project 세션을 닫게 바꾼다 (서비스도 닫는다 — Task 8):

```ts
    h(ProjectBar, {
      state: projects,
      onChange: (s: ProjectState) => {
        setProjects(s);
        setConv((c) => (c && c.kind === 'project' && c.dir !== s.current.dir ? null : c));
      },
      onError: setError,
    }),
```

- 기존 `const run = h('div', { key: 'run', hidden: screen !== 'Run' }, h(RunScreen, …))` 를 아래로 바꾼다 — **숨기기만 하고 언마운트하지 않는다** (`fe60bff` 의 원칙):

```ts
  const session = h('div', { key: 'session', hidden: screen !== 'Session' },
    conv
      ? h(SessionScreen, {
          view: conv,
          rows,
          onChange: setConv,
          onClose: () => { void orc.convClose().then(() => setConv(null)); },
        })
      : h(SessionList, {
          // project 세션을 열면 서비스가 그 폴더로 옮긴다 (Task 8) — 프로젝트 바도 따라가야 폴더가 거짓말하지 않는다.
          onOpen: (v: SessionView) => { setConv(v); orc.projects().then(setProjects, (e: unknown) => setError(why(e))); },
          onError: setError,
        }));
```

- `body` 의 분기에서 `screen === 'Run' ? null` 을 `screen === 'Session' ? null` 로, `screen === 'Sessions' ? h(SessionsScreen, null)` 을 `screen === 'Agents' ? h(AgentsScreen, null)` 로 바꾸고, `main` 의 자식 `run` 을 `session` 으로 바꾼다.
- `useState<Screen>('Run')` 을 `useState<Screen>('Session')` 으로 바꾼다.

`index.html` 의 `<style>` 끝에 추가:

```css
      .clickable { cursor: pointer; }
      .clickable:hover td { color: var(--fg, inherit); }
      .bubble { max-width: 80%; padding: 10px 12px; border-radius: 10px; white-space: pre-wrap; line-height: 1.5; }
      .bubble.user { align-self: flex-end; background: var(--accent-bg, rgba(122,162,247,.15)); }
      .bubble.orc { align-self: flex-start; background: var(--card, rgba(255,255,255,.04)); }
```

(`--accent-bg`·`--card`·`--fg` 가 index.html 의 토큰 이름과 다르면 그 파일에 이미 있는 토큰으로 바꾼다.)

- [ ] **Step 4: 타입·린트·번들을 확인한다**

Run: `npm run type-check && npm run lint && npm run build:gui`
Expected: 오류 없음. `noUnusedLocals` 가 남은 v2 타입·헬퍼를 보고하면 지운다.

- [ ] **Step 5: 목 브리지로 화면 시나리오를 확인한다 (비용 없음)**

스크래치 폴더에 `index.html`(bundle 앞에 `<script src="./mock.js"></script>` 삽입)·`bundle.js`·`mock.js` 를 두고 브라우저 패널에서 연다. `mock.js` 는 `window.orc` 에 Task 8 의 `conv*` 를 메모리 배열로 구현한다 — `convSend` 는 `'넌'` 이 들어 있으면 `direct`(suggest `R01`), 아니면 `plan` 을 붙이고 상태를 `blocked` 로, `convApprove` 는 `approval`·`result`·`summary` 를 붙이고 `waiting_input` 으로 돌린다. `tasks()` 는 두 행, `projects()`·`worktrees()`·`debug()`·`dashboard()`·`sessions()`·`reviews()` 는 빈 값.

확인할 것:
1. 세션 목록 → "스크래치" → 채팅 화면, 쓰기 토글 비활성.
2. "넌 누구니" → 직접 답 말풍선 + 비용 줄 + "R01 로 위임" 버튼 → 누르면 배정 카드·승인 버튼.
3. 승인 → 결과 카드 + 요약 말풍선, 입력창 다시 활성.
4. 실행 중 Dashboard 로 갔다 돌아와도 대화·진행이 남는다.
5. `blocked` 상태에서 입력창 비활성 + 안내 문구.

- [ ] **Step 6: 커밋**

```bash
git add src/shell/gui/renderer/app.ts src/shell/gui/renderer/index.html
git commit -m "feat(gui): 세션 목록·채팅 화면 — Run 폼을 대체하고 Sessions 는 Agents 로 (SPEC §7.1)"
```

---

### Task 10: 어댑터 — 엔진 세션 id 읽기와 resume argv

**Files:**
- Modify: `src/adapters/types.ts`, `src/adapters/stream.ts`, `src/adapters/run.ts`, `src/adapters/resolve.ts`, `src/adapters/engine.ts`, `src/data/engines.ts`, `data/engines.json`, `src/core/executor.ts`
- Test: `src/adapters/__tests__/stream.test.ts`, `src/adapters/__tests__/resolve.test.ts`

**Interfaces:**
- Produces:
  - `RunEvent` 에 `{ kind: 'session'; id: string }`, `RunRequest.resume?: string`, `RunResult.sessionId?: string`
  - `EngineSpec.resume?: { kind: 'flag'; flag: string } | { kind: 'subcommand'; argv: readonly string[] }`
  - `InvocationOptions.resume?: string` — 선언 없는 엔진에 요청하면 `EngineError`
  - `interface SlotRunOptions { resume?: string }`, `type SlotExecutor = (slot, prompt, options?: SlotRunOptions) => Promise<SlotRun>`, `SlotRun.sessionId?: string`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/adapters/__tests__/stream.test.ts` 에 추가 (Q10 실측 캡처 모양):

```ts
describe('엔진 세션 id (SPEC §3.8)', () => {
  it('claude·cursor 는 result 줄의 session_id 를 낸다', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'b338a8c5-2660-4dd9-bba2-d665ae8e9759' });
    assert.ok(parseLine('claude', line).some((e) => e.kind === 'session' && e.id === 'b338a8c5-2660-4dd9-bba2-d665ae8e9759'));
  });
  it('codex 는 thread.started 의 thread_id 를 낸다', () => {
    const line = JSON.stringify({ type: 'thread.started', thread_id: '01a0cdb0-2134-7742-932e-ffeb293f61c1' });
    assert.deepEqual(parseLine('codex', line), [{ kind: 'session', id: '01a0cdb0-2134-7742-932e-ffeb293f61c1' }]);
  });
  it('id 가 문자열이 아니면 내지 않는다 — 지어내지 않는다', () => {
    const line = JSON.stringify({ type: 'result', result: 'ok', session_id: 42 });
    assert.ok(!parseLine('claude', line).some((e) => e.kind === 'session'));
  });
});
```

`src/adapters/__tests__/resolve.test.ts` 에 추가:

```ts
describe('resume argv (SPEC §3.8, Q10 실측)', () => {
  const catalog = loadEngines();
  it('claude 는 --resume <id> 를 붙인다', () => {
    const { argv } = buildInvocation(catalog, 'haiku', 'low', 'hi', { engine: 'claude', resume: 'S1' });
    const i = argv.indexOf('--resume');
    assert.ok(i >= 0 && argv[i + 1] === 'S1');
  });
  it('codex 는 exec resume <id> <prompt> 순서다', () => {
    const { argv } = buildInvocation(catalog, 'luna', 'low', 'hi', { engine: 'codex', resume: 'T1' });
    assert.deepEqual(argv.slice(0, 4), ['exec', 'resume', 'T1', 'hi']);
    assert.ok(argv.includes('-m'));
  });
  it('cursor 는 --resume <id> 를 붙인다', () => {
    const { argv } = buildInvocation(catalog, 'luna', 'low', 'hi', { engine: 'cursor', resume: 'C1' });
    const i = argv.indexOf('--resume');
    assert.ok(i >= 0 && argv[i + 1] === 'C1');
  });
  it('resume 이 없으면 argv 가 그대로다', () => {
    const { argv } = buildInvocation(catalog, 'luna', 'low', 'hi', { engine: 'codex' });
    assert.ok(!argv.includes('resume'));
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test src/adapters/__tests__/stream.test.ts src/adapters/__tests__/resolve.test.ts`
Expected: FAIL

- [ ] **Step 3: 구현**

`src/adapters/types.ts`:
- `RunEvent` 유니온에 `| { readonly kind: 'session'; readonly id: string }`
- `RunRequest` 에 `/** 이어 붙일 엔진 세션 id (SPEC §3.8). */ readonly resume?: string;`
- `RunResult` 에 `/** 스트림에서 읽은 엔진 세션 id. 못 읽으면 없다 — 지어내지 않는다. */ readonly sessionId?: string;`

`src/adapters/stream.ts`:
- `claudeEvents` 의 `if (event['type'] !== 'result') return [];` 뒤, `const out: RunEvent[] = [];` 다음 줄에:

```ts
  // Q10 실측: claude·cursor 모두 result 줄에 session_id 를 싣는다. 한 번만 내도록 result 줄에서만 읽는다.
  if (typeof event['session_id'] === 'string') out.push({ kind: 'session', id: event['session_id'] });
```

- `codexEvents` 의 `switch` 에 case 추가:

```ts
    case 'thread.started':
      return typeof event['thread_id'] === 'string' ? [{ kind: 'session', id: event['thread_id'] }] : [];
```

`src/adapters/run.ts`: `let costUsd …` 옆에 `let sessionId: string | undefined;`, 이벤트 `switch` 에 `case 'session': sessionId = event.id; break;`, 결과 객체에 `...(sessionId ? { sessionId } : {}),`.

`src/data/engines.ts` 의 `EngineSpec` 에:

```ts
  /**
   * 비대화 resume (SPEC §3.8, 2026-09-23 Q10 실측). claude·cursor 는 플래그, codex 는 `exec resume <id>` 서브커맨드다.
   * 선언이 없는 엔진에 resume 을 요청하면 **던진다** — 맥락 없는 새 실행으로 조용히 떨어지지 않는다.
   */
  readonly resume?:
    | { readonly kind: 'flag'; readonly flag: string }
    | { readonly kind: 'subcommand'; readonly argv: readonly string[] };
```

`data/engines.json`: claude·cursor 에 `"resume": { "kind": "flag", "flag": "--resume" }`, codex 에 `"resume": { "kind": "subcommand", "argv": ["resume"] }`. `$evidence` 에:

```json
    "resume": "2026-09-23 Q10 실측 (DECISIONS D-031): claude -p --resume <id> · codex exec resume <id> <prompt> (-m·effort 를 받는다) · cursor-agent -p --resume <id>. 무작위 코드워드를 셋 다 회수했고 id 는 불변이다."
```

`src/adapters/resolve.ts`:
- `InvocationOptions` 에 `/** 이어 붙일 엔진 세션 id (SPEC §3.8). */ readonly resume?: string;`
- `const argv = [...spec.promptArgv, prompt, spec.modelFlag, modelId];` 를 아래로 바꾼다:

```ts
  const resume = options.resume;
  if (resume !== undefined && !spec.resume) {
    throw new EngineError(`${target} 는 resume 선언이 없다 — 맥락 없는 새 실행으로 바꾸지 않는다 (SPEC §3.8).`);
  }
  const argv =
    resume !== undefined && spec.resume?.kind === 'subcommand'
      ? [...spec.promptArgv, ...spec.resume.argv, resume, prompt, spec.modelFlag, modelId]
      : [...spec.promptArgv, prompt, spec.modelFlag, modelId];
```

- `return` 바로 앞에:

```ts
  if (resume !== undefined && spec.resume?.kind === 'flag') argv.push(spec.resume.flag, resume);
```

`src/adapters/engine.ts` 의 `argvFor` 옵션에 `...(req.resume !== undefined ? { resume: req.resume } : {}),`.

`src/core/executor.ts`:

```ts
export interface SlotRunOptions {
  /** 이어 붙일 엔진 세션 id. **primary 에만** 온다 — reviewer 는 잇지 않는다 (SPEC §6.4.3). */
  readonly resume?: string;
}

export type SlotExecutor = (slot: ResolvedSlot, prompt: string, options?: SlotRunOptions) => Promise<SlotRun>;
```

`SlotRun` 에 `/** 엔진 세션 id (SPEC §3.8). 못 읽었으면 없다. */ readonly sessionId?: string;`. `createExecutor` 의 반환 함수를 `async (slot, prompt, runOptions) =>` 로 바꾸고 `start({...})` 에 `...(runOptions?.resume !== undefined ? { resume: runOptions.resume } : {}),`, 반환 객체에 `...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),`.

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test src/adapters/__tests__/stream.test.ts src/adapters/__tests__/resolve.test.ts && npm run gate`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/adapters src/data/engines.ts data/engines.json src/core/executor.ts
git commit -m "feat(adapters): 엔진 세션 id 를 읽고 resume argv 를 만든다 — Q10 실측 그대로 (SPEC §3.8)"
```

---

### Task 11: resume 정책 — 같은 슬롯 primary 만, reviewer 는 절대

**Files:**
- Modify: `src/core/duo.ts` (`DuoOptions.resumePrimary`), `src/core/delegate.ts` (`resumePrimary` 입력, `primarySession` 출력), `src/core/session.ts` (정책·결과 기록·실패 안내)
- Test: `src/core/__tests__/duo.test.ts`, `src/core/__tests__/session.test.ts`

**Interfaces:**
- Consumes: Task 10 `SlotRunOptions`·`SlotRun.sessionId`, Task 1 `EngineSessionRef`
- Produces: `DuoOptions.resumePrimary?: string`, `DelegateInput.resumePrimary?: string`, `Delegated.primarySession?: EngineSessionRef`, `result.engineSession` 기록

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/core/__tests__/duo.test.ts` 에 추가:

```ts
describe('resume 은 primary 에만 (SPEC §6.4.3)', () => {
  it('primary 는 넘겨받은 엔진 세션을 잇고 reviewer 는 잇지 않는다', async () => {
    const seen: { label: string; resume: string | undefined }[] = [];
    const exec: SlotExecutor = (slot, _prompt, options) => {
      seen.push({ label: slot.label, resume: options?.resume });
      return Promise.resolve({ ok: true, text: slot.label === 'Haiku' ? 'PASS' : 'ran', rawStdout: '', rawStderr: '', durationMs: 1 });
    };
    await runDuo(matrix, planR01, exec, 'task', new Budget(20, 2_000_000), { resumePrimary: 'eng-1' });
    assert.deepEqual(seen.map((s) => s.resume), ['eng-1', undefined]);
  });
});
```

`src/core/__tests__/session.test.ts` 에 헬퍼와 `describe` 추가:

```ts
/** primary 는 세션 id 를 돌려주고, 두 번째 primary 실행의 성패를 고를 수 있다. */
const resumeSpy = (secondOk = true) => {
  const calls: { label: string; prompt: string; resume: string | undefined }[] = [];
  let primaries = 0;
  const exec: SlotExecutor = (slot, prompt, options) => {
    calls.push({ label: slot.label, prompt, resume: options?.resume });
    if (slot.label === 'Haiku') return Promise.resolve(reply('PASS'));
    primaries += 1;
    const ok = primaries === 1 || secondOk;
    return Promise.resolve({ ...reply(ok ? 'ran' : '', ok), sessionId: `eng-${primaries}` });
  };
  return { exec, calls };
};

describe('대화 세션 — resume (SPEC §6.4.3)', () => {
  it('직전 위임과 같은 슬롯이면 엔진 세션을 잇고, 그 실행 이후 대화만 싣는다', async () => {
    isolate();
    const r = resumeSpy();
    const { session } = make(conductSpy().exec, undefined, r.exec);
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    const primaries = r.calls.filter((c) => c.label !== 'Haiku');
    assert.deepEqual(primaries.map((c) => c.resume), [undefined, 'eng-1']);
    assert.equal(primaries[1]?.prompt, '이 타입 에러 고쳐줘');
  });

  it('reviewer 는 한 번도 잇지 않는다', async () => {
    isolate();
    const r = resumeSpy();
    const { session } = make(conductSpy().exec, undefined, r.exec);
    for (let i = 0; i < 2; i += 1) {
      await session.send('이 타입 에러 고쳐줘');
      await session.approve();
    }
    assert.ok(r.calls.filter((c) => c.label === 'Haiku').every((c) => c.resume === undefined));
  });

  it('이어 붙인 실행이 실패하면 사유를 남기고 새 세션으로 조용히 다시 돌리지 않는다', async () => {
    isolate();
    const r = resumeSpy(false);
    const { session } = make(conductSpy().exec, undefined, r.exec);
    await session.send('이 타입 에러 고쳐줘');
    await session.approve();
    await session.send('이 타입 에러 고쳐줘');
    const out = await session.approve();
    assert.ok(out.some((rec) => rec.kind === 'error' && /조용히 바꾸지 않는다/.test(rec.text)));
    assert.equal(r.calls.filter((c) => c.label !== 'Haiku').length, 2);
  });

  it('이어 붙인 실행이 실패하면 다음 위임은 잇지 않고 맥락을 실어 새로 띄운다', async () => {
    isolate();
    const r = resumeSpy(false);
    const { session } = make(conductSpy().exec, undefined, r.exec);
    for (let i = 0; i < 3; i += 1) {
      await session.send('이 타입 에러 고쳐줘');
      await session.approve();
    }
    const primaries = r.calls.filter((c) => c.label !== 'Haiku');
    assert.deepEqual(primaries.map((c) => c.resume), [undefined, 'eng-1', undefined]);
    assert.match(primaries[2]?.prompt ?? '', /^\[최근 대화\]/);
  });
});
```

> 정책 (SPEC §6.4.3 "**직전** 성공한 위임의 primary"): **가장 최근 위임**이 성공해 엔진 세션을 남겼을 때만 잇는다. 그 위임이 실패했으면 더 앞의 성공을 찾아 잇지 않는다 — 실패한 맥락을 다시 물려받는 재시도는 같은 실패를 되풀이한다. SPEC §3.8 "재시도는 맥락을 실은 새 실행" 과 같은 결론이다.

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test src/core/__tests__/duo.test.ts src/core/__tests__/session.test.ts`
Expected: FAIL

- [ ] **Step 3: 구현**

`src/core/duo.ts`:
- `DuoOptions` 에 `/** primary 가 이어 붙일 엔진 세션 (SPEC §6.4.3). reviewer 에는 절대 가지 않는다. */ readonly resumePrimary?: string;`
- primary 호출을 바꾼다:

```ts
  const primary = await execute(
    primarySlot,
    task,
    options.resumePrimary !== undefined ? { resume: options.resumePrimary } : undefined,
  );
```

(reviewer 호출 `execute(reviewerSlot, reviewPrompt(...))` 은 **그대로** — 세 번째 인자를 주지 않는 것이 정책이다.)

`src/core/delegate.ts`:
- `DelegateInput` 에 `readonly resumePrimary?: string;`
- `Delegated` 에 `readonly primarySession?: EngineSessionRef;` (`import type { EngineSessionRef } from './transcript.ts';`)
- `runDuo` 호출:

```ts
  const duo = await runDuo(matrix, plan, input.execute, input.prompt, budget,
    input.resumePrimary !== undefined ? { resumePrimary: input.resumePrimary } : {});
```

- 반환 객체에:

```ts
    // 성공한 primary 만 이을 수 있다 — 실패한 세션을 다음에 이으면 실패를 물려받는다.
    ...(run.ok && run.sessionId
      ? { primarySession: { engine: slot.engine, modelId: slot.modelId, effort: slot.effort, id: run.sessionId } }
      : {}),
```

`src/core/session.ts` — `approve()` 의 `const context = …` 두 줄을 아래로 바꾼다:

```ts
      const ref = this.resumable(pending.plan);
      const context = buildContext(this.records(), this.contextLimits, {
        before: this.turn,
        ...(ref ? { after: ref.turn } : {}),
      });
      const prompt = context ? `[최근 대화]\n${context}\n\n[이번 요청]\n${pending.title}` : pending.title;
```

`delegate({...})` 호출에 `...(ref ? { resumePrimary: ref.id } : {}),` 를 더하고, `result` append 에 `...(d.primarySession ? { engineSession: d.primarySession } : {}),` 를 더한다. result append **뒤**, summarize **앞**에:

```ts
      if (ref && !d.ok) {
        out.push(this.append({
          kind: 'error',
          text: '이어 붙인 엔진 세션이 실패했다 — 새 세션으로 조용히 바꾸지 않는다. 다시 보내면 맥락을 실어 새로 띄운다.',
        }));
      }
```

(이 문구가 참인 이유: 실패한 결과에는 `engineSession` 이 없고, `resumable()` 은 **가장 최근 결과만** 보므로 다음 위임은 잇지 않는다.)

클래스에 헬퍼 추가:

```ts
  /**
   * 이을 엔진 세션 (SPEC §6.4.3): **가장 최근 위임**이 성공해 엔진 세션을 남겼고, 그 primary 가
   * 이번 primary 와 엔진·모델·effort 가 모두 같을 때만. 최근 위임이 실패했으면 더 앞을 찾지 않는다.
   * 세션 폴더는 이 세션이 늘 같다 (codex 는 cwd 로 세션을 거른다).
   */
  private resumable(plan: AssignmentPlan): { id: string; turn: number } | null {
    const last = this.records().findLast((r) => r.kind === 'result');
    if (last?.kind !== 'result' || !last.engineSession) return null;
    const p = plan.slots.primary;
    const s = last.engineSession;
    return s.engine === p.engine && s.modelId === p.modelId && s.effort === p.effort ? { id: s.id, turn: last.turn } : null;
  }
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test src/core/__tests__/duo.test.ts src/core/__tests__/session.test.ts && npm run gate`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/core/duo.ts src/core/delegate.ts src/core/session.ts src/core/__tests__/duo.test.ts src/core/__tests__/session.test.ts
git commit -m "feat(core): resume 정책 — 같은 슬롯 primary 만 잇고 reviewer 는 잇지 않는다, 실패는 조용히 바꾸지 않는다 (SPEC §6.4.3)"
```

---

### Task 12: 실사용 검증과 기록 (v2.1 완료 판정)

**Files:**
- Modify: `docs/PLAN.md` (S10 절 ✅ + 결과), `docs/SPEC.md` (§6.4 에 실측 메모), `docs/DECISIONS.md` (필요 시 후속 Q)

**이 Task 는 실제 엔진을 띄운다 — 구독 사용량을 쓴다. 시작 전에 사용자 승인을 받는다.**

- [ ] **Step 1: 게이트**

Run: `npm run gate`
Expected: 전부 통과

- [ ] **Step 2: PRD §7 v2.1 완료 판정을 GUI 에서 실제로 돈다**

`npm run gui` 로 띄운다. **project 세션**(이 저장소의 워크트리 하나 — 쓰기 끔)과 **scratch 세션** 각각에서:

1. "넌 누구니" → 직접 답 말풍선, 비용 줄, 승인 없음. (G6)
2. "이 타입 에러 고쳐줘" 류 작업 → 배정 카드 → 승인 → 결과 카드 + 요약 + (증거 없으면) 사다리 제안.
3. "방금 거 한 줄로 다시 설명해" → 앞 결과를 참조한 답, 또는 작업이면 위임 프롬프트에 앞 요약이 실린다. (G7)
4. 같은 슬롯으로 한 번 더 위임 → 원시 로그(`.hs-orc/runs/…/stdout`)에서 primary 가 **같은 엔진 세션 id** 로 이어졌는지 확인.
5. 앱을 닫았다 다시 열고 세션 목록에서 같은 세션을 연다 → 대화가 그대로.

각 항목의 결과(통과/실패·실제 비용·세션 id)를 적는다. 실패하면 멈추고 사람에게 올린다.

- [ ] **Step 3: 기록한다**

`docs/PLAN.md` 의 단계 개요 표에 행 추가:

```markdown
| S10 | 대화 세션 (v2.1) | PRD §7 v2.1 완료 판정 — 잡담·위임·후속이 project·scratch 양쪽에서 통과 | S9 |
```

그리고 `## S9` 절 뒤에 `## S10 — 대화 세션 (v2.1)  ✅ <날짜>` 절: 상세 계획 경로(`docs/superpowers/plans/2026-09-23-conversation-session.md`), Step 2 의 실측 결과, 아래 후속 목록.

**후속 목록 (이 계획에서 고치지 않은 것):**
- `delegate()` 의 journal `charge` 가 reviewer 가 돌면 reviewer 의 charge 다 (`budget.charges.at(-1)`) — `GuiService.run` 때부터의 동작.
- git 이 아닌 **project** 폴더에서 codex 위임은 여전히 거절된다 (Task 7 은 스크래치에만 `nonGit`).
- 다른 cwd 에서의 resume, resume 중 모델·effort 변경, 긴 세션 압축 — 실측하지 않았다 (D-031 Q10 메모).
- 세션을 여러 개 동시에 열 수 없다 — GuiService 는 활성 세션 하나.
- CLI·TUI 는 아직 `ConversationSession` 을 쓰지 않는다 (D-031 결정 8 — 첫 셸은 GUI). CLI `--mode pingpong` 의 세션 고정 배정은 그대로다.
- Q12 스크래치 보존·정리, Q13 위임 엔진의 전역 설정 격리.

- [ ] **Step 4: 커밋**

```bash
git add docs/PLAN.md docs/SPEC.md docs/DECISIONS.md
git commit -m "docs(plan): S10 — 대화 세션 v2.1 실사용 결과와 후속"
```
