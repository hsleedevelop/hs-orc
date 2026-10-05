# hs-orchestrator — 기술 명세

- 버전: v0.2
- 작성일: 2026-09-20 · 개정 2026-09-23 (D-031 대화 세션 — §1·§3.1·§3.8·§4·§6.1·§6.4·§7.1·§8~§11)
- 대상: v1 (CLI · TUI — TUI 는 D-077 로 제거) · v2 (GUI) · v2.1 (대화 세션)
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
│  Shell (CLI · chat  /  GUI)                 │  ← 교체 가능한 계층
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

**명시적 예외 — 질문형 경로 (D-083):** 대화 세션에서 코드를 읽어야 답하는 질문은 배정이 아니라 읽기 전용 엔진 1슬롯(`읽기·Luna`)이 답한다 — reviewer·증거 요구·사다리가 없고 결과는 `result` 가 아니라 `direct`(`read`)다. 파일을 바꾸지 않아 독립 검증할 산출물이 없기 때문이다. 위임 배정(`assign()`)은 예외 없이 두 슬롯이다.

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

적용 경로(D-068): 위임이 미검증·실패로 끝나면 사용자가 '사다리 다음 단계로 다시 위임'(GUI)·`/ladder`(chat)를 눌러 같은 요청의 상향 배정 카드를 세운다 — 한 번에 한 단계, 모델은 자기 벤더에서 한 칸, INV-1·비용 재산정은 `assign()` 그대로, **카드만 서고 시작은 승인**(어느 방식에서도 A3 로 묻는다).

④ reviewer 추가(D-072): 기존 reviewer 를 **그대로 두고** 그 벤더 계층에서 한 칸 위 reviewer 1개를 더한다 — primary + reviewer 2 = 세 슬롯. 추가 reviewer 도 INV-1 을 지키므로 기존 reviewer 와 같은 벤더다. 기존 reviewer 가 최상위면 "건너뜀 — 이유" 이고 사다리가 끝난다. 두 reviewer 는 같은 산출물을 서로의 판정 없이 차례로 보고(둘 다 읽기 전용·resume 없음), 판정은 AND 다(§5). 예상 비용은 세 슬롯 합이다.

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
| Sol | codex | `gpt-6.1-sol` | `gpt-5.6-sol-{effort}` ✅ (cursor 목록에 6.1 변형이 없어 5.6 유지, 2026-09-30) |
| **Astra** | codex | `gpt-6-astra` | **없음 ❌** |
| **Haiku** | claude | `claude-haiku-4-5-20251001` | **없음 ❌** |
| Sonnet | claude | `claude-sonnet-5-5` | `claude-sonnet-5-5-{effort}` ✅ |
| Opus | claude | `claude-opus-5-5` | `claude-opus-5-5-{effort}` ✅ |
| Fable | claude | `claude-fable-5-1` | `claude-fable-5-1-thinking-{effort}` ✅ |

**Cursor는 8모델 중 6개만 커버한다.** Astra는 11행 중 6행에 등장(primary 4 / reviewer 2)하고
Haiku는 1행의 reviewer이므로, 대체는 **모델별로만 가능**하고 전역 대체가 아니다.
가용성은 `engines.json`에 선언적으로 두고, `supports()`가 이 테이블을 읽는다.
지원하지 않는 조합에 대체를 시도하면 **명시적 실패**다 — 가장 가까운 모델로 말없이 바꾸지 않는다.

Cursor 쪽 id에서 S1이 확인한 두 가지(SPEC v0.1보다 정밀해진 부분):

- **OpenAI 모델에는 `-thinking` 변형이 아예 없다.** §3.3의 "기본은 `-thinking` 계열" 정책은
  Claude 3모델(sonnet·opus·fable)에만 적용된다. `gpt-5.6-*`는 `-{effort}`와 `-fast`만 있다.
  단 **Sonnet 5.5는 `-thinking` 변형이 없다** (2026-09-29 실측: `claude-sonnet-5-5-{low|medium|high|xhigh|max}` 5종뿐, adaptive thinking이 기본) — `-{effort}`만 붙는다.
- **Opus 5.5도 `-thinking` 변형이 없다** (2026-09-30 실측: `claude-opus-5-5-{low|medium|high|xhigh|max}` 5종과 각 `-fast` 5종, adaptive thinking이 기본) — `-{effort}`만 붙고 5단계가 전부 비thinking으로 닿는다.
  옛 `claude-opus-5`는 비thinking이 `low|medium|high`뿐이라 `xhigh`·`max`가 `-thinking` 변형에만 있었다(그때 `-thinking` 기본값은 커버리지 요구사항이었다). Fable만 `-thinking` 을 그대로 쓴다.

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
- **`fast`는 모델별 옵트인이다** (D-023). 실측(2026-09-21): `-fast`는 Luna·Terra·Sol(각 6종)과 Opus(옛 5 는 8종, 2026-09-30 기준 5.5 는 5종)에 있고 **Sonnet·Fable 5.1에는 0종**이다. 없는 모델에 `fast`를 요청하면 **던진다** — 일반 변형으로 조용히 떨어뜨리는 것이 D-004가 금지한 말없는 치환이다.

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
  - 대화 세션의 위임 취소도 이 경로를 쓴다 — `AbortSignal` 이 `SlotRunOptions.signal` 로 내려가 어댑터 `cancel()` 을 부른다 (D-066).
- 진행 줄 (D-084): `RunEvent` 의 `progress` 는 claude·cursor `assistant` 줄(중간 글·`tool_use`)과 codex `command_execution`·`file_change` 에서 나온다. 결과 `text`·과금·증거에 들지 않는다. 실행기는 `SlotRunOptions.onProgress` 가 있을 때만 `progress`·`text`·`notice` 를 한 줄씩 넘기고, 대화 세션이 그것을 모아 GUI 의 "실행 중…" 아래에 보인다(기록에는 남기지 않는다).
  - 엔진이 자기 그룹 밖으로 띄운 자손(codex 는 셸 명령마다 새 그룹)도 죽인다 — 신호 전에 `ps` 로 자손을 모아 그 그룹·pid 에도 SIGTERM → 2초 → SIGKILL. 엔진이 먼저 끝나도 SIGKILL 유예는 지우지 않는다 (D-078).
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
- **같은 세션 폴더(cwd)에서만 resume 한다.** 엔진 제약은 아니다 — 2026-09-26 실측에서 claude·codex 모두 다른 cwd 에서도 id 로 이어졌고, 새 턴은 새 cwd 에서 돈다(codex 가 cwd 로 거르는 것은 세션 목록뿐). 앞 턴이 본 경로가 옛 폴더를 가리키므로 의미 보호로 둔다 (D-031 Q10 후속).
- 모르는 id 로 resume 하면 claude·codex 모두 모델 호출 전에 exit 1 로 실패한다 — 엔진이 조용히 새 세션을 열지 않는다 (같은 실측).
- resume 한 실행의 비용 보고는 **세션 누적**이다: claude `total_cost_usd`·`modelUsage`, codex `turn.completed.usage`. 실행기는 `engines.json` 의 `resume.cumulative` 칸에서 기록에 남긴 직전 원본 보고(`engineSession.reported`)를 빼서 과금한다. 기준이 없거나 빼서 음수면 원본을 센다 (D-057).
- claude 의 토큰은 `result.usage` 가 아니라 `modelUsage` 모델별 합으로 읽는다 — `total_cost_usd` 와 같은 범위라 압축·보조 호출 몫까지 든 누적이고, `resume.cumulative` 의 `usage` 로 빼진다. 압축 이벤트의 토큰은 더하지 않는다(두 번 센다). codex 는 압축 토큰을 보고하지 않아(`compactionUncounted`) 보정 없이 Budget 요약에 그 사실만 드러낸다 (D-060).
- claude `result.usage.cache_creation` 의 TTL 별 캐시 쓰기(1h·5m)는 **관측만** 한다 — 직접 답은 `direct` 기록의 `cacheWrite`, 위임은 원시 로그 `meta.json` 에 남긴다. 과금·상한에 쓰지 않고, 그 실행 몫이라 resume 해도 빼지 않는다 (D-062).
- Budget 요약은 토큰 누계를 **캐시 읽기와 그 외로 나눠** 보인다 — `토큰 1060322/2000000 (캐시 읽기 943872 · 그 외 116450)`. 표시 전용이고 상한 판정은 네 칸 1:1 그대로다. 캐시 읽기 칸 자체를 보고하지 않은 실행은 0 으로 읽지 않고 `캐시 읽기 미보고 N회` 로, 내역 칸이 없는 옛 `spend` 기록은 `내역 없음 N` 으로 드러낸다 (D-070).
- primary 실행 중 엔진이 맥락을 압축하면(claude `system`·`compact_boundary`) 결과 기록의 `compacted` 에 `trigger`·압축 전후 토큰을 남긴다. 그 세션은 다음 위임부터 **잇지 않고** orc 맥락을 실어 새로 띄운다 — 압축 요약이 세부를 버린다 (D-059).
- resume 이 실패하면(비정상 종료·id 없음) **새 세션으로 조용히 바꾸지 않는다.** 실패를 올리고, 재시도는 맥락을 실은 새 실행으로 사용자가 고른다 — 조용히 맥락 없는 실행으로 떨어지면 답이 그럴듯하게 틀린다.

## 4. 라우팅 파이프라인

```
작업 입력 (v2.1: 세션의 메시지 1건 — §6.4)
  │
  ├─ 1. Classifier      → 11행 중 1행 | "해당 없음"
  │                        Jev(D-065)가 먼저 고른다 — 행만, 확률·확신도 포함. 확신도 < `jevConfidenceMin` 이면
  │                        행을 확정하지 않고 후보를 사람에게 보인다. 못 쓰면 규칙 → Haiku 폴백(v2.1 세션은 규칙 → 지휘자 SUGGEST)
  │                        Jev 판정 라벨 GENERAL(행에 안 맞는 실제 작업, D-082)도 행이 아니다 — "해당 없음" 과 같이 다룬다
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
reviewer 가 둘이면(사다리 ④, D-072) 판정은 **AND** 다 — 하나라도 `FAIL` 이면 `fail`, 둘 다 돌아 둘 다 `PASS` 일 때만
`pass`, 그 밖(하나라도 못 읽음·상한으로 두 번째를 시작 못 함)은 `unknown` 이고 이때는 PASS 한 쪽의 `review` 증거도 싣지 않는다.

**"성공했습니다"라는 산문은 증거가 아니다.** `file:line`, 실행 명령과 exit code, 수정 경로, 인용 원문을 받는다.

구현: `src/core/evidence.ts` 의 `REQUIREMENTS` 가 위 표를 그대로 옮긴 것이다 — **이 표를 바꾸려면 SPEC 을 먼저 바꾼다.**
증거 종류는 `command`(명령+exit code) · `document-section` · `changed-files` · `measurement`(값+환경) ·
`citation`(`file:line`) · `review` · `ordering`(두 시각) 일곱이고, 모양 검사를 통과하지 못하면 **거절한다.**
`--verify "[phase:]<명령>"` 은 명령을 실제로 돌려 exit code 를 받고(R05 `before`/`after`,
R06 `reproduce`/`fix`/`regress` 단계 표기 지원), 변경 파일은 git 에서 읽는다 — 모델이 말한 목록을 믿지 않는다.
증거가 모였을 때만 결정 로그 2차 줄의 `outcome` 이 `ok` 가 된다. 아니면 `unverified` 다.
단, 모양이 맞아도 **나쁜 결과를 말하는 증거**가 하나라도 있으면 `rework` 다 (D-043) — phase 없는 명령과
`after`·`fix`·`regress` 는 exit 0 을, `before`·`reproduce` 는 exit ≠ 0 을 기대하고(위 표 5·6행의 "실패"·"통과"),
reviewer 판정 `FAIL` 도, `verify.json` 의 `tests` 로 선언된 **기존 테스트가 약해진 것**(줄이 바뀌거나 지워짐·파일 삭제 — 줄 추가는 허용, D-047)도 여기에 든다. 판정 순서는 실행 실패(`wrong`) → 나쁜 결과(`rework`) → 증거 충족(`ok`) → 그 밖(`unverified`).

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
| `project` | 사용자가 고른 폴더 (워크트리 포함, D-029). git 이 아니면 codex 는 **읽기 전용 위임만** 돈다 (D-055) | `~/.hs-orc/projects/<폴더 키>/sessions/<id>.jsonl` (D-071) |
| `scratch` | `~/.hs-orc/scratch/<id>/` 를 세션 시작 때 만든다 (`HS_ORC_SCRATCH` 로 뿌리를 바꾼다). git 아님, **쓰기 켤 수 없음** | `~/.hs-orc/projects/<그 폴더 키>/sessions/<id>.jsonl` (D-071) |

- **작업 폴더에는 아무것도 만들지 않는다** (D-071) — 빈 폴더를 요구하는 스캐폴더(`npx create-expo-app .` 등)가 위임에서 돌아야 한다. 원시 로그(`runs/`)·미분류 누적(`unclassified.jsonl`)도 같은 `projects/<폴더 키>/` 아래다. 폴더 키 = `<basename>-<실제 경로 sha256 앞 8자>`, 뿌리는 `HS_ORC_PROJECT_STATE` 로 바꾼다.
- D-071 이전 기록(`<폴더>/.hs-orc/sessions/<id>.jsonl`)은 **읽기만 한다** — 목록에 함께 뜨고, 같은 세션은 옛 자리 → 새 자리 순으로 이어 읽는다. 옮기거나 지우지 않는다.

- `id` 는 결정 로그와 같은 `MMDD-HHMM-xxx` (§8).
- 기록은 **append-only JSONL** 이다. 한 줄 = 한 사건:
  `{ v:1, at, turn, kind, … }` — `kind` 는 `user`(메시지) · `direct`(직접 답 — `read` 가 있으면 지휘자가 아니라 읽기 전용 1슬롯의 읽기 답, D-083) · `plan`(배정·비용) · `approval`(승인·거절) · `result`(primary 출력·reviewer 판정·증거·outcome·엔진 세션 id) · `summary`(지휘자 요약·다음 제안) · `error`(실패 사유) · `spend`(그 호출들로 쌓인 과금·토큰 — 화면에 안 보인다. 앱을 다시 켜고 열면 재생해 세션 Budget 을 되살린다, D-054).
- `scaffold`(스캐폴딩 카드 — 허용 목록 항목 id·argv·H7) · `scaffold-run`(스캐폴딩·`git init` 실행 결과 — outcome·exit code·출력 끝부분·폴더 맨 위 이름·git 상태. 엔진을 부르지 않아 `spend` 가 없다) 도 있다 (D-088). 옛 기록에는 없다.
- 세션을 다시 열면 기록을 **처음부터 다시 읽어** 화면과 맥락을 복원한다. 깨진 줄은 건너뛰고 수를 센다 — 결정 로그와 같은 규칙.
- 세션 상태는 AO 어휘를 빌린다: `waiting_input`(메시지 대기) · `working`(엔진 실행 중) · `blocked`(위임 승인 대기). **`blocked` 에서는 자동으로 아무것도 진행하지 않는다.**
- **이름과 점유 (D-085).** `kind: 'name'` 기록이 세션 이름이다(마지막 것이 이긴다, 빈 문자열은 지움). 영문자로 시작해 id 와 겹치지 않고, 아는 세션끼리 겹칠 수 없다. 엔진이 도는 동안·배정 카드가 메모리에 선 동안 그 프로세스가 `sessions/<id>.lock`(`pid·by·state`)을 쥔다 — 다른 프로세스는 그 세션에 쓰지 않고, 쥔 pid 가 죽었으면 없는 것으로 본다. 상태 폴더에는 `origin.json`(작업 폴더)을 남겨 `hs-orc session` 이 id·이름으로 어느 폴더의 세션인지 찾는다.
- **목록 상태 (D-085).** 점유가 있으면 `working`(진행 중)·`blocked`(승인 대기), 없으면 기록 끝으로 — 결과·요약이면 `done`(완료 · outcome), 승인 뒤 결과 없음이면 `interrupted`(끊김), 그 밖은 `idle`. 기록에만 남은 카드는 되살리지 않으므로 `idle` 이다.
- **외부 조작 (D-085).** `hs-orc session send <id|이름> "<메시지>"` 는 세션을 쥐고 디스크에서 새로 조립해 1턴을 돈다. `--run` 이 있어야 위임(읽기 위임·읽기 답 포함)을 시작한다 — 세션 방식이 auto·auto-ask 여도 같다(자동 승인은 GUI·`chat` 몫). 배정 카드가 서면 `--run` 이 승인(`--verify`) — 카드의 쓰기 값을 따른다(D-086 쓰기 행 카드는 쓰기로. 미커밋 변경(H5)이 있거나 확인 못 하면 실행하지 않고 거절, exit 1). `--write` 는 읽기 행 카드에도 쓰기를 켠다. `--run` 이 없으면 거절로 남긴다. 재시도 카드(D-081)는 `--run` 이 있어도 승인하지 않는다. 다른 프로세스가 덧붙인 기록은 GUI 가 다시 조립해 잇고(턴·Budget 을 기록에서 다시 계산), `chat` 은 다시 열라고 알린다.

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
  - *D-064 1단계 (구현됨, #62):* 제안이 있으면 세션이 곧바로 그 행으로 배정을 계산해(엔진 호출 없음) 직접 답 아래 배정·비용 카드를 붙인다 — 승인은 그 카드 1회다. `plan.reason` 은 `수동 지정` 이 아니라 `지휘자 제안 Rxx` 다. 대기 중 새 메시지는 그 배정을 거절로 남기고 처리한다. 이 배정은 어떤 승인 방식에서도 묻는다(§6.4.5 H1 — 폴백 경로 배정. 확신 있는 Jev 배정은 H1 제외).
- 비용은 세션 `Budget` 에 `지휘자·Haiku·low` 로 과금하고 메시지 옆에 한 줄로 찍는다. 승인은 받지 않는다.
- 실패하면 `error` 를 append 하고 사유를 화면에 올린 뒤 `waiting_input` 으로 돌아간다. 조용히 삼키지 않는다.

**Jev 경로 (D-065):** `jev` 분류기가 주입돼 있으면(GUI·`hs-orc chat` 기본) 위 분기 앞에서 Jev 가 "위임할지(NONE 이냐)·어느 행" 을 먼저 정한다 — 규칙과 지휘자 SUGGEST 는 부르지 않는다. 최근 2턴·1200자 대화 맥락과 메시지가 `api.typesafe.ai` 로 나간다(README "외부 전송"). 확신 있는 행(conf ≥ `jevConfidenceMin`)은 지휘자 호출 없이 배정 카드가 서고 `plan.reason` 은 `Jev Rxx p=… conf=…` 다. NONE·확신도 미만은 직접 답으로 가되 **지휘자의 `SUGGEST` 는 버린다**(카드가 서지 않고 후보만 보인다). criteria 에는 행 11개와 NONE 외에 판정 라벨 `GENERAL`(코드·파일을 읽어야 하는 설명·문서·다이어그램·조사·운영 확인 — 맞는 행이 없는 실제 작업)이 있다 — 행이 아니라서 배정은 서지 않고 NONE 과 같은 직접 답 경로를 타되, 화면이 행 선택 앞에 "행에 안 맞는 작업" 이라고 말하고 미분류 로그(D-022)에 센다. 세션의 NONE 은 세지 않는다 (D-082). 그 턴의 지휘자는 행을 제안하지 않고, 위임하려면 사람이 행을 고르라고 안내한다 — GUI 는 제안 없는 마지막 직접 답 아래의 "위임하기"(행 선택), `chat` 은 `/task Rxx` 이고 둘 다 `수동 지정` 카드를 세운다 (D-079). Jev 를 못 쓰면(키 없음·네트워크·401/422/429/529) 아래 옛 경로 그대로 돌고 `Jev 미사용 (사유)` 를 남긴다.

**질문형 경로 (D-083):** 코드·문서를 읽어야 답하는 질문은 읽기 전용 엔진 1슬롯(`core/reader.ts` — Luna·medium → codex, reviewer 자리라 쓰기를 받지 못하고 `readOnlyArgv` 가 붙는다)이 세션 폴더를 읽고 답하고 끝난다. 배정·reviewer·증거 요구·결정 로그·사다리가 없고, 결과는 `direct` 에 `read: { slot, by }` 를 달아 남긴다(비용은 `읽기·Luna·medium` 으로 세션 Budget 에 과금). 들어오는 길은 둘이다 — (a) Jev 확신 있는 `GENERAL` 이고 승인 방식이 허락하면 클릭 없이(`evaluateRead`: `manual` 은 안 함, H3 이면 안 함, `auto-ask` 는 A2 상한 근접이면 안 함. 쓰기로 보낸 메시지는 안 함) — 허락하지 않으면 위의 GENERAL 직접 답 경로에 이유 한 줄을 붙인다. (b) 사람의 명시 요청 — GUI 의 제안 없는 마지막 직접 답 아래 "코드를 읽고 답하기" · `chat` `/read`. 마지막 사용자 메시지가 대상이고 **그 클릭이 승인이다**(어느 방식에서도 카드 없이 바로 돈다, 상한 도달은 막는다). 위임처럼 취소할 수 있다(D-066).

**스캐폴딩 경로 (D-088 — D-074 B1 번복):** 위임 엔진은 `npx create-*` 를 돌리지 못한다(codex 샌드박스가 네트워크·홈 쓰기를 막는다, D-073 사실 8). 그래서 **분류(Jev·규칙)보다 먼저** 메시지가 새 프로젝트 생성 요청인지 결정론으로 본다(`core/scaffold.ts` `detectScaffold` — "init·초기화·스캐폴딩·새 프로젝트·앱 만들어" 같은 의도 낱말 + 허용 목록 키워드, 행 지정 `planAs` 는 보지 않는다). project 세션 · 허용 목록(`data/scaffolders.json`)에서 정확히 하나 · 폴더가 비어 있으면(`.git`·`.DS_Store` 만 있어도 빈 것) Jev·지휘자 호출 없이 `scaffold` 카드가 선다 — 어느 방식에서도 사람이 확인해야 돈다(H7). 승인하면 hs-orc 가 **엔진 없이** 그 argv 를 셸 없이 spawn 한다(cwd 는 세션 폴더, 실행 직전 허용 목록·빈 폴더를 다시 보고 아니면 `refused`, 시간 초과 `timeoutMs`·취소는 프로세스 그룹째 종료, 진행 줄은 D-084 통로). 결과는 `scaffold-run`. 성공했는데 폴더가 git 이 아니면 `git init` + 첫 커밋을 제안한다(GUI 버튼 · `chat` `/git-init`) — 스캐폴더가 이미 만들었으면 생략. 세션은 카드를 세울 때마다 폴더의 git 여부를 다시 보므로(`gitProbe`) 그 뒤 쓰기 행은 git 폴더 규칙(D-086)으로 선다. 카드를 못 세우는 조건(비어 있지 않은 폴더·스크래치·모르는/여러 프레임워크)이면 분류는 평소대로 가고, 분류 줄에 그 사유가 붙으며, 직접 답으로 가면 지휘자는 "행을 골라 위임하라" 대신 카드가 서는 길과 직접 돌릴 명령을 안내한다(SUGGEST 는 버린다). `hs-orc session send --run` 은 스캐폴딩 카드를 승인하지 않는다.

분류 입력은 **메시지 원문**이다. 규칙이 빗나가도 **LLM 분류 폴백은 돌지 않는다** (D-033) — 지휘자가 이미 대화 맥락 전체로 답하고 작업으로 보이면 `SUGGEST` 로 행을 제안하므로, 맥락 없는 폴백의 선택은 역할이 겹치고 후속 메시지를 잘못 위임할 수 있다. CLI 한 번 실행(`hs-orc "<작업>"`)은 대화 맥락이 없으므로 D-026 폴백(기본 켜짐)을 그대로 쓴다. `hs-orc chat` 은 세션이라 이 절을 따른다 (D-056).

규칙 분류는 여전히 먼저 돌므로 작업 키워드가 든 대화성 후속("방금 리팩터링한 부분 설명해")은 배정 카드로 간다. 카드의 **"지휘자에게 묻기"** 는 그 배정을 거절(`approval` approved=false)로 남기고 **같은 메시지**를 직접 답으로 보낸다 — 새 메시지·새 턴은 없다 (D-038).

#### 6.4.3 맥락 전달

- 위임·직접 답 프롬프트 = `[최근 대화]` + `[이번 요청]`. 최근 대화는 기록에서 `user`·`direct`·`summary` 와 취소된 위임의 한 줄(행·단계, D-066)만 뽑아 **최근 `contextTurns` 턴**(기본 6), 끝에서부터 **`contextChars` 자**(기본 6000)로 자른다. 엔진 원시 출력(`result` 의 본문)은 싣지 않는다 — 요약이 그 자리를 대신한다. 읽기 답(`direct.read`, D-083)은 요약이 없으므로 앞 1,500자만 `orc(코드를 읽고 답함): …` 로 싣는다.
- rolling 요약은 v2.1 에 두지 않는다. 최근 N턴 자르기로 시작하고, 부족하다는 실측이 나오면 연다. 그 실측의 재료로 자르기가 버린 양(`cut: { turns, chars }` — 버린 턴 수, 글자 상한으로 버린 글자 수)을 그 맥락을 받은 `direct`·`result` 기록에 남긴다. 안 잘랐으면 필드가 없다. resume 으로 엔진이 이미 가진 턴은 버린 것으로 세지 않는다. 여는 기준은 D-053.
- **resume** (§3.8): 다음 위임의 primary 슬롯이 **직전 성공한 위임의 primary 와 엔진·모델·effort 가 같고** 같은 세션 폴더면 그 엔진 세션을 이어 붙인다. 이때 프롬프트에는 그 실행 **이후**의 대화만 싣는다.
- **reviewer 는 resume 하지 않는다.** 이전 판정의 맥락이 다음 독립 검증을 끌어당기면 D-009 의 "독립" 이 흐려진다.

#### 6.4.4 결과 처리

- 위임이 끝나면 `result` 를 append 한다 (결정 로그 2차와 같은 시점).
- 지휘자(Haiku·low)가 요청·primary 출력(앞부분)·reviewer 판정·증거 요약을 받아 **3줄 이내 요약**을 낸다 → `summary` append.
- **다음 제안은 코드가 계산한다.** outcome 이 `wrong`·`rework`·`unverified` 이거나 판정이 `fail` 이면 사다리(`core/ladder.ts`)의 다음 단계를 제안에 넣는다 — 상향 판단을 모델에 넘기지 않는다(G1). 모델은 요약만 한다.
- 다음 위임은 사용자가 승인해야 시작한다 (D-015). D-064 의 자동 승인도 이것을 바꾸지 않는다 — 다음 위임은 사용자 메시지가 연다 (§6.4.5).
- 승인한 위임이 결과 없이 **예외로** 끝나면 `error` 뒤에 같은 계획의 `plan`(`retry: true`)을 append 하고 `blocked` 로 멈춘다 — 다시 세운 카드는 어느 방식에서도 A3 로 묻고, 그것도 던지면 다시 세우지 않는다 (D-081). 결과(`fail` 등)·취소·상한 차단은 해당 없음.

#### 6.4.5 승인 방식 (D-064 — 확정 2026-09-29, 3단계까지 구현됨 2026-09-30)

> 구현 순서: (1) SUGGEST 카드 합치기(§6.4.2) → (2) 세션 위임 취소 경로(D-066) → (3) 아래 방식 3종 — **모두 구현됨**. 자동으로 시작한 위임도 (2)의 취소로 멈출 수 있다. 판정은 `core/approval.ts`, 상수 A1 `$10`·A2 `2×`/`20%` 도 거기 있다.

| 방식 | 배정이 생기면 |
|---|---|
| `manual` | 언제나 `blocked` — 카드 승인 |
| `auto-ask` (새 세션 기본값, `limits.json` `approvalMode`) | H·A 조건 중 하나라도 걸리면 `blocked`, 아니면 바로 `approve()` |
| `auto` | H 조건만 `blocked`, 아니면 바로 `approve()` |

- **자동 승인은 클릭을 대신할 뿐 위임을 스스로 시작하지 않는다.** 사용자 메시지(또는 행 지정) 1건이 만든 배정 1건만 대상이다. 다음 제안·사다리 상향·재시도는 자동으로 시작하지 않는다 (D-015·D-031 결정 3).
- **H — 항상 묻는다 (방식으로 끌 수 없다):** H1 지휘자 제안에서 온 배정(규칙 분류 실패, D-022·D-033 — 폴백 경로로 고른 행에만; 확신 있는 Jev 행은 제외, D-065 결정 10) · H2 쓰기 켠 위임(D-025 — 쓰기는 배정마다 켜고 승인한다. **예외: `auto` 의 쓰기 행 · git 폴더는 묻지 않는다**, D-086) · H3 읽기 전용이 인자로 보장되지 않는 primary 엔진(지금 cursor, D-051·D-052) · H4 git 아닌 project 폴더의 쓰기 위임인데 primary 엔진이 git 밖에서 거절하는 엔진(`nonGitArgv` 선언 — 지금 codex, D-055·D-074; 승인은 막지 않고 거절을 미리 말한다. `manual` 은 같은 줄을 카드 안내 `guide` 로 싣는다) · H5 미커밋 변경이 있는 폴더의 쓰기 위임(`git status --porcelain` 이 비지 않음, 파일 3개와 나머지 수. `git status` 가 실패하면 모르는 것으로 묻는다 — fail-closed, D-086) · H6 git 아닌 project 폴더의 쓰기 행 — 읽기 전용으로 헛돈다(D-086). **H6 은 읽기 전용 승인을 막는다**(D-088 — 쓰기를 켠 승인은 H4 규칙대로 시작한다, 단계 카드는 막는다; `plan`·`steps` 의 `readOnlyBlocked`) · H7 스캐폴딩 카드 — hs-orc 가 허용 목록 명령을 엔진 없이 직접 실행한다(D-088, 자동 승인 경로가 없다). H5·H6 도 `manual` 은 `guide` 로 싣는다. 상한 도달은 묻지 않고 막는다 (D-030). git 아닌 project 폴더의 쓰기 위임이면 카드·직접 답에 "새 프로젝트면 빈 폴더에서 프레임워크를 넣어 보내 스캐폴딩 카드로, 기존 파일이면 git init 뒤 다시" 안내가 붙는다 (D-088, D-074 B1 번복).
- **A — `auto-ask` 만 묻는다:** A1 `plan.cost.totalUsd ≥ $10`(오늘 Fable+Astra 조합) · A2 상한 근접(api 슬롯이면 `remainingUsd < 2 × 예상`, 토큰은 `남은 < tokenBudget × 20%`) · A3 직전 위임이 `wrong`·`rework`·`fail` 인데 같은 행, 또는 행 기본보다 높은 effort·모델 · A4 세션의 첫 위임.
- **질문형 경로(D-083)는 배정이 아니라 이 표 밖이다** — `evaluateRead` 가 H3·A2 만 본다(H1·H2·H4·A1·A3·A4 는 해당 없음, `manual` 은 자동 안 함). 사람이 누른 "코드를 읽고 답하기"·`/read` 는 그 자체가 승인이다.
- 묻는 카드는 걸린 조건을 이름으로 보인다. 판정은 Core `ConversationSession` 이 기록·배정·`Budget` 으로 계산한다 — 모델에게 묻지 않는다(G1), 셸은 표시만 한다.
- 자동 승인도 `approval` 을 남긴다: `{ approved: true, write, by: 'auto', mode, asked: [] }` — `write` 는 카드의 값이다(쓰기 행 · `auto` · git 폴더면 `true`, D-086). 사람이 누르면 `by: 'user'` 와 걸린 조건 `asked`. 카드는 그대로 대화에 뜨고 `자동 승인 · <방식>` 한 줄이 붙는다(G2·FR-5). 결정 로그 1차·2차는 그대로이고 1차 `note` 에 승인 방식을 더한다. `spend`·비용 한 줄도 그대로다.
- 방식은 `{ kind: 'mode', mode }` 기록으로 영속하고, 열 때 마지막 것을 재생한다(D-054 와 같은 원리). `mode` 가 없는 기록은 `manual` 로 연다. 다시 열기(D-063)는 도는 객체의 방식 또는 재생한 방식을 쓴다. 방식을 바꿔도 이미 선 카드는 자동 승인하지 않는다.
- **쓰기 행 (D-086).** `limits.json` `writeRows`(R01·R03·R04·R05·R07·R09)의 배정은 git project 폴더에서 쓰기 스위치를 켠 채 선다. 방식과 무관하다. 스크래치·git 아닌 폴더는 켜지 않는다. 예외 재시도 카드(D-081)는 그 실행의 값을 쓴다.
- **쓰기 위임으로 보내기 (H2 의 통로).** 쓰기 행이 아닌 메시지를 쓰기로 보낼 때 쓴다. 사용자가 메시지를 쓰기 위임으로 보내면(`send(text, { write })` — GUI 입력창 체크, chat `/write <문장>`) 어느 방식에서도 카드가 서고 쓰기 스위치가 켜진 채다.
- **H1 출처.** `plan.reason` 이 `키워드 `·`Jev `·`수동 지정 ` 으로 시작하지 않으면 모델이 고른 행이다(모르는 출처는 묻는다).
- 새 세션은 첫 메시지 전에 그때의 방식을 `mode` 기록으로 굳힌다. 옛 세션(방식 기록 없음)은 `manual`, 첫 새 메시지에서 그것을 기록한다.
- 셸: GUI 세션 머리의 방식 선택 · `hs-orc chat` 의 `/mode [방식]`·`/write <문장>`·`--approval <방식>`. (v1 TUI 는 대화 세션 없이 남았다가 D-077 로 제거됐다.)

## 7. 화면 공통 규칙

v1 의 TUI(Ink 7 + React 19, D-018 — Run·Tasks·Dashboard·Sessions·Reviews·Debug)는 **D-077 로 제거했다.**
터미널은 CLI(한 번 실행 · `hs-orc chat`)이고 화면은 GUI(§7.1)다. 아래 표시 규칙과 외부 CLI 실측은 GUI 가
그대로 따른다. **JSX는 쓰지 않는다** — 화면 판단은 순수 뷰모델(`src/shell/view-model.ts`)에 두고
렌더 층을 얇게 유지한다 (D-019).

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
| **세션 목록** | 최근 세션(`project` 는 폴더 이름, `scratch` 는 표시) · 마지막 메시지 시각 · **상태 칩**(진행 중·승인 대기·완료 · outcome·끊김·idle)과 **이름 · id** (D-085 — 2026-09-24 의 "상태 열 없음" 을 바꾼다: 점유 표식과 기록 끝으로 계산한다). 4초마다 다시 읽는다. "새 프로젝트 세션" · "새 스크래치" |
| **세션** | 상단: 작업 폴더(스크래치면 그렇다고)·워크트리·쓰기 스위치 — 폴더가 **항상 보인다**(D-029). "터미널" 은 그 폴더에서 옆 선택(기본·Ghostty·Otty, 이 기기에 기억)의 터미널을 연다(macOS `open -a`). "기본" 은 `HS_ORC_TERMINAL`, 없으면 Terminal 이다. 본문: 대화. 배정·비용·승인, 결과, 직접 답의 비용 한 줄이 **대화 안의 카드**로 뜬다. "업무 행 직접 지정" 은 배정 카드의 컨트롤로 남는다. 머리에 id(누르면 복사)와 "이름 붙이기"(D-085). 다른 프로세스가 쥐었으면 "다른 곳에서 도는 중 · <by> · pid" 를 보이고 모든 조작을 막는다 |
| Dashboard · Reviews · Debug | v2 그대로 — Debug 의 "고의 크래시" 가 TUI `c` 키의 자리다 |
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
- 2차 줄의 `rework` 는 "실행은 됐고, 증거가 완료가 아니라고 말한다" 다 — 기대와 다른 exit 또는 reviewer `FAIL` (§5, D-043). `unverified`(검증 안 함)·`wrong`(실행 실패)과 다르다.
- 남기는 경우: 위임했을 때 / 티어를 내렸을 때 / 조건에 걸렸는데 일부러 안 내렸을 때 / 제안했지만 실행되지 않았을 때(거절·차단·무응답)
- 남기지 않는 경우: 그냥 "직접"으로 간 기본 경로 — v2.1 의 **직접 답·지휘자 요약**이 여기다. 그 기록은 세션 jsonl 에만 있다 (§6.4.1).
- v2.1: 1차 줄의 `note` 에 세션 id 를 넣어 결정 로그 ↔ 대화 기록을 잇는다.
- v2.1: 세션에서 배정을 거절(행 바꾸기·지휘자에게 묻기 포함)하면 `declined`, 누적 상한으로 승인을 막으면 `blocked` — 1차 `decided` 와 같은 `id` 로 2차를 남기고 `outcome:"unverified"`, `verified:"-"` 다 (라우터 스키마). 위임이 예외로 끝나면 2차는 `ran`/`wrong` 이다.

## 9. 설정 파일

| 파일 | 내용 | 갱신 |
|---|---|---|
| `matrix.json` | 11행 배정표, 모델 계층, 비용, 사다리 | 원본 HTML에서 생성. 대조 테스트 필수 |
| `engines.json` | 바이너리 경로·이름 해석, 모델↔엔진 매핑, 가용성, effort 표기, cursor 변형 정책 | 수기 |
| `limits.json` | 최대 반복 수, 최대 노드 수, 누적 비용 상한, 타임아웃. v2.1: `contextTurns`(6)·`contextChars`(6000) | 수기 |

환경 변수 (테스트가 홈을 건드리지 않게 가두는 자리이기도 하다): `HS_ORC_DECISION_LOG` · `HS_ORC_RUN_STORE` · `HS_ORC_PROJECTS` · `HS_ORC_WORKTREES` · v2.1 `HS_ORC_SCRATCH` · `HS_ORC_PROJECT_STATE`(D-071). GUI 세션의 "터미널" 이 "기본" 일 때 여는 앱은 `HS_ORC_TERMINAL`(macOS 앱 이름, 그 밖은 실행 파일)이다.

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
| 대화 기록 (v2.1) | append-only · 다시 열면 같은 화면·맥락 · 깨진 줄을 세고 건너뛴다 · 앱 재시작 뒤 열어도 세션 Budget 이 같다 |
| 맥락 자르기 (v2.1) | 턴 수·글자 수 상한 · `result` 본문 제외 · resume 시 그 실행 이후만 · 잘렸을 때만 버린 양을 기록에 남긴다 |
| resume 정책 (v2.1) | 같은 엔진·모델·effort·폴더일 때만 primary 가 잇는다 · **reviewer 는 절대 잇지 않는다** · resume 실패는 새 세션으로 조용히 떨어지지 않는다 |
| 스크래치 (v2.1) | `HS_ORC_SCRATCH` 안에만 만든다 · 쓰기를 켤 수 없다 |

순수 로직 테스트는 소스 옆 `__tests__/`에 둔다. GWT/AAA, 행위 기술형 `it` 이름.

게이트는 구현이 끝난 뒤 `type-check → lint → test` **마지막 1회**. 파일마다 반복하지 않는다.

## 11. 미해결

1. ~~`/loop` 자체 구현 vs 내장 스킬 활용~~ → D-016
2. ~~매트릭스 "해당 없음" 반복 시 행 추가 정책~~ → D-022
3. ~~누적 비용 상한 기본값~~ → D-017 · D-030
4. ~~TUI 프레임워크 선택~~ → D-018 (TUI 는 D-077 로 제거)
5. ~~Cursor `-fast` 변형 사용 조건~~ → D-023
6. ~~스크래치 세션 보존·정리 정책~~ → 자동 정리 없음 (DECISIONS Q12)
7. ~~위임된 엔진이 사용자 전역 hook·skills·MCP 를 싣고 뜬다 — 격리 여부~~ → D-032 (지휘자만 격리) · D-050 (Q13)
8. ~~맥락 자르기(최근 N턴)가 부족할 때 rolling 요약을 열 기준~~ → D-053 (잘림 기록 + 손실 사례 확인 시 연다)
