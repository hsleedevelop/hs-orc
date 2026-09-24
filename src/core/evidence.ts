/**
 * 증거 수집기 (SPEC §5, PRD G4).
 *
 * `운영 기준` 열이 완료의 정의다 (D-010). 완료 판정 로직을 새로 발명하지 않고
 * 11행 각각이 요구하는 **증거 형태**를 표로 두고, 모였을 때만 완료로 친다.
 *
 * **"성공했습니다"라는 산문은 증거가 아니다.** 명령과 exit code, `file:line`,
 * 같은 환경의 측정값, 인용 원문만 받는다 — 모양이 아니면 거절한다.
 */
import type { Assignment } from '../data/matrix.ts';

export type EvidenceKind =
  | 'command'
  | 'document-section'
  | 'changed-files'
  | 'measurement'
  | 'citation'
  | 'review'
  | 'ordering'
  | 'test-files';

export type Evidence =
  /** 실행 명령과 **exit code**. 출력만 있고 코드가 없으면 증거가 아니다. */
  | { readonly kind: 'command'; readonly cmd: string; readonly exitCode: number; readonly output: string; readonly phase?: string }
  | { readonly kind: 'document-section'; readonly name: string; readonly text: string }
  | { readonly kind: 'changed-files'; readonly files: readonly string[] }
  /** 같은 환경의 측정값. `env` 가 다르면 3점 측정이 성립하지 않는다. */
  | { readonly kind: 'measurement'; readonly label: string; readonly value: number; readonly env: string }
  /** `path:line` 형태만 받는다. */
  | { readonly kind: 'citation'; readonly ref: string; readonly quote: string }
  | { readonly kind: 'review'; readonly reviewer: string; readonly verdict: 'pass' | 'fail'; readonly text: string }
  | { readonly kind: 'ordering'; readonly earlierLabel: string; readonly earlier: string; readonly laterLabel: string; readonly later: string }
  /** 선언된 기존 테스트의 변화 (D-047). `weakened` 는 줄이 바뀌거나 지워진 파일, `added` 는 새 파일·줄 추가 — 추가는 허용이다. */
  | { readonly kind: 'test-files'; readonly weakened: readonly string[]; readonly added: readonly string[] };

export interface Requirement {
  readonly kind: EvidenceKind;
  readonly min: number;
  readonly what: string;
  /** `document-section` 은 이 이름들이 **전부** 있어야 한다. */
  readonly sections?: readonly string[];
  /** `command` 는 이 phase 들이 전부 있어야 한다. */
  readonly phases?: readonly string[];
}

/** SPEC §5 표를 그대로 옮긴 것이다. 여기를 바꾸려면 SPEC 을 먼저 바꾼다. */
export const REQUIREMENTS: Readonly<Record<string, readonly Requirement[]>> = {
  R01: [{ kind: 'command', min: 1, what: '기존 test 실행 결과 + exit code' }],
  R02: [{ kind: 'document-section', min: 2, what: '결정 기준 목록 + 반례 목록', sections: ['결정 기준', '반례'] }],
  R03: [{ kind: 'ordering', min: 1, what: 'acceptance test 정의 시각이 구현 시작보다 앞' }],
  R04: [
    { kind: 'changed-files', min: 1, what: '변경 파일 목록' },
    { kind: 'command', min: 1, what: '회귀 suite 결과' },
  ],
  R05: [{ kind: 'command', min: 2, what: '수정 전 실패 로그 + 수정 후 통과 로그', phases: ['before', 'after'] }],
  R06: [{ kind: 'command', min: 3, what: '실패 재현 → 최소 수정 → 회귀 3단계', phases: ['reproduce', 'fix', 'regress'] }],
  R07: [{ kind: 'measurement', min: 3, what: 'baseline / 변경 후 / 재측정 3점 (같은 환경)' }],
  R08: [
    { kind: 'citation', min: 1, what: '표본 코드 경로' },
    { kind: 'command', min: 1, what: '실제 query 결과' },
  ],
  R09: [{ kind: 'document-section', min: 3, what: 'batch 경계 + checkpoint + rollback 지점', sections: ['batch', 'checkpoint', 'rollback'] }],
  R10: [{ kind: 'document-section', min: 3, what: '대안 / 제약 / 실행계획 세 절', sections: ['대안', '제약', '실행계획'] }],
  R11: [
    { kind: 'review', min: 1, what: '독립 리뷰 결과' },
    { kind: 'command', min: 1, what: '실제 검사·test·배포 관측' },
  ],
};

export interface Rejection {
  readonly evidence: Evidence;
  readonly why: string;
}

const CITATION = /^[^\s:]+:\d+(-\d+)?$/;

/** 모양 검사. 산문을 증거로 받지 않는 유일한 방어선이다. */
export function validate(evidence: Evidence): string | null {
  switch (evidence.kind) {
    case 'command':
      if (!evidence.cmd.trim()) return '실행 명령이 비었다';
      if (!Number.isInteger(evidence.exitCode)) return 'exit code 가 없다 — 출력만으로는 증거가 아니다';
      return null;
    case 'document-section':
      if (!evidence.name.trim()) return '절 이름이 비었다';
      if (evidence.text.trim().length < 10) return '절 내용이 사실상 비었다';
      return null;
    case 'changed-files':
      return evidence.files.length > 0 ? null : '변경 파일 목록이 비었다';
    case 'measurement':
      if (!Number.isFinite(evidence.value)) return '측정값이 수가 아니다';
      if (!evidence.env.trim()) return '측정 환경이 비었다 — 다른 환경의 값은 비교할 수 없다';
      return null;
    case 'citation':
      return CITATION.test(evidence.ref) ? null : `인용은 file:line 형태여야 한다 (받은 값: ${evidence.ref})`;
    case 'review':
      if (!evidence.reviewer.trim()) return '리뷰어가 비었다';
      return null;
    case 'test-files':
      return null;
    case 'ordering':
      return Date.parse(evidence.earlier) < Date.parse(evidence.later)
        ? null
        : `${evidence.earlierLabel} 이 ${evidence.laterLabel} 보다 앞이어야 한다`;
  }
}

export interface EvidenceReport {
  /** 요구 증거가 모였는가 (PRD G4). 완료는 `contradictions` 도 비어야 한다 — `outcomeOf` (D-043). */
  readonly satisfied: boolean;
  /** 모양은 맞지만 **나쁜 결과**를 말하는 증거 — 기대와 다른 exit, reviewer FAIL (D-043). */
  readonly contradictions: readonly string[];
  readonly missing: readonly string[];
  readonly rejected: readonly Rejection[];
  readonly accepted: readonly Evidence[];
  readonly summary: string;
}

/** 실패가 **정상**인 phase (SPEC §5: R05 "수정 전 실패 로그", R06 "실패 재현"). 나머지와 phase 없는 명령은 exit 0 을 기대한다. */
export const FAILING_PHASES: ReadonlySet<string> = new Set(['before', 'reproduce']);

/**
 * 증거가 완료가 아니라고 **말하는가** (D-043). 모양 검사(`validate`)와 별개다 — 실패한 테스트도
 * 모양이 맞는 증거이고, R05 `before` 처럼 실패해야 하는 단계도 있다. reviewer `unknown` 은 증거가
 * 아예 생기지 않으므로 여기 오지 않는다 (pass 로도 fail 로도 치지 않는다).
 */
/**
 * 명령이 **돌지 못한** 종료인가 (D-046) — `sh` 규약의 126(실행 불가)·127(명령 없음)과 `runCommand` 의
 * -1(시그널·시간 초과). "돌았고 실패했다" 와 다르다: 모델이 고칠 수 없는 환경 문제이고, 재현도 아니다.
 * 도구가 exit 1 로 내는 환경 오류(npm `MODULE_NOT_FOUND` 등)는 exit 만으로 가를 수 없다 — 출력은 파싱하지 않는다.
 */
export function notRun(exitCode: number): string | null {
  if (exitCode === 126 || exitCode === 127) return '명령을 찾지 못했거나 실행할 수 없다';
  if (exitCode === -1) return '시그널·시간 초과로 끝났다';
  return null;
}

export function contradiction(evidence: Evidence): string | null {
  if (evidence.kind === 'command') {
    const label = evidence.phase ? `${evidence.phase}:${evidence.cmd}` : evidence.cmd;
    // 돌지 못한 명령은 phase 와 무관하게 나쁜 결과다 — before 의 127 을 "재현" 으로 읽지 않는다 (D-046).
    const env = notRun(evidence.exitCode);
    if (env) return `\`${label}\` 가 실행되지 못했다 (exit ${evidence.exitCode} — ${env})`;
    const expectFail = evidence.phase !== undefined && FAILING_PHASES.has(evidence.phase);
    if ((evidence.exitCode !== 0) === expectFail) return null;
    return expectFail ? `\`${label}\` 는 실패해야 하는 단계인데 exit 0` : `\`${label}\` exit=${evidence.exitCode}`;
  }
  if (evidence.kind === 'review' && evidence.verdict === 'fail') return `reviewer ${evidence.reviewer} FAIL`;
  // 게이트를 통과시키려고 기존 테스트를 약하게 만드는 길을 막는다 — 추가는 허용한다 (D-047).
  if (evidence.kind === 'test-files' && evidence.weakened.length > 0) return `기존 테스트가 약해졌다 — ${evidence.weakened.join(' · ')}`;
  return null;
}

/** 실행이 끝난 결정의 outcome. 순서가 판정이다: 실행 실패 → 나쁜 결과의 증거 → 증거 충족 (D-043). */
export type SettledOutcome = 'ok' | 'rework' | 'unverified' | 'wrong';

export function outcomeOf(runOk: boolean, report: EvidenceReport): SettledOutcome {
  if (!runOk) return 'wrong';
  if (report.contradictions.length > 0) return 'rework';
  return report.satisfied ? 'ok' : 'unverified';
}

export function collect(assignment: Assignment, items: readonly Evidence[]): EvidenceReport {
  const requirements = REQUIREMENTS[assignment.id] ?? [];
  const accepted: Evidence[] = [];
  const rejected: Rejection[] = [];

  for (const item of items) {
    const why = validate(item);
    if (why) rejected.push({ evidence: item, why });
    else accepted.push(item);
  }

  const missing: string[] = [];
  for (const requirement of requirements) {
    const matching = accepted.filter((e) => e.kind === requirement.kind);
    if (matching.length < requirement.min) {
      missing.push(`${requirement.what} (${matching.length}/${requirement.min})`);
      continue;
    }
    if (requirement.sections) {
      const names = new Set(matching.map((e) => (e.kind === 'document-section' ? e.name : '')));
      const absent = requirement.sections.filter((s) => ![...names].some((n) => n.includes(s)));
      if (absent.length > 0) missing.push(`${requirement.what} — 빠진 절: ${absent.join(', ')}`);
    }
    if (requirement.phases) {
      const phases = new Set(matching.map((e) => (e.kind === 'command' ? (e.phase ?? '') : '')));
      const absent = requirement.phases.filter((p) => !phases.has(p));
      if (absent.length > 0) missing.push(`${requirement.what} — 빠진 단계: ${absent.join(', ')}`);
    }
  }

  const satisfied = missing.length === 0 && requirements.length > 0;
  const contradictions = accepted.map(contradiction).filter((c): c is string => c !== null);
  return {
    satisfied,
    contradictions,
    missing,
    rejected,
    accepted,
    summary: contradictions.length > 0
      ? `검증 결과 완료가 아니다 — ${contradictions.join(' · ')}`
      : satisfied
        ? `증거 충족 — ${assignment.operatingCriterion}`
        : `증거 미충족 (${missing.length}건)${rejected.length ? ` · 거절 ${rejected.length}건` : ''}`,
  };
}
