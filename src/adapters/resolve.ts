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
export function buildInvocation(
  catalog: Engines,
  model: ModelKey,
  effort: string,
  prompt: string,
  engine?: EngineName,
): Omit<Invocation, 'bin'> {
  assertEffort(effort);

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
  const modelId = availability.idTemplate
    ? availability.idTemplate.replace('{effort}', effort)
    : (availability.id ?? '');
  if (!modelId) throw new EngineError(`${target}/${model} 의 모델 id 가 비어 있다 — engines.json 이 깨졌다.`);

  const argv = [...spec.promptArgv, prompt, spec.modelFlag, modelId];
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

  return { engine: target, argv, modelId, effort };
}
