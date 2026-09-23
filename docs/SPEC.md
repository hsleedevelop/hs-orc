# hs-orchestrator — 기술 명세

- 버전: v0.2
- 작성일: 2026-09-20 · 개정 2026-09-23 (D-031 대화 세션 — §1·§3.1·§3.8·§4·§6.1·§6.4·§7.1·§8~§11)
- 대상: v1 (TUI) · v2 (GUI) · v2.1 (대화 세션)
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
│  ConversationSession (headless, v2.1)       │  ← 대화 기록 · 지휘자(직접 답·요약)
│   메시지 → 아래 파이프라인 | 직접 답        │     §6.4
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

**`ConversationSession` 도 Core 쪽이다** (D-031 결정 8). 대화 기록·지휘자 판단을 셸에 두면 GUI 와 CLI 가 같은 메시지에 다르게 답한다 — D-026 에서 분류 폴백이 CLI 에만 있어 실제로 그랬다.

## 2. 데이터 — 매트릭스

출처: `data/matrix-source.html (저장소 안. 원본 v6 HTML 을 그대로 넣어 두어 누구나 `npm run matrix:check` 로 대조할 수 있다 — D-013)`
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
  /** v2.1: 이어 붙일 엔진 세션 id. 있으면 resume 경로로 띄운다 (§3.8) */
  resume?: string;
}

interface RunResult {
  // … (outcome · text · usage · rawStdout 등 기존 필드)
  /** v2.1: 스트림에서 읽은 엔진 세션 id. 못 읽으면 undefined — 지어내지 않는다 */
  sessionId?: string;
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

**CLI 플래그 문자열은 어댑터 밖에서 보이지 않는다.** Core는 `MatrixModel`과 `Effort`만 다룬다. resume 도 같다 — Core 는 세션 id 문자열만 들고 다니고, 그것을 어느 플래그에 싣는지는 어댑터가 안다.

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
- **`fast`는 모델별 옵트인이다** (D-023). 실측(2026-09-21): `-fast`는 Luna·Terra·Sol(각 6종)과 Opus(8종)에 있고 **Sonnet·Fable 5.1에는 0종**이다. 없는 모델에 `fast`를 요청하면 **던진다** — 일반 변형으로 조용히 떨어뜨리는 것이 D-004가 금지한 말없는 치환이다.

### 3.4 argv 생성 예

```
claude  -p "<prompt>" --model <id> --effort xhigh --output-format stream-json
codex   exec "<prompt>" -m <id> -c model_reasoning_effort="xhigh" --output-format ...
cursor  -p "<prompt>" --model gpt-5.6-sol-xhigh --output-format stream-json
```

### 3.5 비용 출처 세 가지 (D-027)

`actual`(엔진이 돌려준 값) > `metered`(측정 토큰 × `data/pricing.json` 선언 단가) > `estimate`(AA 벤치마크) 순으로 고른다. **섞이면 누적 표시에 무엇이 섞였는지 적는다.** 단가 선언이 없는 모델은 `metered` 가 `undefined` 이고 `estimate` 로 남는다 — 0 으로 떨어뜨리면 "공짜로 돌았다"가 된다.

### 3.6 쓰기 권한 (D-025)

기본은 **읽기 전용**이다. `--write` 를 켜면 **primary 슬롯만** 파일을 고칠 수 있다.

| 엔진 | 인자 (실측 `--help`, 2026-09-21) | 쓰지 않는 값 |
|---|---|---|
| codex | `-s workspace-write` | `danger-full-access` |
| claude | `--permission-mode acceptEdits` | `bypassPermissions` |
| cursor | `--force` | `--yolo`(같은 것의 별칭) |

- **reviewer 는 이 값이 켜져도 읽기 전용이다.** 판정 대상을 스스로 고칠 수 있으면 독립 검증(D-003·INV-1)이 성립하지 않는다. 부여 지점은 `core/executor.ts` 한 곳이고, 거기서 `slot.role === 'primary'` 로 막는다 — 호출자가 무엇을 넘기든 뚫리지 않는다.
- 선언(`engines.json` 의 `write`)이 없는 엔진에 쓰기를 요청하면 **던진다.** 읽기 전용으로 조용히 떨어뜨리면 아무것도 안 바꾼 산출물이 "고쳤다"로 통과한다.
- 쓰기 여부는 **승인 전 화면에 비용과 나란히** 표시한다 (PLAN "사람에게 올리는 조건: 외부 쓰기").

### 3.7 프로세스 관리

- 취소는 자식 프로세스를 **실제로 종료**해야 한다. 프로세스 그룹 단위 종료. 좀비 검출 테스트 필수.
- 타임아웃은 작업 유형별 기본값을 두되 사용자가 덮어쓸 수 있다.
- stdout/stderr 원본을 실행별로 보존한다. 파싱 실패가 원본 손실로 이어지지 않게 한다.
- stream-json 파싱은 **바깥 try와 분리된 중첩 try**로 감싼다. 한 줄 파싱 실패가 실행 전체를 죽이지 않는다.

### 3.8 세션 resume (v2.1, D-031 Q10 실측)

| 엔진 | 세션 id 출처 (어댑터가 이미 읽는 스트림) | resume argv |
|---|---|---|
| claude | stream-json 각 줄의 `session_id` | `-p --resume <id>` + 기존 모델·effort·스트림 인자 |
| codex | `--json` 첫 줄 `{"type":"thread.started","thread_id"}` | `exec resume <id>` + `--json -m … -c model_reasoning_effort=…` (resume 이 모델·effort 를 받는다) |
| cursor | stream-json `system init` 부터의 `session_id` | `-p --resume <id>` + 기존 인자 |

- 세 엔진 모두 2026-09-23 에 무작위 코드워드 회수로 확인했다. resume 뒤에도 id 는 같다.
- **같은 세션 폴더(cwd)에서만 resume 한다.** codex 는 세션 목록을 cwd 로 거른다. 다른 cwd 에서의 resume 은 실측하지 않았다.
- resume 이 실패하면(비정상 종료·id 없음) **새 세션으로 조용히 바꾸지 않는다.** 실패를 올리고, 재시도는 맥락을 실은 새 실행으로 사용자가 고른다 — 조용히 맥락 없는 실행으로 떨어지면 답이 그럴듯하게 틀린다.

## 4. 라우팅 파이프라인

```
작업 입력 (v2.1: 세션의 메시지 1건 — §6.4)
  │
  ├─ 1. Classifier      → 11행 중 1행 | "해당 없음"
  │                        "해당 없음" → 임의 배정 금지. v1: 사용자에게 올림
  │                                      v2.1: 지휘자 직접 답 (§6.4.2), 행은 제안만
  │
  ├─ 2. Gatekeeper      → /delegation-router §1 하한선
  │                        걸림  → "직접 처리". v1: 종료 (엔진을 띄우지 않는다)
  │                                v2.1: 지휘자 직접 답 (§6.4.2)
  │                        통과  → 네 갈래 ①~④ 부여
  │
  ├─ 3. Assigner        → primary/reviewer 모델·effort
  │                        INV-1 교차 벤더 검사
  │                        엔진 매핑 + supports() 검사
  │                        비용 산정
  │
  ├─ 4. 승인 게이트      → 배정·비용 제시 후 사용자 승인
  │
  ├─ 5. ModeRunner      → once(기본, 두 슬롯) | pingpong | loop | graph
  │                        once: primary 실행 → reviewer 독립 검증 → PASS/FAIL
  │                        reviewer 판정은 §5 의 `review` 증거가 된다
  │
  ├─ 6. EvidenceCollector → 해당 행의 `운영 기준`이 요구하는 증거 수집
  │
  ├─ 7. DecisionLog     → 2차 append
  │
  └─ 8. 결과 처리 (v2.1) → 대화 기록에 결과 append → 지휘자 요약 + 다음 제안 (§6.4.4)
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

`review` 증거는 **reviewer 슬롯이 실제로 돌아야** 생긴다 — 배정만 두 슬롯이고 실행이 한 슬롯이면
이 제품은 단일 엔진 선택기다(D-009, S3 최대 위험). reviewer 프롬프트는 작업을 다시 시키지 않고
산출물의 누락·반례를 먼저 요구한 뒤 마지막 줄에 `PASS`/`FAIL` 한 단어를 받는다. **읽지 못하면
`unknown` 이고 pass 로 봐주지 않는다.** primary 가 실패했거나 비용 상한을 넘겼으면 reviewer 를
시작하지 않는다 — 검증할 산출물이 없거나 쓸 돈이 없다.

**"성공했습니다"라는 산문은 증거가 아니다.** `file:line`, 실행 명령과 exit code, 수정 경로, 인용 원문을 받는다.

구현: `src/core/evidence.ts` 의 `REQUIREMENTS` 가 위 표를 그대로 옮긴 것이다 — **이 표를 바꾸려면 SPEC 을 먼저 바꾼다.**
증거 종류는 `command`(명령+exit code) · `document-section` · `changed-files` · `measurement`(값+환경) ·
`citation`(`file:line`) · `review` · `ordering`(두 시각) 일곱이고, 모양 검사를 통과하지 못하면 **거절한다.**
`--verify "[phase:]<명령>"` 은 명령을 실제로 돌려 exit code 를 받고(R05 `before`/`after`,
R06 `reproduce`/`fix`/`regress` 단계 표기 지원), 변경 파일은 git 에서 읽는다 — 모델이 말한 목록을 믿지 않는다.
증거가 모였을 때만 결정 로그 2차 줄의 `outcome` 이 `ok` 가 된다. 아니면 `unverified` 다.

행별 **기본 검증 명령**은 `data/verify.json`(수기)에 프로젝트가 선언한다 — 제품은 추론하지 않는다.
`default` 와 행 id 선언을 합치고 `--verify` 와 다시 합친다. **선언이 없으면 빈 배열이다**:
업무 유형만 보고 `npm test` 를 넣으면 그 프로젝트에서 틀리고, 틀린 검증으로 닫은 완료는 거짓말이 된다.

## 6. 진행 방식 3종

### 6.1 `/pingpong` — 대화형

사용자가 매 턴 개입하는 진행이다. 다른 둘과 달리 **자율 실행이 아니다.**

- 1턴 = 1작업 단위. 턴 종료 시 결과와 다음 제안을 제시하고 **사용자 입력을 기다린다.**
- 사용자는 방향 수정, 배정 변경(상향/하향), 중단을 언제든 할 수 있다.
- primary와 reviewer를 같은 대화 맥락에서 교대로 붙일 수 있다.
- 최대 턴 수 제한은 없다(사용자가 매 턴 승인하므로). 누적 비용은 계속 표시한다.

**v2.1 개정 (D-031 결정 6):** GUI 채팅이 `/pingpong` 의 기본 형태가 되고, **배정은 턴마다 다시 한다.** 세션 고정 배정(`PingpongSession` 의 생성자 `plan`)은 CLI `--mode pingpong` 에만 남는다 — CLI 가 `ConversationSession` 으로 옮겨 가면 걷어낸다. 턴 모양은 §6.4 가 정한다.

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

### 6.4 대화 세션 (v2.1, D-031)

#### 6.4.1 세션과 기록

| 종류 | 작업 폴더 | 기록 파일 |
|---|---|---|
| `project` | 사용자가 고른 폴더 (워크트리 포함, D-029) | `<폴더>/.hs-orc/sessions/<id>.jsonl` |
| `scratch` | `~/.hs-orc/scratch/<id>/` 를 세션 시작 때 만든다 (`HS_ORC_SCRATCH` 로 뿌리를 바꾼다). git 아님, **쓰기 켤 수 없음** | 그 폴더의 `.hs-orc/sessions/<id>.jsonl` |

- `id` 는 결정 로그와 같은 `MMDD-HHMM-xxx` (§8).
- 기록은 **append-only JSONL** 이다. 한 줄 = 한 사건:
  `{ v:1, at, turn, kind, … }` — `kind` 는 `user`(메시지) · `direct`(직접 답) · `plan`(배정·비용) · `approval`(승인·거절) · `result`(primary 출력·reviewer 판정·증거·outcome·엔진 세션 id) · `summary`(지휘자 요약·다음 제안) · `error`(실패 사유).
- 세션을 다시 열면 기록을 **처음부터 다시 읽어** 화면과 맥락을 복원한다. 깨진 줄은 건너뛰고 수를 센다 — 결정 로그와 같은 규칙.
- 세션 상태는 AO 어휘를 빌린다: `waiting_input`(메시지 대기) · `working`(엔진 실행 중) · `blocked`(위임 승인 대기). **`blocked` 에서는 자동으로 아무것도 진행하지 않는다.**

#### 6.4.2 메시지 1건 처리

```
user 메시지 append
  → routeWithFallback(메시지, cwd = 세션 폴더)
      assigned            → plan append, 상태 blocked, 배정·비용 카드 + 승인 버튼
      unclassified|direct → 직접 답
```

**직접 답** (Q11 확정 — Haiku·low, 분류 폴백과 같은 계층):
- 입력: §6.4.3 의 맥락 + 메시지. 프롬프트가 요구하는 것 — 대화로 답하되 **파일을 고치거나 명령을 실행하지 않는다**, 작업 결과를 지어내지 않는다, 작업으로 보이면 행을 제안한다.
- 항상 **읽기 전용**으로 띄운다 (`write` 없음). 세션의 쓰기 스위치와 무관하다.
- 마지막 줄은 `SUGGEST: Rxx` 또는 `SUGGEST: NONE` 이다. reviewer 판정처럼 **마지막 줄만** 읽는다. 못 읽으면 제안 없음 — 행을 추측하지 않는다.
- 제안이 있으면 화면은 "Rxx 로 위임" 을 띄우고, 누르면 `taskId: Rxx` 로 배정을 받는다 (FR-1 수동 덮어쓰기와 같은 경로). **자동으로 배정하지 않는다.**
- 비용은 세션 `Budget` 에 `지휘자·Haiku·low` 로 과금하고 메시지 옆에 한 줄로 찍는다. 승인은 받지 않는다.
- 실패하면 `error` 를 append 하고 사유를 화면에 올린 뒤 `waiting_input` 으로 돌아간다. 조용히 삼키지 않는다.

분류 입력은 **메시지 원문**이다. 후속 메시지("그거 테스트도")는 규칙에 안 붙기 쉽다 — LLM 폴백 프롬프트에 **직전 `summary` 한 줄**을 함께 준다. 규칙 분류기에는 맥락을 섞지 않는다(G1).

#### 6.4.3 맥락 전달

- 위임·직접 답 프롬프트 = `[최근 대화]` + `[이번 요청]`. 최근 대화는 기록에서 `user`·`direct`·`summary` 만 뽑아 **최근 `contextTurns` 턴**(기본 6), 끝에서부터 **`contextChars` 자**(기본 6000)로 자른다. 엔진 원시 출력(`result` 의 본문)은 싣지 않는다 — 요약이 그 자리를 대신한다.
- rolling 요약은 v2.1 에 두지 않는다. 최근 N턴 자르기로 시작하고, 부족하다는 실측이 나오면 연다.
- **resume** (§3.8): 다음 위임의 primary 슬롯이 **직전 성공한 위임의 primary 와 엔진·모델·effort 가 같고** 같은 세션 폴더면 그 엔진 세션을 이어 붙인다. 이때 프롬프트에는 그 실행 **이후**의 대화만 싣는다.
- **reviewer 는 resume 하지 않는다.** 이전 판정의 맥락이 다음 독립 검증을 끌어당기면 D-009 의 "독립" 이 흐려진다.

#### 6.4.4 결과 처리

- 위임이 끝나면 `result` 를 append 한다 (결정 로그 2차와 같은 시점).
- 지휘자(Haiku·low)가 요청·primary 출력(앞부분)·reviewer 판정·증거 요약을 받아 **3줄 이내 요약**을 낸다 → `summary` append.
- **다음 제안은 코드가 계산한다.** outcome 이 `wrong`·`unverified` 이거나 판정이 `fail` 이면 사다리(`core/ladder.ts`)의 다음 단계를 제안에 넣는다 — 상향 판단을 모델에 넘기지 않는다(G1). 모델은 요약만 한다.
- 다음 위임은 사용자가 승인해야 시작한다 (D-015).

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

### 7.1 GUI 화면 (v2.1)

| 화면 | 내용 |
|---|---|
| **세션 목록** | 최근 세션(`project` 는 폴더 이름, `scratch` 는 표시) · 상태(`waiting_input`/`working`/`blocked`) · 마지막 메시지 시각. "새 프로젝트 세션" · "새 스크래치" |
| **세션** | 상단: 작업 폴더(스크래치면 그렇다고)·워크트리·쓰기 스위치 — 폴더가 **항상 보인다**(D-029). 본문: 대화. 배정·비용·승인, 결과, 직접 답의 비용 한 줄이 **대화 안의 카드**로 뜬다. "업무 행 직접 지정" 은 배정 카드의 컨트롤로 남는다 |
| Dashboard · Reviews · Debug | v2 그대로 |
| **Agents** | v2 의 "Sessions" 화면(FR-9 — `claude agents`·codex 색인)을 이름만 바꾼다. orc 의 대화 세션과 이름이 겹치면 안 된다 |

v2 의 Run 폼은 세션 화면으로 대체한다. 탭을 옮겨도 세션 화면은 언마운트하지 않는다 (2026-09-23 `fe60bff` 의 원칙).

## 8. 결정 로그

경로: `~/.claude/logs/delegation-router.jsonl` (라우터 §7 스키마)

- **1차**: 배정을 확정한 시점에 `status:"decided"`, `outcome:"pending"`, `id`, `branch`(`down|keep|up_part|up_session`)
- **2차**: 검증이 끝난 뒤 **같은 `id`로 한 줄 더 append**. 갱신이 아니다. 쿼리는 `id`별 마지막 줄을 본다.
- **`id` 형식은 `MMDD-HHMM-xxx`다** (S6 변경). 라우터 스키마의 `MMDD-HHMM`은 사람이 손으로 쓸 때의 이야기이고, 제품은 같은 분에 여러 작업을 돌릴 수 있어 두 작업의 4줄이 한 `id`로 섞인다 — **"id당 2줄" 불변식이 깨지는 것을 실측으로 확인했다.** 접두는 그대로 두고 16진 3자리 접미사만 붙인다.
- 기본 경로는 라우터와 같은 `~/.claude/logs/delegation-router.jsonl`이고 `HS_ORC_DECISION_LOG`로 덮어쓴다. `note`에 `hs-orchestrator`를 넣어 사람이 쓴 줄과 구분한다.
- `downshifted`/`branch`는 **AA 측정치로 판정한다**(§2.3). 매트릭스 모델은 벤더가 갈려 계층 이름만으로는 비교할 수 없다. 기준 세션 모델은 `HS_ORC_SESSION_MODEL`(기본 `fable`)이다.
- 자동 증거 수집이 붙기 전까지 2차 줄의 `outcome`은 성공해도 **`unverified`다.** "성공했습니다"는 증거가 아니다(§5).
- 남기는 경우: 위임했을 때 / 티어를 내렸을 때 / 조건에 걸렸는데 일부러 안 내렸을 때 / 제안했지만 실행되지 않았을 때(거절·차단·무응답)
- 남기지 않는 경우: 그냥 "직접"으로 간 기본 경로 — v2.1 의 **직접 답·지휘자 요약**이 여기다. 그 기록은 세션 jsonl 에만 있다 (§6.4.1).
- v2.1: 1차 줄의 `note` 에 세션 id 를 넣어 결정 로그 ↔ 대화 기록을 잇는다.

## 9. 설정 파일

| 파일 | 내용 | 갱신 |
|---|---|---|
| `matrix.json` | 11행 배정표, 모델 계층, 비용, 사다리 | 원본 HTML에서 생성. 대조 테스트 필수 |
| `engines.json` | 바이너리 경로·이름 해석, 모델↔엔진 매핑, 가용성, effort 표기, cursor 변형 정책 | 수기 |
| `limits.json` | 최대 반복 수, 최대 노드 수, 누적 비용 상한, 타임아웃. v2.1: `contextTurns`(6)·`contextChars`(6000) | 수기 |

환경 변수 (테스트가 홈을 건드리지 않게 가두는 자리이기도 하다): `HS_ORC_DECISION_LOG` · `HS_ORC_RUN_STORE` · `HS_ORC_PROJECTS` · `HS_ORC_WORKTREES` · v2.1 `HS_ORC_SCRATCH`.

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
| 세션 id·resume argv (v2.1) | 세 엔진 스트림 캡처에서 id 를 읽는지, resume 시 argv 가 §3.8 과 같은지 |
| 메시지 처리 (v2.1) | 가짜 executor 로: 분류됨 → `blocked` + plan / 미분류 → 직접 답 · 읽기 전용 · 승인 없음 / 직접 답 실패 → `error` + `waiting_input` |
| `SUGGEST` 읽기 (v2.1) | 마지막 줄만 본다 · 못 읽으면 제안 없음 · 없는 행 id 는 버린다 |
| 대화 기록 (v2.1) | append-only · 다시 열면 같은 화면·맥락 · 깨진 줄을 세고 건너뛴다 |
| 맥락 자르기 (v2.1) | 턴 수·글자 수 상한 · `result` 본문 제외 · resume 시 그 실행 이후만 |
| resume 정책 (v2.1) | 같은 엔진·모델·effort·폴더일 때만 primary 가 잇는다 · **reviewer 는 절대 잇지 않는다** · resume 실패는 새 세션으로 조용히 떨어지지 않는다 |
| 스크래치 (v2.1) | `HS_ORC_SCRATCH` 안에만 만든다 · 쓰기를 켤 수 없다 |

순수 로직 테스트는 소스 옆 `__tests__/`에 둔다. GWT/AAA, 행위 기술형 `it` 이름.

게이트는 구현이 끝난 뒤 `type-check → lint → test` **마지막 1회**. 파일마다 반복하지 않는다.

## 11. 미해결

1. ~~`/loop` 자체 구현 vs 내장 스킬 활용~~ → D-016
2. ~~매트릭스 "해당 없음" 반복 시 행 추가 정책~~ → D-022
3. ~~누적 비용 상한 기본값~~ → D-017 · D-030
4. ~~TUI 프레임워크 선택~~ → D-018
5. ~~Cursor `-fast` 변형 사용 조건~~ → D-023
6. 스크래치 세션 보존·정리 정책 (DECISIONS Q12)
7. 위임된 엔진이 사용자 전역 hook·skills·MCP 를 싣고 뜬다 — 격리 여부 (Q13)
8. 맥락 자르기(최근 N턴)가 부족할 때 rolling 요약을 열 기준 — 실측 뒤 (§6.4.3)
