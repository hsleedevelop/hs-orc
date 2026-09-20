# hs-orchestrator 구현 메타프롬프트

## 역할

너는 hs-orchestrator를 처음부터 설계·구현하는 시니어 소프트웨어 엔지니어다. 사용자는 20년 경력 시니어 엔지니어이므로 기초 설명은 생략하고 결론·트레이드오프·다음 행동을 먼저 제시한다.

## 목표 (측정 가능한 최종 상태)

**hs-orchestrator**: 들어온 개발 작업 1건을 받아 ①업무 유형으로 분류하고 ②"GPT-5.6 x Claude 8모델 실무 사용 매트릭스 v6"에 따라 primary·reviewer 두 슬롯에 모델과 effort를 배정하고 ③`/delegation-router` 판정으로 위임 여부를 확정한 뒤 ④실제 CLI 엔진을 띄워 실행하고 ⑤매트릭스가 요구하는 수용 증거로 닫는 로컬 오케스트레이터. **v1은 TUI, v2는 GUI다.**

완료 판정: 실제 작업 1건이 분류 → 배정 → 실행 → 증거 수집까지 사람 개입 없이 통과하고, 그 판정 기록이 로그 파일에 남는다.

## 검증된 환경 사실 — 추측하지 말고 이대로 쓴다

이 값들은 2026-09-20에 실제 실행으로 확인했다. 다르게 기억하더라도 이 문서를 따르고, 구현 중 `--help`로 재확인한다.

| 엔진 | 바이너리 | 버전 | 비대화 실행 | 모델 지정 | effort 지정 |
|---|---|---|---|---|---|
| Claude | `claude` | 2.1.278 | `claude -p "<prompt>"` | `--model` | `--effort low\|medium\|high\|xhigh\|max` |
| Codex | `codex` | 0.154.0 | `codex exec "<prompt>"` | `-m/--model` | `-c model_reasoning_effort="<level>"` |
| Cursor | `cursor-cli` → 없으면 `cursor-agent` | 2026.09.15 | `cursor-cli -p "<prompt>"` | `--model` | **모델 id 접미사** (`gpt-5.6-sol-xhigh`) 또는 `'name[effort=high]'` |

확인된 함정 4가지 — 구현 중 반드시 방어한다:

1. **`codex -p`는 비대화 실행이 아니다.** codex 최상위의 `-p`는 프로파일이고, 비대화 실행은 `codex exec`(별칭 `codex e`)다. 스펙에 `codex -p`가 적혀 있어도 `codex exec`로 구현한다.
2. **`claude --effort`에 잘못된 값을 주면 경고만 내고 기본 effort로 조용히 실행된다.** 실측 출력: `Warning: Unknown --effort value 'bogus' — ignoring it and using the default effort.` 어댑터가 CLI에 넘기기 **전에** 검증하지 않으면 잘못된 effort로 돌고 아무도 모른다. 여기가 유일한 방어선이다.
3. **Cursor는 effort가 별도 플래그가 아니라 모델 id의 일부다.** `gpt-5.6-sol-xhigh`처럼 붙으며 `-fast`·`-thinking` 변형이 따로 있다.
4. **`cursor-cli` 바이너리는 이 환경에 설치돼 있지 않다** (설치된 것은 `cursor`와 `cursor-agent`). 제품은 `cursor-cli`를 먼저 찾고 없으면 `cursor-agent`로 폴백하는 해석 로직을 두고, 설정으로 덮어쓸 수 있게 한다.

공통 출력 계약: 세 엔진 모두 `--output-format`을 지원하며 `stream-json`을 받을 수 있다. 어댑터는 이 스트림을 파싱해 진행 상황을 UI에 흘린다.

**Cursor의 역할 — 대체 하네스**: `cursor-cli -p`는 매트릭스 모델을 **다른 하네스로 돌리는 대체 경로**다. `cursor-agent --list-models` 실측 결과 8모델 중 6개를 커버한다 — Luna(`gpt-5.6-luna-*`), Terra(`gpt-5.6-terra-*`), Sol(`gpt-5.6-sol-*`), Sonnet(`claude-sonnet-5-*`), Opus(`claude-opus-5-thinking-*`), Fable(`claude-fable-5-1-*`). **Astra와 Haiku는 없다.** Astra는 11행 중 6행(primary 4·reviewer 2), Haiku는 1행의 reviewer이므로 대체는 **모델별로만** 성립하고 전역 대체가 아니다. 지원하지 않는 조합에 대체를 시도하면 명시적 실패다 — 가장 가까운 모델로 말없이 바꾸지 않는다.

세션 조회에 쓸 수 있는 것: `codex agents`(로컬 app-server 데몬의 전체 에이전트 세션), `claude agents`. PR/MR 조회는 `gh-axi`(이 환경에 설치된 GitHub CLI 래퍼)를 우선하고 `gh`는 폴백으로 둔다.

## 분류 매트릭스 — 제품의 라우팅 원본

출처: `/Users/hsonpro/Documents/Codex/2026-09-20/astra-terra-fable-opus-test/outputs/gpt-5-6-claude-practical-matrix-v6.html`.
구현 전에 이 파일을 직접 읽어 `rows` 배열과 `profiles` 객체를 확인한다. 아래는 그 요약이며, 불일치가 있으면 원본이 이긴다.

**모델 계층**: OpenAI `Luna → Terra → Sol → Astra`, Claude `Haiku → Sonnet → Opus → Fable`. 단일 순위가 아니라 실행 역할의 계층이다.

**업무별 배정 (11행)** — 각 행은 `업무 | primary(모델|effort) | independent reviewer(모델|effort) | 운영 기준(수용 증거)`:

| 업무 | Primary | Reviewer | 운영 기준 |
|---|---|---|---|
| 짧은 구현 / 타입 수정 | Luna \| Mid | Haiku \| Low/Medium | 빠르게 수정하고 기존 test만 실행 |
| 요구사항 정리 / 기술 비교 | Terra \| High | Sonnet \| High | 결정 기준과 반례를 문서화 |
| 신규 기능 구현 | Sol \| High | Sonnet \| High | acceptance test를 먼저 고정 |
| 여러 파일 리팩터링 | Sol \| xHigh | Opus \| High | 영향 범위와 회귀 suite 확인 |
| 복잡한 버그 / 장애 RCA | Astra \| xHigh~Max | Fable \| xHigh | 가설이 아니라 로그로 반증 |
| 테스트 설계 / 회귀 분석 | Sol \| xHigh | Sonnet \| High | 실패 재현 → 최소 수정 → 회귀 |
| 성능 최적화 | Astra \| xHigh | Opus \| xHigh | baseline / 변경 / 재측정 3점 |
| 대규모 레거시 분석 | Fable \| xHigh~Max | Astra \| xHigh | 경로 추적 결과를 표본 검증 |
| 장기 마이그레이션 | Fable \| xHigh~Max | Astra \| High | 작은 batch와 rollback 지점 |
| 아키텍처 / 설계 | Fable \| High~xHigh | Astra \| xHigh | 대안·제약·실행계획을 분리 |
| 보안 / 배포 최종 검토 | Astra \| Max | Fable \| Max | 독립 리뷰 + 실제 검증 필수 |

**이 매트릭스에서 반드시 지켜야 할 세 가지 구조적 성질:**

1. **배정은 한 슬롯이 아니라 두 슬롯이다.** primary와 independent reviewer가 항상 쌍으로 나온다. 단일 엔진 선택기로 축소하면 제품이 아니다.
2. **reviewer는 primary와 다른 벤더다.** 11행 전부 OpenAI×Claude 교차다. 이것이 "독립 리뷰"의 정의이므로, 배정 로직은 이 교차를 불변식으로 강제하고 위반 시 실패시킨다.
3. **`운영 기준` 열은 장식이 아니라 그 업무의 수용 증거 정의다.** 실행이 끝났다는 판정은 이 열이 요구하는 증거가 수집됐을 때만 내린다.

**상향 사다리 (L1→L5)**: 어려워지면 즉시 최상위로 가지 않는다. 순서는 **코드·로그·재현 조건 보강 → effort 상향 → 모델 상향 → reviewer 추가**다.
`L1: Luna Mid / Haiku Low` → `L2: Terra High / Sonnet High` → `L3: Sol High / Opus High` → `L5: Astra Max / Fable Max + independent review`

**effort 어휘 정규화**: 매트릭스는 `Low / Medium / Mid / High / xHigh / Max`를 쓴다. codex의 `model_reasoning_effort`가 받는 값은 `low | medium | high | xhigh | ultra | max`다. `Mid → medium`으로 매핑하고, 정규화 테이블을 코드 한 곳에 두어 세 엔진 어댑터가 공유한다. 매핑되지 않는 값은 조용히 넘기지 말고 에러를 낸다.

**비용 인식**: 작업당 비용은 Haiku $0.21, Luna $0.18, Terra $1.40, Sol $1.99, Astra $3.26, Sonnet $5.09, Opus $5.86, Fable $7.63 (AA 벤치마크 측정치이며 실제 지출이 아니다). 배정 화면은 primary+reviewer 합산 예상 비용을 실행 전에 보여준다. Fable+Astra 조합은 최저가 조합의 약 50배다.

**근거 등급 분리**: Terminal-Bench 4.0은 model+agent harness 구성의 독립 벤치마크, AA composite은 독립 분석, 매트릭스 배치 자체는 operating policy다. UI는 이 세 등급을 섞어 표시하지 않는다. TB4의 Astra 58.2 대 Fable 57.9 같은 0.3pp 차이로 모델 우열을 표시하지 않는다.

## delegation-router와의 관계 — 순서를 틀리지 마라

`/delegation-router`(`~/.claude/skills/delegation-router/SKILL.md`)를 먼저 읽는다. 매트릭스와 라우터는 **다른 질문에 답한다.**

- **delegation-router**: 이 작업을 남에게 **넘길 것인가** (①하향 ②유지 ③부분상향 ④전체승격, §1 하한선).
- **매트릭스**: 넘긴다면 **누구에게 어떤 effort로** (primary+reviewer 두 슬롯).

따라서 파이프라인 순서는 고정이다:

```
작업 입력
  → 1. 업무 유형 분류 (매트릭스 11행 중 1행, 또는 "해당 없음")
  → 2. delegation-router §1 하한선 점검
       걸림  → 오케스트레이터가 직접 처리하고 종료 (배정하지 않는다)
       안 걸림 → 3으로
  → 3. 네 갈래 판정 + 매트릭스 배정 (primary/reviewer 모델·effort)
  → 4. 비용·대상 제시 후 실행 승인
  → 5. 엔진 어댑터로 실행 (primary → reviewer 순, 또는 병렬)
  → 6. 운영 기준 열이 요구하는 증거 수집·검증
  → 7. 결정 로그 append
```

§1 하한선(도구 호출 1~2번, 스크립트 한 줄, 이미 컨텍스트에 있음, 결과를 어차피 다 다시 읽어야 함, 중간에 사용자에게 물어야 함, 되돌리기 어려운 변경) 중 하나라도 걸리면 **배정 자체를 건너뛴다.** 매트릭스를 먼저 적용해 Fable을 띄워놓고 하한선을 확인하는 순서는 틀렸다.

결정 로그는 라우터 §7 스키마를 따라 `~/.claude/logs/delegation-router.jsonl`에 append한다. 착수 시 `status:"decided"` / `outcome:"pending"`으로 1차, 검증 후 같은 `id`로 2차를 **한 줄 더** append한다(갱신이 아니다). `branch`는 `down|keep|up_part|up_session`.

## 구현 순서 — 최소 e2e부터, 단계마다 동작 확인

추측성 추상화를 앞세우지 말고 아래 순서로 **가장 작은 end-to-end부터** 완성한 뒤 확장한다. 각 단계는 앞 단계가 실제로 도는 것을 확인한 뒤 시작한다.

0. **S0 — 파이프라인 먼저**
   코드보다 게이트를 먼저 세운다. 레이어 경계를 디렉터리로 고정(`core/` `adapters/` `shell/` `data/`)하고 `core/`가 `shell/`을 import하면 lint 에러가 나게 한다. `tsc --noEmit` + lint + test를 CI 또는 pre-commit에 건다. pre-commit 시크릿 스캔(`CURSOR_API_KEY` 등). `matrix.json`은 원본 HTML에서 뽑는 **생성물**이며 첫 줄에 `// GENERATED — 소스: <경로>`를 둔다.
   검증: 일부러 타입 에러를 넣으면 게이트가 실패하고 고치면 통과한다. **설정만 있고 게이트가 없으면 완료가 아니다.**

1. **S1 — 뼈대 e2e (여기서 먼저 멈추고 보고한다)**
   작업 문자열 1개를 CLI 인자로 받아 → 매트릭스 11행 중 1행으로 분류 → primary 슬롯만 배정 → 해당 엔진을 `-p`/`exec`로 실제 실행 → stdout을 그대로 출력. UI 없음, reviewer 없음, 로그 없음.
   검증: 서로 다른 업무 유형 3건이 서로 다른 엔진·모델·effort로 실제 프로세스를 띄운다.

2. **S2 — 엔진 어댑터 계층**
   `claude` / `codex` / `cursor-agent` 세 어댑터를 하나의 인터페이스 뒤로 넣는다(모델명, effort, 프롬프트, 작업 디렉터리, 스트림 콜백, 취소). effort 정규화 테이블, `--output-format stream-json` 파싱, 프로세스 취소·타임아웃을 여기서 끝낸다. 어댑터 밖에서는 CLI 플래그 문자열이 보이지 않아야 한다.
   검증: 어댑터 단위 테스트가 각 엔진에 대해 올바른 argv를 만들고, 잘못된 effort 값에 에러를 낸다.

3. **S3 — 라우팅 엔진**
   분류기 + delegation-router 하한선 점검 + 두 슬롯 배정 + 교차 벤더 불변식 + 비용 산정 + 상향 사다리(L1→L5). 매트릭스 데이터는 코드에 흩뿌리지 말고 **단일 선언적 테이블**(JSON/TS 상수)로 두고, 원본 HTML과의 대조 테스트를 붙인다.
   검증: 11행 전부에 대해 배정 결과가 매트릭스와 일치하고, 교차 벤더 위반이 만들어질 수 없음을 테스트가 보인다.

4. **S4 — 진행 방식 3종 (의미론 확정됨)**
   이 셋은 이 환경에 존재하지 않으므로 네가 구현한다. 의미론은 아래로 확정됐다.
   - **`/pingpong` — 대화형.** 사용자가 매 턴 개입하는 진행이며 **자율 실행이 아니다.** 1턴 = 1작업 단위, 턴 종료 시 결과와 다음 제안을 제시하고 **사용자 입력을 기다린다.** 사용자는 방향 수정·배정 변경(상향/하향)·중단을 언제든 할 수 있다. 매 턴 사용자가 승인하므로 최대 턴 제한은 두지 않되 누적 비용은 상시 표시한다.
   - **`/loop` — loop-engineering.** 자율 반복. Goal · Planner · Executor · Evaluator · Critic · Recovery · Stop을 **분리된 구성요소**로 만든다. 한 사이클에 가장 작은 작업 하나, 검증 없이 다음 사이클로 넘어가지 않는다. **Evaluator에는 reviewer 슬롯 모델을 쓴다** — 매트릭스의 독립 리뷰가 루프 안에서 실현되는 자리다. **최대 반복 수 없이는 구현하지 않는다.**
   - **`/graph` — graph-engineering.** 자율 DAG. 노드마다 **독립적으로 분류·배정**되어 한 그래프에 Luna 노드와 Fable 노드가 공존할 수 있다. **순환 검출은 실행 전 필수.** 병렬은 **쓰기 대상 파일 비겹침이 확인된 경우만**, 불확실하면 순차로 떨어뜨린다. 부분 실패 전파 규칙(`fail-fast` / `skip-dependents` / `continue`)을 노드마다 선언한다.
   세 방식 공통: 사이클·턴·노드마다 근거·변경·검증 결과를 남기고, 상한(반복 수·노드 수·누적 비용)에 도달하면 사람에게 올린다. **완료 판정은 정상 완료보다 상한 도달 시 정상 중단을 먼저 검증한다.**
   남은 결정 1개: `/loop`를 Claude Code 내장 `/loop` 스킬 위에 얹을지 자체 구현할지. 기본안은 **자체 구현**(내장 `/loop`는 간격 기반 재실행이고 여기서 필요한 것은 Planner/Evaluator 분리가 있는 루프다). 내장 `/loop`는 hs-orchestrator 자체를 주기 실행하는 바깥 껍데기로만 쓴다.

5. **S5 — TUI 셸 (v1). GUI는 v2다.**
   S1~S4가 헤드리스로 다 돌고 난 뒤에 붙인다. 화면 5개: **Run**(작업 입력 → 분류 → 배정 → **예상 비용** → 승인 → 실행 스트림), **Tasks**, **Dashboard**, **Sessions**(`codex agents` + `claude agents` 통합), **Reviews**(PR·MR, `gh-axi` 우선 `gh` 폴백).
   **v1은 TUI, v2는 GUI로 확정됐다.** 따라서 **Core(분류·라우팅·어댑터·진행 방식)는 UI를 모르는 헤드리스 라이브러리**여야 한다. Core가 Shell을 import하면 lint 에러가 나게 경계를 강제한다. v2에서 Core 수정이 필요하면 v1 설계가 틀린 것이다 — 그 경우 GUI를 진행하지 말고 경계를 먼저 고친다.

6. **S6 — 관찰가능성**
   결정 로그 2회 append, 실행별 원시 로그 보존, 디버그 화면은 프로덕션 빌드에도 포함, 화면 타이틀에 환경+버전.

## 제약

- 요청하지 않은 기능, 추측성 추상화, 관련 없는 리팩터링을 섞지 않는다. 현재 요구사항을 충족하는 가장 단순한 구현을 고른다.
- 새 의존성은 전체 복잡도나 신뢰성을 **실제로** 개선할 때만 추가하고 exact 버전으로 핀한다.
- 매트릭스 수치·모델명·effort를 코드에 하드코딩으로 흩뿌리지 않는다. 단일 원본 테이블 + 원본 대조 테스트.
- 벤더 CLI는 앱 코드가 직접 만지지 않는다. 어댑터 한 관문으로만 나간다.
- 외부 경계(CLI stdout, JSON 스트림, `gh` 응답)는 불신한다. 옵셔널 체이닝 + fallback, 파싱은 바깥 try와 분리된 중첩 try로 부분 실패가 전체를 죽이지 않게 한다.
- 시크릿·API 키를 하드코딩하거나 커밋하지 않는다. `CURSOR_API_KEY` 같은 값은 환경변수로만 읽는다.
- 정상 비즈니스 상태(결과 없음, 세션 만료)를 에러 로그로 올리지 않는다. `catch` 후 무동작 금지 — 실패에는 사용자에게 보이는 상태가 있어야 한다.
- 파일명 = default export 이름. 의도·도메인 설명 주석은 한국어, 식별자는 영어.

## 평가 기준

1. **배정 정확성** — 11행 전부가 매트릭스대로 배정되고 교차 벤더 불변식이 깨질 수 없다.
2. **순서 정확성** — 하한선 점검이 배정보다 앞에서 실행되고, 하한선에 걸린 작업은 엔진을 띄우지 않는다.
3. **실행 실재성** — 어댑터가 만든 argv로 실제 프로세스가 뜨고 스트림이 파싱된다. 모킹으로 끝내지 않는다.
4. **증거 수집** — 업무 유형별 `운영 기준` 열이 요구하는 증거가 실제로 모인다.
5. **비용 가시성** — 실행 전에 합산 예상 비용이 보인다.
6. **최소성** — 위를 만족하는 가장 적은 코드.

## 출력 형식

각 단계 종료 시:

1. **결과 한 줄** — 무엇이 돌게 됐는가
2. **변경 파일** — 경로와 역할
3. **실행한 검증** — 명령어와 exit code, 실제 출력 발췌
4. **판정 기록** — delegation-router 4줄 (메커니즘 / 모델 티어 / 관찰 근거 / 검증 산출물)
5. **남은 위험과 다음 단계**

## 위험 점검 — 구현 중 반드시 확인

- 매트릭스를 단일 엔진 선택기로 축소하지 않았는가 (reviewer 슬롯이 살아 있는가)
- 하한선 점검 없이 비싼 모델을 띄우는 경로가 있는가
- 상향 시 사다리를 건너뛰고 바로 Astra/Fable Max로 가는 경로가 있는가 (L1→L5 순서와 "먼저 근거 보강")
- 반복 방식(`/pingpong`, `/loop`, `/graph`)에 최대 횟수와 중단 조건이 없는가 — **무한 루프는 비용이 직접 나간다**
- 벤더별 CLI 플래그가 어댑터 밖으로 샜는가
- effort 정규화 실패가 조용히 기본값으로 떨어지는가
- 프로세스 취소·타임아웃이 실제로 자식 프로세스를 죽이는가 (좀비 codex/claude 프로세스)
- 근거 등급(independent / vendor / operating policy)을 UI에서 섞어 표시했는가

## 검증 절차

- 구현이 끝난 뒤 `type-check → lint → test`를 **마지막에 1회** 실행한다. 파일마다 반복하지 않는다.
- 어댑터는 실제 CLI로 최소 1회씩 실행해 확인한다(`--version` 수준이 아니라 짧은 실제 프롬프트).
- 배정 로직은 11행 전부에 대한 테이블 테스트로 덮는다.
- 순수 로직(분류기, effort 정규화, 비용 산정, DAG 순서)에는 단위 테스트를 소스 옆 `__tests__/`에 둔다.
- "설정만 있고 게이트가 없으면 완료가 아니다." 실행 결과를 증거로 보고한다.

## 중단 조건

- **S1이 안 도는데 S2 이후로 넘어가지 않는다.** 뼈대 e2e 실패는 설계 문제이지 다음 단계로 덮을 문제가 아니다.
- 매트릭스 원본 HTML과 구현 테이블이 불일치하면 구현을 멈추고 불일치를 보고한다.
- CLI의 실제 플래그가 이 문서와 다르면 멈추고 보고한다. 추측한 플래그로 진행하지 않는다.
- 같은 실패를 2회 연속 같은 방식으로 재시도하지 않는다.

## 사람에게 올리는 조건

- 실제 비용이 발생하는 실행을 처음 띄우기 전 (특히 Astra·Fable max 조합, 합산 $10.89 — 최저 조합 $0.39의 약 28배)
- `/loop`를 내장 스킬 위에 얹을지 자체 구현할지 (S4 착수 전). 기본안은 자체 구현
- 상한(반복 수·노드 수·누적 비용)에 도달했을 때
- 매트릭스 원본과 구현 테이블이 불일치할 때 — **구현을 멈추고 보고한다**
- 되돌리기 어려운 변경, 외부 쓰기, 남의 세션에 메시지를 보내기 전
- 매트릭스에 없는 업무 유형이 들어와 분류가 "해당 없음"으로 떨어질 때의 기본 배정 정책

## 첫 행동

코드를 쓰기 전에:

1. `docs/PRD.md`, `docs/SPEC.md`, `docs/PLAN.md`를 읽는다. 이 메타프롬프트와 충돌하면 **그 문서들이 이긴다** — 이 파일은 요약이고 그쪽이 명세다.
2. 매트릭스 원본 HTML의 `rows` 배열과 `profiles` 객체를 읽는다.
3. `~/.claude/skills/delegation-router/SKILL.md`를 읽는다.
4. `claude --help`, `codex exec --help`, `cursor-agent --help`, `cursor-agent --list-models`로 플래그와 모델 id를 재확인한다. 추측한 플래그로 진행하지 않는다.
5. **S0(파이프라인·레이어·CI 게이트)부터** 시작한다. 게이트를 일부러 실패시켜 동작을 확인한 뒤 S1로 간다.
