# hs-orchestrator — 기술 명세

- 버전: v0.1 (초안)
- 작성일: 2026-09-20
- 대상: v1 (TUI)
- 선행 문서: `docs/PRD.md`

## 0. 검증된 환경 사실

2026-09-20에 실제 실행으로 확인한 값이다. 구현 중 `--help`로 재확인하되, 기억이 이 표와 다르면 표를 따른다.

> **갱신 2026-09-20 (S1)**: 모델 id를 실측으로 채웠다(§3.2). 함정이 4가지에서 5가지로 늘었다(§0.1-5).
> 실측 원본은 `data/engines.json`의 `$evidence` 키에 출처와 함께 박혀 있다.

| 엔진 | 바이너리 | 버전 | 비대화 실행 | 모델 | effort |
|---|---|---|---|---|---|
| Claude | `claude` | 2.1.278 | `claude -p` | `--model` | `--effort low\|medium\|high\|xhigh\|max` |
| Codex | `codex` | 0.154.0 | `codex exec` | `-m` | `-c model_reasoning_effort="low\|medium\|high\|xhigh\|ultra\|max"` |
| Cursor | `cursor-agent` | 2026.09.15 | `cursor-agent -p` | `--model` | **모델 id 접미사** (`-low`/`-medium`/`-high`/`-xhigh`/`-max`) 또는 `'name[effort=high]'` |

**이벤트 스트림은 엔진마다 플래그도 스키마도 다르다** (S2 실측):

| 엔진 | 스트림 플래그 | 이벤트 | 최종 텍스트 | 사용량 |
|---|---|---|---|---|
| Claude | `--output-format stream-json --verbose` | `system`/`assistant`/`result` | `result.result` | `result.usage` (snake_case) + `total_cost_usd` |
| Cursor | `--output-format stream-json` | 같은 모양 | `result.result` | `result.usage` (**camelCase**), 비용 없음 |
| Codex | **`--json`** (`--output-format` 자체가 없다) | `thread.started`/`turn.started`/`item.completed`/`turn.completed` | `item.type=="agent_message"` 의 `text` | `turn.completed.usage` |

### 0.1 확인된 함정 7가지

1. **`codex -p`는 비대화 실행이 아니다.** 최상위 `-p`는 profile이고 비대화 실행은 `codex exec`(별칭 `codex e`)다.
2. **`claude --effort`에 잘못된 값을 주면 경고만 내고 기본 effort로 조용히 실행된다.** 실측 출력: `Warning: Unknown --effort value 'bogus' — ignoring it and using the default effort.` 어댑터가 CLI에 넘기기 **전에** 검증하지 않으면 잘못된 effort로 돌고 아무도 모른다.
3. **Cursor는 effort가 별도 플래그가 아니라 모델 id의 일부다.** `gpt-5.6-sol-xhigh`처럼 붙는다. `-fast`와 `-thinking` 변형이 따로 있다.
4. **`cursor-cli`라는 바이너리는 이 환경에 없다.** 설치된 것은 `cursor`와 `cursor-agent`뿐이다. 제품은 `cursor-cli`를 우선 탐색하고 없으면 `cursor-agent`로 폴백하는 해석 로직을 두며, 설정으로 덮어쓸 수 있게 한다.
5. **`codex -m`은 없는 모델 id를 거부하지 않는다.** 실측 출력: `warning: Model metadata for \`gpt-5.6-bogus\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.` 경고만 내고 **그대로 실행된다.** `claude --model`은 반대로 `[claude-code:unrecognized_model]`로 즉시 거부한다. 즉 모델 id의 방어선은 codex 쪽에만 없고, `supports()`가 그 자리를 메운다 — §0.1-2와 같은 계열의 조용한 폴백이다.
6. **`codex`에는 `--output-format`이 없다.** SPEC v0.1의 "세 엔진 모두 `--output-format`을 지원한다"는 서술은 **틀렸다**(S2에서 정정). codex의 이벤트 스트림은 `--json`이고 스키마도 claude/cursor 계열과 완전히 다르다. 어댑터는 플래그와 파서를 엔진별로 갈라 `engines.json`의 `streamArgv`·`streamFormat`으로 선언한다.
7. **세 CLI 모두 stdin이 TTY가 아니면 입력을 기다린다.** `codex`는 `Reading additional input from stdin...`에서 **무기한 블록**하고, `claude`는 3초 경고 후 진행한다. 어댑터는 `stdio[0] = 'ignore'`로 stdin을 닫는다. 추가로 `cursor-agent`는 신뢰하지 않은 디렉터리에서 **Workspace Trust 프롬프트로 막히므로** `--trust`가 필요하다 — 비대화 실행에서는 이 셋 중 하나만 빠져도 조용히 멈춘 것처럼 보인다.


## 1. 아키텍처

```
┌─────────────────────────────────────────────┐
│  Shell (v1: TUI  /  v2: GUI)                │  ← 교체 가능한 계층
├─────────────────────────────────────────────┤
│  Core (headless)                            │
│   Classifier → Gatekeeper → Assigner        │
│   → ModeRunner → EvidenceCollector          │
├─────────────────────────────────────────────┤
│  EngineAdapter  (claude / codex / cursor)   │  ← CLI 플래그는 여기 밖으로 못 나간다
├─────────────────────────────────────────────┤
│  Data:  matrix.json · engines.json · log    │
└─────────────────────────────────────────────┘
```

**Core는 UI를 모른다.** 이벤트 스트림과 콜백으로만 바깥과 통신한다. v2 GUI는 Shell만 교체한다. Core에 UI 타입이 새면 v2에서 재작성이 된다.

## 2. 데이터 — 매트릭스

출처: `/Users/hsonpro/Documents/Codex/2026-09-20/astra-terra-fable-opus-test/outputs/gpt-5-6-claude-practical-matrix-v6.html`
원본 `rows` 배열과 `profiles` 객체가 진실이다. 아래 테이블은 그 전사이며, 불일치 시 원본이 이긴다.

### 2.1 모델 계층

```
OpenAI : Luna  → Terra  → Sol  → Astra
Claude : Haiku → Sonnet → Opus → Fable
```

단일 순위가 아니라 실행 역할의 계층이다.

### 2.2 업무별 배정 (11행)

| # | 업무 | Primary | Reviewer | 운영 기준 (= 수용 증거) |
|---|---|---|---|---|
| 1 | 짧은 구현 / 타입 수정 | Luna·medium | Haiku·low~medium | 빠르게 수정하고 기존 test만 실행 |
| 2 | 요구사항 정리 / 기술 비교 | Terra·high | Sonnet·high | 결정 기준과 반례를 문서화 |
| 3 | 신규 기능 구현 | Sol·high | Sonnet·high | acceptance test를 먼저 고정 |
| 4 | 여러 파일 리팩터링 | Sol·xhigh | Opus·high | 영향 범위와 회귀 suite 확인 |
| 5 | 복잡한 버그 / 장애 RCA | Astra·xhigh~max | Fable·xhigh | 가설이 아니라 로그로 반증 |
| 6 | 테스트 설계 / 회귀 분석 | Sol·xhigh | Sonnet·high | 실패 재현 → 최소 수정 → 회귀 |
| 7 | 성능 최적화 | Astra·xhigh | Opus·xhigh | baseline / 변경 / 재측정 3점 |
| 8 | 대규모 레거시 분석 | Fable·xhigh~max | Astra·xhigh | 경로 추적 결과를 표본 검증 |
| 9 | 장기 마이그레이션 | Fable·xhigh~max | Astra·high | 작은 batch와 rollback 지점 |
| 10 | 아키텍처 / 설계 | Fable·high~xhigh | Astra·xhigh | 대안·제약·실행계획을 분리 |
| 11 | 보안 / 배포 최종 검토 | Astra·max | Fable·max | 독립 리뷰 + 실제 검증 필수 |

**불변식 INV-1**: 모든 행에서 `vendor(primary) ≠ vendor(reviewer)`. 배정 생성 시 검사하고 위반이면 실패시킨다.

### 2.3 비용 / 지연 (AA max-effort 측정치)

| 모델 | AA | 작업당 비용 | first chunk |
|---|---|---|---|
| Luna | 37 | $0.18 | 123.28s |
| Haiku | 17 | $0.21 | 17.18s |
| Terra | 42 | $1.40 | 211.05s |
| Sol | 47 | $1.99 | 129.50s |
| Astra | 53 | $3.26 | 260.42s |
| Sonnet | 38 | $5.09 | 131.49s |
| Opus | 51 | $5.86 | 56.84s |
| Fable | 53* | $7.63 | 262.21s |

`*` Fable AA row는 fallback 포함 구성. 이 값은 **벤치마크 측정치이며 실제 지출이 아니다** — UI에 그대로 표기한다.

최저 조합(Luna+Haiku $0.39) 대비 최고 조합(Fable+Astra $10.89)은 약 28배다.

### 2.4 상향 사다리

```
L1: Luna medium  / Haiku low
L2: Terra high   / Sonnet high
L3: Sol high     / Opus high
L5: Astra max    / Fable max  + independent review
```

상향 순서는 **① 코드·로그·재현 조건 보강 → ② effort 상향 → ③ 모델 상향 → ④ reviewer 추가**. 이 순서를 건너뛰고 L5로 점프하는 경로를 만들지 않는다.

### 2.5 근거 등급

| 등급 | 출처 | UI 표기 |
|---|---|---|
| independent | Terminal-Bench 4.0, Artificial Analysis | `INDEPENDENT` |
| vendor | OpenAI / Anthropic 발표 | `VENDOR` |
| operating policy | 매트릭스 배정표 | `POLICY` |

섞어 표시하지 않는다. TB4의 0.3pp 차이로 모델 우열을 표시하지 않는다.

## 3. 엔진 어댑터

### 3.1 인터페이스

```ts
type Vendor = 'openai' | 'anthropic';
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type MatrixModel = 'luna' | 'terra' | 'sol' | 'astra'
                 | 'haiku' | 'sonnet' | 'opus' | 'fable';

interface RunRequest {
  model: MatrixModel;
  effort: Effort;
  prompt: string;
  cwd: string;
  timeoutMs: number;
}

interface EngineAdapter {
  readonly id: 'claude' | 'codex' | 'cursor';
  /** 이 어댑터가 (model, effort) 조합을 실행할 수 있는가 */
  supports(model: MatrixModel, effort: Effort): boolean;
  /** 실행 전 검증. 실패하면 던진다 — 조용한 폴백 금지 */
  buildArgv(req: RunRequest): string[];
  run(req: RunRequest, onEvent: (e: RunEvent) => void): Promise<RunResult>;
  cancel(): Promise<void>;
}
```

**CLI 플래그 문자열은 어댑터 밖에서 보이지 않는다.** Core는 `MatrixModel`과 `Effort`만 다룬다.

### 3.2 모델 → 엔진 매핑

**모델 id는 추측이 아니라 실측이다** (S1, 2026-09-20). 출처는 `data/engines.json`의 `$evidence`:
codex는 `~/.codex/models_cache.json`(client 0.154.0)의 `slug`·`supported_reasoning_levels`,
cursor는 `cursor-agent --list-models`, claude는 4개 id를 실제로 `-p` 실행해 응답을 확인했다.

| 매트릭스 모델 | 기본 엔진 | 기본 엔진의 모델 id | 대체 엔진 (`cursor-cli -p`) |
|---|---|---|---|
| Luna | codex | `gpt-5.6-luna` | `gpt-5.6-luna-{effort}` ✅ |
| Terra | codex | `gpt-5.6-terra` | `gpt-5.6-terra-{effort}` ✅ |
| Sol | codex | `gpt-5.6-sol` | `gpt-5.6-sol-{effort}` ✅ |
| **Astra** | codex | `gpt-6-astra` | **없음 ❌** |
| **Haiku** | claude | `claude-haiku-4-5-20251001` | **없음 ❌** |
| Sonnet | claude | `claude-sonnet-5` | `claude-sonnet-5-thinking-{effort}` ✅ |
| Opus | claude | `claude-opus-5` | `claude-opus-5-thinking-{effort}` ✅ |
| Fable | claude | `claude-fable-5-1` | `claude-fable-5-1-thinking-{effort}` ✅ |

**Cursor는 8모델 중 6개만 커버한다.** Astra는 11행 중 6행에 등장(primary 4 / reviewer 2)하고
Haiku는 1행의 reviewer이므로, 대체는 **모델별로만 가능**하고 전역 대체가 아니다.
가용성은 `engines.json`에 선언적으로 두고, `supports()`가 이 테이블을 읽는다.
지원하지 않는 조합에 대체를 시도하면 **명시적 실패**다 — 가장 가까운 모델로 말없이 바꾸지 않는다.

Cursor 쪽 id에서 S1이 확인한 두 가지(SPEC v0.1보다 정밀해진 부분):

- **OpenAI 모델에는 `-thinking` 변형이 아예 없다.** §3.3의 "기본은 `-thinking` 계열" 정책은
  Claude 3모델(sonnet·opus·fable)에만 적용된다. `gpt-5.6-*`는 `-{effort}`와 `-fast`만 있다.
- **`claude-opus-5` 비thinking은 `low|medium|high`뿐이다.** `xhigh`·`max`는 `-thinking` 변형이
  유일한 경로이므로, Opus에서 `-thinking` 기본값은 취향이 아니라 **커버리지 요구사항**이다.

codex의 `supported_reasoning_levels`는 네 모델 모두 정규 5단계를 포함한다.
terra·sol·astra에는 `ultra`도 있으나 매트릭스에 등장하지 않으므로 정규 어휘에 넣지 않는다(§3.3).

### 3.3 effort 정규화

정규 어휘: `low | medium | high | xhigh | max`

| 정규값 | claude | codex | cursor |
|---|---|---|---|
| low | `--effort low` | `-c model_reasoning_effort="low"` | 모델 id `-low` |
| medium | `--effort medium` | `..."medium"` | `-medium` |
| high | `--effort high` | `..."high"` | `-high` |
| xhigh | `--effort xhigh` | `..."xhigh"` | `-xhigh` |
| max | `--effort max` | `..."max"` | `-max` |

- 매트릭스의 `Mid` → `medium`, `Low/Medium` → 범위(기본 `low`, 상향 시 `medium`).
- codex의 `ultra`는 매트릭스에 등장하지 않으므로 정규 어휘에 넣지 않는다.
- **정규 어휘 밖의 값은 던진다.** `claude`는 잘못된 값을 경고만 내고 기본값으로 실행하므로(§0.1-2), 어댑터 검증이 유일한 방어선이다.
- Cursor는 `-fast`/`-thinking` 변형 선택 정책을 `engines.json`에 둔다. 기본값은 `-thinking` 계열(추론 품질 우선), `fast`는 옵트인.
  단 `-thinking`은 **Claude 3모델에만 존재한다** — `gpt-5.6-*`에는 변형 자체가 없다(§3.2).

### 3.4 argv 생성 예

```
claude  -p "<prompt>" --model <id> --effort xhigh --output-format stream-json
codex   exec "<prompt>" -m <id> -c model_reasoning_effort="xhigh" --output-format ...
cursor  -p "<prompt>" --model gpt-5.6-sol-xhigh --output-format stream-json
```

### 3.5 프로세스 관리

- 취소는 자식 프로세스를 **실제로 종료**해야 한다. 프로세스 그룹 단위 종료. 좀비 검출 테스트 필수.
- 타임아웃은 작업 유형별 기본값을 두되 사용자가 덮어쓸 수 있다.
- stdout/stderr 원본을 실행별로 보존한다. 파싱 실패가 원본 손실로 이어지지 않게 한다.
- stream-json 파싱은 **바깥 try와 분리된 중첩 try**로 감싼다. 한 줄 파싱 실패가 실행 전체를 죽이지 않는다.

## 4. 라우팅 파이프라인

```
작업 입력
  │
  ├─ 1. Classifier      → 11행 중 1행 | "해당 없음"
  │                        "해당 없음" → 사용자에게 올림 (임의 배정 금지)
  │
  ├─ 2. Gatekeeper      → /delegation-router §1 하한선
  │                        걸림  → "직접 처리" 판정 후 종료 (엔진을 띄우지 않는다)
  │                        통과  → 네 갈래 ①~④ 부여
  │
  ├─ 3. Assigner        → primary/reviewer 모델·effort
  │                        INV-1 교차 벤더 검사
  │                        엔진 매핑 + supports() 검사
  │                        비용 산정
  │
  ├─ 4. 승인 게이트      → 배정·비용 제시 후 사용자 승인
  │
  ├─ 5. ModeRunner      → pingpong | loop | graph
  │
  ├─ 6. EvidenceCollector → 해당 행의 `운영 기준`이 요구하는 증거 수집
  │
  └─ 7. DecisionLog     → 2차 append
```

### 4.1 Gatekeeper — §1 하한선

하나라도 걸리면 배정하지 않는다.

- 도구 호출 1~2번이면 끝난다
- 스크립트 한 줄로 된다
- 필요한 것이 이미 컨텍스트에 있다
- 결과를 어차피 전부 다시 읽어야 한다
- 진행 중 사용자에게 물어야 한다
- 되돌리기 어려운 변경이다

**순서가 핵심이다.** 매트릭스를 먼저 적용해 Fable을 띄워놓고 하한선을 확인하는 구현은 틀렸다.

## 5. 증거 수집

`운영 기준` 열을 증거 요구사항으로 해석한다. 완료 판정은 증거가 모였을 때만 내린다.

| 행 | 증거 형태 |
|---|---|
| 1 | 기존 test 실행 결과 + exit code |
| 2 | 결정 기준 목록 + 반례 목록 (문서) |
| 3 | acceptance test 정의 시각이 구현 시작보다 앞 |
| 4 | 변경 파일 목록 + 회귀 suite 결과 |
| 5 | 수정 전 실패 로그 + 수정 후 통과 로그 |
| 6 | 실패 재현 → 최소 수정 → 회귀 3단계 각각의 실행 결과 |
| 7 | baseline / 변경 후 / 재측정 3점 측정값 (같은 환경) |
| 8 | 표본 코드 경로 + 실제 query 결과 |
| 9 | batch 경계 + checkpoint + rollback 지점 정의 |
| 10 | 대안 / 제약 / 실행계획 세 절이 분리된 산출물 |
| 11 | 독립 리뷰 결과 + 실제 검사·test·배포 관측 |

**"성공했습니다"라는 산문은 증거가 아니다.** `file:line`, 실행 명령과 exit code, 수정 경로, 인용 원문을 받는다.

## 6. 진행 방식 3종

### 6.1 `/pingpong` — 대화형

사용자가 매 턴 개입하는 진행이다. 다른 둘과 달리 **자율 실행이 아니다.**

- 1턴 = 1작업 단위. 턴 종료 시 결과와 다음 제안을 제시하고 **사용자 입력을 기다린다.**
- 사용자는 방향 수정, 배정 변경(상향/하향), 중단을 언제든 할 수 있다.
- primary와 reviewer를 같은 대화 맥락에서 교대로 붙일 수 있다.
- 최대 턴 수 제한은 없다(사용자가 매 턴 승인하므로). 누적 비용은 계속 표시한다.

### 6.2 `/loop` — loop-engineering

자율 반복이다. 구성 요소를 분리한다.

| 요소 | 역할 |
|---|---|
| Goal | 측정 가능한 최종 상태 |
| Planner | 다음으로 처리할 **가장 작은 유효 작업** 선택 |
| Executor | 그 작업 하나를 수행 |
| Evaluator | 성공 여부를 기계적으로 판정 |
| Critic | 누락된 근거·리스크·실패 가능성 |
| Recovery | 실패 시 재시도 / 롤백 / 중단 / 사용자 승인 |
| Stop | 완료 조건과 중단 조건 |

규칙: 한 사이클에 하나의 작은 작업. 검증 없이 다음 사이클로 넘어가지 않는다. **최대 반복 수 없이는 구현하지 않는다.** 누적 비용 상한 도달 시 강제 중단.

Evaluator에는 reviewer 슬롯 모델을 쓴다 — 매트릭스의 독립 리뷰가 루프 안에서 실현되는 자리다.

> **미결정**: Claude Code 내장 `/loop` 스킬 위에 얹을지 자체 구현할지. 내장 `/loop`는 간격 기반 재실행이고 여기서 필요한 것은 Planner/Evaluator 분리가 있는 루프다. 기본안은 **자체 구현**이며, 내장 `/loop`는 hs-orchestrator 자체를 주기 실행하는 바깥 껍데기로만 쓴다.

### 6.3 `/graph` — graph-engineering

작업을 DAG로 쪼개 의존성 순서로 실행한다.

- 노드 = 작업 단위. 노드마다 **독립적으로 분류·배정**된다. 한 그래프 안에서 Luna 노드와 Fable 노드가 공존할 수 있다.
- 엣지 = 의존성. **순환 검출은 실행 전 필수**이고 순환이면 실행하지 않는다.
- 의존성 없는 노드는 병렬 실행 가능. 단, **쓰기 대상 파일이 겹치지 않을 때만**. 겹침이 불확실하면 순차로 떨어뜨린다.
- 부분 실패 전파 규칙을 노드마다 선언한다: `fail-fast`(후속 전부 중단) / `skip-dependents`(후속만 건너뜀) / `continue`(무시하고 진행).
- 그래프 전체의 누적 비용 상한과 최대 노드 수를 강제한다.

세 방식 공통: 사이클/턴/노드마다 근거·변경·검증 결과를 남기고, 최대 시도 도달 시 사람에게 올린다.

## 7. TUI (v1)

화면 5개 + Debug. 프레임워크는 **Ink 7 + React 19**다 (D-018). **JSX는 쓰지 않는다** — Node의 타입
스트리핑이 JSX를 처리하지 못해 빌드 단계가 생기기 때문이고, 대신 화면 판단을 순수 뷰모델
(`src/shell/tui/model.ts`)로 빼고 렌더 층을 얇게 유지한다 (D-019).

| 화면 | 내용 |
|---|---|
| **Run** | 작업 입력 → 분류 결과 → 배정(primary/reviewer/effort/엔진) → **예상 비용** → 승인 → 실행 스트림 |
| **Tasks** | 작업 목록. 상태·배정·증거·누적 비용 |
| **Dashboard** | 실행 중인 것, 배정 분포, 누적 비용, 업무 유형별 성공/재시도 |
| **Sessions** | `claude agents --json` + codex 내부 색인 (아래 주의) |
| **Reviews** | PR 목록 (`gh-axi` 우선, `gh` 폴백) |
| **Debug** | 런타임·상한·카탈로그. 프로덕션 빌드에도 싣는다 |

표시 규칙:

- 비용은 실행 **전**에 보인다. "AA 벤치마크 측정치, 실제 지출 아님"을 함께 표기한다.
- 근거 등급 배지(`INDEPENDENT` / `VENDOR` / `POLICY`)를 섞지 않는다.
- 디버그 화면은 프로덕션 빌드에도 포함한다.
- 화면 타이틀에 환경 + 버전.

**외부 CLI 실측 (S5, 2026-09-20) — 둘 다 SPEC v0.1의 가정과 다르다:**

- **`codex agents`에는 `--json`이 없다.** alt-screen TUI 브라우저이고 플래그는 `-c/--remote/--enable/--remote-auth-token-env/-C/--disable/--no-alt-screen/-h`가 전부다. `claude agents --json`만 정식 경로이고(`{pid,cwd,kind,startedAt,sessionId,name,status}`), codex 쪽은 `~/.codex/session_index.jsonl`(`{id,thread_name,updated_at}`)을 읽는 **비공식 폴백**이다. 화면은 행마다 `[cli]` / `[internal-file]` 출처를 표시한다 (D-020).
- **`gh-axi`와 `gh`는 인터페이스가 다르다.** `gh-axi pr list`는 `--json`을 받지 않고 `--fields`도 `number/title/state`를 모른다 — 기본 출력이 이미 그 값을 담는다:
  `pull_requests[3]{number,title,state,author,draft,review}:` 헤더 + 들여쓴 CSV 행(제목은 따옴표). `gh`는 `--json number,title,state`다. 어느 쪽도 못 쓰면 **빈 목록이 아니라 사유를 표시한다.**
- 출처별로 잘라서 보여준다. 한쪽 세션이 많다고 다른 쪽을 밀어내면 "통합 조회"가 아니다.

## 8. 결정 로그

경로: `~/.claude/logs/delegation-router.jsonl` (라우터 §7 스키마)

- **1차**: 배정을 확정한 시점에 `status:"decided"`, `outcome:"pending"`, `id`, `branch`(`down|keep|up_part|up_session`)
- **2차**: 검증이 끝난 뒤 **같은 `id`로 한 줄 더 append**. 갱신이 아니다. 쿼리는 `id`별 마지막 줄을 본다.
- 남기는 경우: 위임했을 때 / 티어를 내렸을 때 / 조건에 걸렸는데 일부러 안 내렸을 때 / 제안했지만 실행되지 않았을 때(거절·차단·무응답)
- 남기지 않는 경우: 그냥 "직접"으로 간 기본 경로

## 9. 설정 파일

| 파일 | 내용 | 갱신 |
|---|---|---|
| `matrix.json` | 11행 배정표, 모델 계층, 비용, 사다리 | 원본 HTML에서 생성. 대조 테스트 필수 |
| `engines.json` | 바이너리 경로·이름 해석, 모델↔엔진 매핑, 가용성, effort 표기, cursor 변형 정책 | 수기 |
| `limits.json` | 최대 반복 수, 최대 노드 수, 누적 비용 상한, 타임아웃 | 수기 |

`matrix.json`은 생성물이며 수기 편집하지 않는다.

**첫 줄 주석 대신 `$generated` 키를 쓴다** (S1 변경). `// GENERATED` 주석은 `JSON.parse`를 깨뜨려
전용 스트리퍼가 필요해지므로, 같은 정보를 **첫 키** `$generated`에 담는다:

```json
{ "$generated": { "note": "GENERATED — …", "source": "<HTML 절대경로>",
                  "sourceSha256": "<원본 해시>", "generator": "scripts/gen-matrix.mjs" }, … }
```

대조는 `npm run matrix:check`(= `gen-matrix.mjs --check`)가 한다 — 원본에서 다시 생성해 바이트 단위로
비교하고 다르면 실패한다. 원본 HTML이 그 머신에 없으면 **통과시키되 생략 사유를 출력한다**
(원본은 저장소 바깥의 절대경로다). 이 대조는 pre-commit 게이트의 첫 단계다.

## 10. 테스트

| 대상 | 방식 |
|---|---|
| 배정 로직 | 11행 전부 테이블 테스트. 매트릭스 원본과 대조 |
| INV-1 교차 벤더 | 위반 조합 생성 시도가 실패하는지 |
| effort 정규화 | 정규 어휘 밖 값이 **던지는지** (조용한 폴백 없음) |
| 엔진 argv | 세 엔진 각각 기대 argv 생성 |
| supports() | Astra·Haiku에 cursor 대체 요청 시 실패하는지 |
| 비용 산정 | primary+reviewer 합산 |
| DAG | 순환 검출, 위상 정렬, 부분 실패 전파 |
| 프로세스 취소 | 자식이 실제로 죽는지 (좀비 없음) |
| stream-json 파싱 | 깨진 줄 1개가 실행 전체를 죽이지 않는지 |
| 엔진 통합 | 세 CLI로 짧은 실제 프롬프트 1회씩 |

순수 로직 테스트는 소스 옆 `__tests__/`에 둔다. GWT/AAA, 행위 기술형 `it` 이름.

게이트는 구현이 끝난 뒤 `type-check → lint → test` **마지막 1회**. 파일마다 반복하지 않는다.

## 11. 미해결

1. `/loop` 자체 구현 vs 내장 스킬 활용 (§6.2)
2. 매트릭스 "해당 없음" 반복 시 행 추가 정책
3. 누적 비용 상한 기본값
4. TUI 프레임워크 선택
5. Cursor `-fast` 변형 사용 조건
