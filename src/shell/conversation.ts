/**
 * 대화 세션 조립 — GUI·CLI 가 **같은 조립**을 쓴다 (D-056). 셸마다 조립이 갈리면 같은 세션이
 * 셸마다 다른 실행기로 돈다 (D-026 전례). Electron 을 import 하지 않는다.
 */
import type { RowClassifier } from '../adapters/jev.ts';
import { loadEngines } from '../data/engines.ts';
import { loadLimits, type ApprovalMode } from '../data/limits.ts';
import { loadMatrix } from '../data/matrix.ts';
import { Budget } from '../core/budget.ts';
import { uncommittedFiles } from '../core/evidence-gather.ts';
import { createExecutor, type SlotExecutor } from '../core/executor.ts';
import { defaultAutoVerify } from '../core/auto-verify.ts';
import type { Journal } from '../core/journal.ts';
import { ConversationSession } from '../core/session.ts';
import { readSessionLog, replaySpend, type SessionKind } from '../core/transcript.ts';
import { repoRoot } from './gui/worktree.ts';

/**
 * codex 의 git 검사를 끌지 (D-055). 스크래치는 언제나 끈다. git 이 아닌 project 폴더는 **읽기 전용일 때만** 끈다 —
 * 쓰기를 되돌릴 git 이 없고 바뀐 파일 증거도 `git status` 로 모은다. 쓰기를 켜면 codex 가 거절하는 그대로 둔다.
 */
export function skipGitCheck(kind: SessionKind, inGit: boolean, write: boolean): boolean {
  return kind === 'scratch' || (!inGit && !write);
}

/** 세션 하나의 Budget — 기록의 `spend` 를 재생해 되살린다 (D-054). 상한은 세션 단위다 (D-032 A2). */
export function restoreBudget(dir: string, id: string, budgetUsd = loadLimits().budgetUsd): Budget {
  const budget = new Budget(budgetUsd, loadLimits().tokenBudget);
  replaySpend(budget, readSessionLog(dir, id).records);
  return budget;
}

export interface AssembleInput {
  readonly kind: SessionKind;
  readonly dir: string;
  readonly id: string;
  readonly budget: Budget;
  readonly journal: Journal;
  /** 테스트용 — 주면 지휘자·위임 모두 이것을 쓴다. */
  readonly execute?: SlotExecutor;
  /** Jev 분류기 (D-065). 합성 루트가 `defaultJev()` 를 넘긴다 — 없으면 옛 경로(규칙 → 지휘자 SUGGEST). */
  readonly classifier?: RowClassifier;
  /** 기록이 빈 새 세션의 시작 방식 — 없으면 `limits.json`. 테스트가 고정한다 (D-064). */
  readonly approvalMode?: ApprovalMode;
  /** false 면 세션 방식과 무관하게 자동 시작하지 않는다 (D-085 결정 5 — `session send` 의 `--run` 없음). */
  readonly autoStart?: boolean;
  /** 앱 실행 카드를 세운다 (D-091) — 터미널 창을 여는 GUI 만 true 다. */
  readonly runCards?: boolean;
}

export function assembleSession(input: AssembleInput): ConversationSession {
  const { kind, dir, id, budget, journal, execute, classifier, approvalMode, autoStart, runCards } = input;
  const catalog = loadEngines();
  const timeout = loadLimits().runTimeoutMs;
  const inGit = kind === 'project' && repoRoot(dir) !== null;
  return new ConversationSession({
    matrix: loadMatrix(),
    catalog,
    kind,
    dir,
    id,
    budget,
    journal,
    ...(classifier ? { classifier } : {}),
    ...(approvalMode ? { approvalMode } : {}),
    ...(autoStart === false ? { autoStart } : {}),
    ...(runCards ? { runCards } : {}),
    // 쓰기 위임 뒤 Core 가 고른 검증 명령을 codex sandbox 안에서 돌린다 (D-096). 실행기를 주입한 조립(테스트)에서는 켜지 않는다 —
    // 가짜 엔진 뒤에 진짜 sandbox·npm 이 돌면 안 된다. 스크래치는 쓰기가 없다.
    ...(execute === undefined && kind === 'project' ? { autoVerify: defaultAutoVerify() } : {}),
    // 카드가 git 아닌 폴더의 쓰기 거절을 미리 말한다 (D-074). 실행기의 `nonGit` 과 같은 판정이다. 세션은 카드를 세울 때 `gitProbe` 로 다시 본다 (D-088) —
    // 실행기는 조립 때 값 그대로다: git 이 된 폴더의 읽기 전용 위임에 `--skip-git-repo-check` 가 남는 것은 무해하고(D-073 사실 9), 쓰기에는 원래 붙지 않는다.
    inGit,
    // 쓰기 위임이 설 때만 부른다 (D-086 H5) — 자동 쓰기가 덮을 수 있는 미커밋 변경을 미리 알린다.
    // git status 가 실패하면 null — 세션이 모르는 상태로 묻는다 (fail-closed). 세션은 폴더가 git 일 때만 부른다 —
    // 스캐폴딩·git init 뒤 git 이 된 폴더도 같은 보호를 받게 git 여부와 무관하게 넘긴다 (D-088).
    ...(kind === 'project' ? { dirtyFiles: () => uncommittedFiles(dir), gitProbe: () => repoRoot(dir) !== null } : {}),
    // 지휘자(직접 답·요약)만 격리한다 (D-032 B1) — 위임 실행기(executorFor)는 그대로 사용자 설정을 싣는다.
    conduct: execute ?? createExecutor(catalog, dir, timeout, { nonGit: skipGitCheck(kind, inGit, false), isolate: true }),
    executorFor: (write) => execute ?? createExecutor(catalog, dir, timeout, { write, nonGit: skipGitCheck(kind, inGit, write) }),
  });
}
