/**
 * 모델·effort → 엔진이 실제로 받는 argv (SPEC §3.2~§3.4).
 * **CLI 플래그 문자열은 이 디렉터리 밖으로 나가지 않는다.**
 * S1 범위: argv 생성과 바이너리 해석까지. 스트림 파싱·취소는 S2.
 */
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import type { Effort, ModelKey } from '../data/matrix.ts';
import { EFFORTS } from '../data/matrix.ts';
import type { EngineName, EngineSpec, Engines } from '../data/engines.ts';

export class EngineError extends Error {
  override name = 'EngineError';
}

/** 정규 어휘 밖이면 던진다 — `claude` 는 잘못된 effort 를 경고만 내고 삼킨다 (D-011, SPEC §0.1-2). */
export function assertEffort(value: string): asserts value is Effort {
  if (!(EFFORTS as readonly string[]).includes(value)) {
    throw new EngineError(`정규 어휘 밖의 effort: "${value}" (허용: ${EFFORTS.join(' | ')})`);
  }
}

const isExecutable = (candidate: string): boolean => {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * 바이너리 해석. cursor 는 `cursor-cli` 가 없으면 `cursor-agent` 로 폴백한다 (D-005).
 * PATH 를 직접 훑는다 — 셸을 거치면 작업 문자열이 명령으로 해석될 여지가 생긴다.
 */
export function resolveBinary(spec: EngineSpec): string {
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);

  for (const candidate of spec.binaries) {
    if (candidate.includes('/')) {
      if (isExecutable(candidate)) return candidate;
      continue;
    }
    for (const dir of dirs) {
      const full = path.join(dir, candidate);
      if (isExecutable(full)) return full;
    }
  }
  throw new EngineError(`실행 가능한 바이너리를 찾지 못했다: ${spec.binaries.join(' → ')}`);
}

export interface Invocation {
  readonly engine: EngineName;
  readonly bin: string;
  readonly argv: readonly string[];
  readonly modelId: string;
  readonly effort: Effort;
}

/**
 * 지원하지 않는 조합은 **명시적 실패**다. 가장 가까운 모델로 말없이 바꾸지 않는다 (D-004).
 * `resolveBinary` 를 타지 않는 순수 함수라 테스트가 프로세스를 띄우지 않는다.
 */
export interface InvocationOptions {
  readonly engine?: EngineName;
  /** Cursor `-fast` 옵트인 (D-023). 기본은 꺼짐 — 추론 품질 우선(SPEC §3.3). */
  readonly fast?: boolean;
  /**
   * 파일 쓰기 허용 (D-025). 기본은 꺼짐 — 외부 쓰기는 사람에게 올리는 조건이다(PLAN).
   * **reviewer 슬롯에는 절대 켜지지 않는다.** 그 강제는 `createExecutor` 가 한다.
   */
  readonly write?: boolean;
  /** 스크래치 세션 (SPEC §6.4.1) — git 저장소 밖이다. 엔진이 선언한 `nonGitArgv` 를 붙인다. */
  readonly nonGit?: boolean;
  /** 이어 붙일 엔진 세션 id (SPEC §3.8). */
  readonly resume?: string;
  /**
   * 사용자 전역 hook·설정·MCP·skills 를 싣지 않는다 (D-032 B1). **지휘자 역할에만** 켠다.
   * 선언(`isolateArgv`)이 없는 엔진에 요청하면 던진다 — 격리 없이 조용히 돌리지 않는다.
   */
  readonly isolate?: boolean;
}

export function buildInvocation(
  catalog: Engines,
  model: ModelKey,
  effort: string,
  prompt: string,
  engineOrOptions?: EngineName | InvocationOptions,
): Omit<Invocation, 'bin'> {
  const options: InvocationOptions =
    typeof engineOrOptions === 'string' ? { engine: engineOrOptions } : (engineOrOptions ?? {});
  const engine = options.engine;
  assertEffort(effort);
  // 스크래치(git 밖)에는 쓰기를 주지 않는다 (SPEC §6.4.1). 셸·세션의 검사만 믿지 않고 argv 를 만드는 곳에서도 막는다.
  if (options.write === true && options.nonGit === true) {
    throw new EngineError('git 밖(스크래치) 실행에는 쓰기를 줄 수 없다 (SPEC §6.4.1).');
  }

  const modelSpec = catalog.models[model];
  const target = engine ?? modelSpec.defaultEngine;
  const availability = modelSpec.availability[target];
  if (availability === null) {
    throw new EngineError(`${target} 는 ${model} 를 제공하지 않는다. 대체 모델로 바꾸지 않는다 — 배정을 바꾸거나 엔진을 바꿔라.`);
  }
  if (!availability.efforts.includes(effort)) {
    throw new EngineError(`${target}/${model} 는 effort "${effort}" 를 지원하지 않는다 (지원: ${availability.efforts.join(', ')}).`);
  }

  const spec = catalog.engines[target];
  // `-fast` 는 **모델별 옵트인**이고, 없는 모델이면 일반 변형으로 떨어뜨리지 않고 던진다 (D-023).
  if (options.fast === true) {
    if (spec.effort.kind !== 'modelSuffix') {
      throw new EngineError(`${target} 에는 fast 변형이 없다 (fast 는 cursor 전용이다).`);
    }
    if (availability.fast !== true) {
      throw new EngineError(`cursor 에 ${model} 의 -fast 변형이 없다. 일반 변형으로 말없이 바꾸지 않는다 (D-023).`);
    }
  }

  const baseId = availability.idTemplate
    ? availability.idTemplate.replace('{effort}', effort)
    : (availability.id ?? '');
  const modelId = options.fast === true ? `${baseId}-fast` : baseId;
  if (!modelId) throw new EngineError(`${target}/${model} 의 모델 id 가 비어 있다 — engines.json 이 깨졌다.`);

  const resume = options.resume;
  if (resume !== undefined && !spec.resume) {
    throw new EngineError(`${target} 는 resume 선언이 없다 — 맥락 없는 새 실행으로 바꾸지 않는다 (SPEC §3.8).`);
  }
  // codex exec resume 은 -s/--sandbox 를 받지 않는다 (2026-09-23 실측, $evidence.resume). 쓰기를 조용히
  // 빼고 읽기 전용으로 잇지 않는다 — 던져서 호출자가 새 실행으로 넘어가게 한다 (final-review #1).
  if (resume !== undefined && options.write === true && spec.resume?.write === false) {
    throw new EngineError(`${target} 는 resume 상태에서 쓰기를 받지 않는다 — 쓰기를 빼고 조용히 잇지 않는다 (SPEC §3.8).`);
  }
  const argv =
    resume !== undefined && spec.resume?.kind === 'subcommand'
      ? [...spec.promptArgv, ...spec.resume.argv, resume, prompt, spec.modelFlag, modelId]
      : [...spec.promptArgv, prompt, spec.modelFlag, modelId];
  switch (spec.effort.kind) {
    case 'flag':
      argv.push(spec.effort.flag, effort);
      break;
    case 'config':
      argv.push(spec.effort.flag, `${spec.effort.key}="${effort}"`);
      break;
    case 'modelSuffix':
      // effort 가 이미 모델 id 에 녹아 있다 (SPEC §0.1-3). 별도 플래그가 없다.
      break;
  }

  // 쓰기 권한은 **선언이 있는 엔진만** 받는다. 없으면 읽기 전용으로 떨어뜨리지 않고 던진다 —
  // 조용히 못 쓰면 "고쳤다"는 산출물이 실제로는 아무것도 안 바꾼 채 통과한다 (D-025).
  if (options.write === true) {
    if (!spec.write) {
      throw new EngineError(`${target} 에 쓰기 권한 선언이 없다 (engines.json). 읽기 전용으로 말없이 떨어뜨리지 않는다.`);
    }
    argv.push(...spec.write.argv);
  }

  // 스크래치 세션에서만 붙인다 — codex exec 는 git 저장소 밖에서 이게 없으면 거절한다 (SPEC §6.4.1).
  if (options.nonGit === true && spec.nonGitArgv) argv.push(...spec.nonGitArgv);

  if (resume !== undefined && spec.resume?.kind === 'flag') argv.push(spec.resume.flag, resume);

  // 지휘자만 격리한다 (D-032 B1). 선언이 없는 엔진에 격리를 요청하면 격리 없이 조용히 돌리지
  // 않는다 — 사용자 전역 설정이 새는 쪽이 더 위험하다 (D-032 Q13).
  if (options.isolate === true) {
    if (!spec.isolateArgv) {
      throw new EngineError(`${target} 는 격리 인자 선언이 없다 (engines.json). 격리 없이 조용히 돌리지 않는다 (D-032 B1).`);
    }
    argv.push(...spec.isolateArgv);
  }

  return { engine: target, argv, modelId, effort };
}
