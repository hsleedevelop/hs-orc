/**
 * EngineAdapter 구현 (SPEC §3.1).
 * **이 파일 이후로 CLI 플래그 문자열은 어댑터 밖에서 보이지 않는다.**
 * 세 엔진의 차이는 전부 `engines.json` 의 선언으로 흡수한다 — 엔진별 클래스를 만들지 않는다.
 */
import type { Effort, ModelKey } from '../data/matrix.ts';
import type { EngineName, Engines } from '../data/engines.ts';
import { loadEngines } from '../data/engines.ts';
import { EngineError, buildInvocation, resolveBinary } from './resolve.ts';
import { runProcess } from './run.ts';
import type { EngineAdapter, RunEvent, RunHandle, RunRequest } from './types.ts';

export function createAdapter(engine: EngineName, catalog: Engines = loadEngines()): EngineAdapter {
  const spec = catalog.engines[engine];

  const argvFor = (req: RunRequest): string[] => [
    ...buildInvocation(catalog, req.model, req.effort, req.prompt, {
      engine,
      ...(req.write === true ? { write: true } : {}),
      ...(req.nonGit === true ? { nonGit: true } : {}),
      ...(req.resume !== undefined ? { resume: req.resume } : {}),
    }).argv,
    ...spec.streamArgv,
  ];

  return {
    id: engine,

    supports(model: ModelKey, effort: string): boolean {
      const availability = catalog.models[model]?.availability[engine];
      if (!availability) return false;
      return availability.efforts.includes(effort as Effort);
    },

    buildArgv: argvFor,

    start(req: RunRequest, onEvent?: (event: RunEvent) => void): RunHandle {
      // effort·가용성 검증은 argv 생성이 먼저 하고, 실패하면 프로세스를 띄우기 전에 던진다.
      const argv = argvFor(req);
      return runProcess(
        { bin: resolveBinary(spec), argv, cwd: req.cwd, timeoutMs: req.timeoutMs, format: spec.streamFormat },
        onEvent,
      );
    },
  };
}

/**
 * 모델의 기본 엔진 어댑터. 기본 엔진이 그 모델을 못 받으면 **던진다** —
 * 가장 가까운 모델이나 다른 엔진으로 말없이 넘어가지 않는다 (D-004).
 */
export function adapterFor(model: ModelKey, effort: string, catalog: Engines = loadEngines()): EngineAdapter {
  const engine = catalog.models[model].defaultEngine;
  const adapter = createAdapter(engine, catalog);
  if (!adapter.supports(model, effort)) {
    throw new EngineError(`${engine} 는 ${model}/${effort} 를 지원하지 않는다.`);
  }
  return adapter;
}
