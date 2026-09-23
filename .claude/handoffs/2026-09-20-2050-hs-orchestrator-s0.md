# Handoff: hs-orchestrator-s0
- from: local_7d8ef15d-5fd2-4027-a273-e4eb9bf72d95 · cwd: ~/Library/Mobile Documents/com~apple~CloudDocs/shared_workspace/hs-orc · branch: main · 2026-09-20T11:50:00Z · model: claude-opus-5 (effort high) · 형식: full · 전달: B task_25579f8c · 종결: 2026-09-20 exciting-euclid-305787

## 1. 목표

**hs-orchestrator**를 만든다 — 「GPT-5.6 × Claude 8모델 실무 사용 매트릭스 v6」를 실행 가능한 라우터로 바꾸는 로컬 오케스트레이터. 작업 1건을 ①업무 유형으로 분류 → ②매트릭스대로 primary·reviewer **두 슬롯**에 모델·effort 배정 → ③`/delegation-router` 하한선으로 위임 여부 확정 → ④실제 CLI 엔진(claude/codex/cursor-cli) 실행 → ⑤그 업무가 요구하는 증거로 닫는다.

v1 = TUI, v2 = GUI. 진행 방식 3종(`/pingpong` 대화형, `/loop` loop-engineering, `/graph` graph-engineering)과 부가 기능(tasks, dashboard, 세션·서브에이전트 조회, PR·MR 조회)을 포함한다.

**이 세션의 범위는 설계 문서까지였고 전부 끝났다.** 다음 세션의 범위는 **`docs/PLAN.md`의 S0부터 구현**이다.

범위에서 제외: 모델 벤치마킹, 자체 LLM API 호출(모든 실행은 설치된 CLI 경유), 팀 협업·웹 서비스, IDE 통합, 매트릭스 편집기.

## 2. 현재 상태

- **완료**: 설계 문서 4종 + 메타프롬프트 + 검토용 슬라이드 덱 4종. git 초기화와 커밋 12개. 작업 트리 깨끗.
- **진행 중**: 없음.
- **미착수**: **구현 전부.** 소스 코드가 한 줄도 없다. `docs/PLAN.md`의 S0(파이프라인·레이어·CI 게이트)부터 시작한다.

## 3. 결정과 기각한 대안

전체 14건은 `docs/DECISIONS.md`에 D-001~D-014로 있다(배경·근거·영향·상태 포함). 구현에 직접 영향을 주는 것만:

- **D-009 배정은 두 슬롯이다** — 매트릭스 11행 전부가 `primary + independent reviewer` 쌍이고 전부 OpenAI×Claude 교차. `INV-1: vendor(primary) ≠ vendor(reviewer)`를 불변식으로 강제한다. **기각**: 단일 엔진 선택기(매트릭스의 절반을 버리게 됨).
- **D-008 라우터가 먼저, 매트릭스가 나중** — `분류 → §1 하한선 → (통과 시) 배정` 순서 고정. **기각**: 배정 먼저(하한선에 걸릴 작업에 Fable을 띄우게 됨).
- **D-011 effort 검증은 어댑터에서 던진다** — 정규 어휘 `low|medium|high|xhigh|max` 밖이면 예외. **기각**: 기본값 폴백(claude가 이미 조용히 그렇게 하므로 방어선이 사라짐).
- **D-004 cursor는 모델별 대체** — 8모델 중 6개만 커버. **기각**: 전역 대체(Astra·Haiku가 없어 성립 불가), 가장 가까운 모델로 치환(말없는 치환 금지).
- **D-005 바이너리 표기는 `cursor-cli`, 해석은 폴백** — 사용자가 `cursor-cli`로 부르기를 선택. 실행 시 `cursor-cli` → 없으면 `cursor-agent`. **기각**: 문서를 `cursor-agent`로 바꾸기.
- **D-001 v1 TUI / v2 GUI** — 따라서 Core는 UI를 모르는 헤드리스여야 한다. **기각**: GUI 먼저.
- **D-002 진행 방식은 자율성으로 가른다** — pingpong만 비자율(매 턴 사용자 승인)이라 턴 제한 불필요, loop·graph는 상한 필수.
- **D-003 `/loop`의 Evaluator에 reviewer 슬롯 모델** — 같은 모델이면 자기 채점이 된다. 1사이클 비용 = primary + reviewer.
- **D-010 `운영 기준` 열이 완료의 정의** — 완료 판정 로직을 새로 발명하지 않는다.
- **D-013 `matrix.json`은 생성물** — 원본 HTML에서 뽑고 대조 테스트로 고정. **기각**: 수기 전사.

## 4. 건드린 파일

전부 신규 생성. 미커밋 변경 **없음**.

- `docs/PRD.md` (158줄) — 문제, 목표 G1~G5, 비목표, 핵심 판단 5가지, FR-1~FR-11, 릴리스 단계, 성공 지표, 위험
- `docs/SPEC.md` (360줄) — **구현의 주 참조 문서.** 검증된 CLI 사실(§0), 4계층(§1), 매트릭스 11행(§2), 어댑터 인터페이스·모델별 가용성·effort 정규화(§3), 라우팅 파이프라인(§4), 증거 수집(§5), 진행 방식 3종(§6), TUI 화면(§7), 결정 로그(§8), 설정 파일(§9), 테스트(§10)
- `docs/PLAN.md` (208줄) — **다음 세션의 실행 순서.** S0~S7, 단계별 완료 판정과 최대 위험
- `docs/DECISIONS.md` (277줄) — D-001~D-014, 미해결 Q1~Q7
- `hs-orchestrator-meta-prompt.md` (208줄) — 구현 지시서 요약본. **SPEC/PLAN과 충돌하면 그쪽이 이긴다**(파일 안에 명시됨)
- `slides/index.html` + `slides/{prd,spec,plan,decisions}.html` + `slides/assets/{deck.css,deck.js}` — 검토용 덱 76슬라이드
- `.gitignore`

```
$ git status --short
(빈 출력)
$ git diff --stat
(빈 출력)
$ git stash list
(빈 출력)
$ git rev-parse --short HEAD
f544def
```

커밋 12개: `9ca1c6c` chore(repo) → `406a320` docs(meta) → `46f3ed8` docs(prd) → `849ed96` docs(spec) → `bdc7499` docs(plan) → `bfb76da` docs(decisions) → `4fd80e9` feat(slides) asset → `feadf0e` prd덱 → `28d79f3` spec덱 → `3e20ebd` plan덱 → `14e30bf` decisions덱 → `f544def` 허브

## 5. 검증 상태

**실행함 (전부 이 세션에서 실제로 돌림):**

- `claude --version` → `2.1.278` PASS
- `codex --version` → `codex-cli 0.154.0` PASS
- `cursor-agent --version` → `2026.09.15-d2fe57e` PASS
- `command -v cursor-cli` → **없음.** 설치된 것은 `cursor`와 `cursor-agent`뿐 (D-005의 근거)
- `codex --help` / `codex exec --help` → 최상위 `-p`는 `--profile`. 비대화 실행은 `codex exec`. effort는 `-c model_reasoning_effort=`
- `grep model_reasoning_effort ~/.codex/config.toml` → `enabled-reasoning-efforts = ["low","medium","high","xhigh","ultra","max"]`
- `claude --help | grep -A3 -- --effort` → `(low, medium, high, xhigh, max)`
- `claude -p --effort bogus "hi"` → **`Warning: Unknown --effort value 'bogus' — ignoring it and using the default effort.`** 경고만 내고 실행됨 (D-011의 근거)
- `cursor-agent --list-models` → Luna/Terra/Sol/Sonnet/Opus/Fable **있음**, **Astra·Haiku 없음** (D-004의 근거). effort는 모델 id 접미사(`gpt-5.6-sol-xhigh`)
- 슬라이드 4덱 76슬라이드 오버플로 검사 (로컬 HTTP + 브라우저 JS) → 1440×900 **0건**, 1280×720 SPEC **0건** PASS
- 슬라이드 해시 진입 버그(`#s8`이 안 먹음) 발견 → `hashchange` 리스너 추가 → `8 / 26` 정상 확인 PASS

**미검증 — 다음 세션이 확인해야 할 것:**

- **`codex -m`과 `claude --model`이 받는 실제 모델 id 문자열.** 매트릭스는 Luna/Terra/Sol/Astra/Haiku/Sonnet/Opus/Fable이라는 **표시 이름**만 갖고 있고, 각 CLI가 받는 실제 id는 확인하지 않았다. **PLAN S1의 명시적 위험 항목이며 추측하지 말고 실행으로 확인해 `engines.json`에 박아야 한다.**
- 세 엔진의 `--output-format stream-json` **실제 출력 스키마.** 지원한다는 것만 `--help`로 확인했고 스트림을 파싱해 본 적은 없다.
- `codex agents` / `claude agents`의 실제 출력 형태 (FR-9에 쓸 것)
- `gh-axi`의 PR·MR 조회 출력 형태 (FR-10)
- 슬라이드 PDF 인쇄 출력 (print CSS는 작성했으나 실제 인쇄 안 해봄)
- 비용 수치($0.18~$7.63)는 매트릭스 원본 전사일 뿐 독립 검증 안 함

## 6. 다음 한 걸음

**`docs/PLAN.md`의 S0을 실행한다.** 코드보다 게이트를 먼저 세운다:

1. TypeScript(strict) 프로젝트 초기화. Core는 런타임 중립으로.
2. 레이어 경계를 디렉터리로 고정: `core/` `adapters/` `shell/` `data/`. **`core/`가 `shell/`을 import하면 lint 에러**가 나게 규칙을 건다.
3. CI 또는 pre-commit에 `tsc --noEmit` + lint + test. `no-floating-promises`를 error로.
4. pre-commit 시크릿 스캔(gitleaks 등) — `CURSOR_API_KEY` 같은 값이 커밋되지 않게.
5. `matrix.json` 생성 스크립트 — 원본 HTML의 `rows` 배열과 `profiles` 객체를 파싱. 첫 줄에 `// GENERATED — 소스: <경로>`.

**S0 완료 판정**: 일부러 타입 에러를 넣으면 게이트가 **실패하고**, 고치면 통과한다. 설정만 있고 게이트가 없으면 완료가 아니다.

그 다음:
- **S1** 뼈대 e2e — 작업 문자열 → 분류 → **primary만** 배정 → 엔진 실행 → stdout 패스스루. **여기서 멈추고 보고한다.** 완료 판정은 업무 3종이 서로 다른 엔진·모델·effort로 실제 프로세스를 띄우는 것.
- **S2** 엔진 어댑터 3종 — effort 사전 검증(던지기), `supports()`, stream-json 파싱, 취소·타임아웃(좀비 테스트 포함)
- **S3** 라우팅 엔진 — Gatekeeper(하한선) → Assigner(INV-1) → 비용 → 사다리

## 7. 사용자에게 열린 질문 / 블로커

**§6(S0)을 막지 않는다.** 아래는 전부 S2 이후에 필요하다 — 물어보기 전에 S0을 끝내도 된다.

질문 (막는 단계 표기, `docs/DECISIONS.md` 미해결 목록과 동일):
- **Q1 `/pingpong`의 "대화형" 해석** (S4 막음) — 현재 해석은 **사용자와의 대화**(human-in-the-loop). primary↔reviewer 교대라면 자율 실행이 되어 최대 왕복 수·수렴 판정·교착 중단이 전부 필수가 되고 D-002의 상한 정책이 달라진다. D-006 참조.
- **Q2 `/loop` 자체 구현 확정** (S4) — 기본안은 자체 구현. D-007 참조.
- **Q3 누적 비용 상한 기본값** (S4)
- **Q4 매트릭스 "해당 없음" 반복 시 행 추가 정책** (S3)
- **Q5 TUI 프레임워크 선택** (S5)
- **Q6 Cursor `-fast` 변형 사용 조건** (S2)
- **Q7 v2 GUI 기술 선택** (v1 이후)

참고 (답 불필요):
- 사용자는 슬라이드 덱을 방금 브라우저로 열었다. 검토 피드백이 올 수 있다.
- `lavish-axi slides/index.html`로 주석 가능한 리뷰 세션을 띄우겠다고 제안해 둔 상태다(사용자 응답 없음).

## 8. 환경 함정

- **`codex -p`는 비대화 실행이 아니다.** 최상위 `-p`는 `--profile`. `codex exec`를 쓴다.
- **`claude --effort`는 잘못된 값을 경고만 내고 삼킨다.** 어댑터가 넘기기 전에 검증하지 않으면 잘못된 effort로 돌고 아무도 모른다.
- **`cursor-cli` 바이너리는 없다.** `cursor-agent`(`~/.local/bin/cursor-agent` 심볼릭 링크)가 실체. 문서·UI 표기는 `cursor-cli`로 유지하되 실행 해석은 폴백.
- **Cursor에 Astra·Haiku가 없다.** 매트릭스 11행 중 Astra는 6행(primary 4·reviewer 2), Haiku는 1행의 reviewer에 등장한다.
- **작업 디렉터리가 iCloud Drive 안이다** (`~/Library/Mobile Documents/com~apple~CloudDocs/...`). 경로에 공백이 있으므로 셸에서 반드시 인용한다. `node_modules/`가 동기화되면 느려지므로 `.gitignore`에 이미 넣어 뒀다.
- **`/pingpong`과 `/graph` 슬래시 커맨드는 이 환경에 존재하지 않는다.** `/loop`만 Claude Code 내장 스킬로 존재한다. 셋 다 이 제품이 정의·구현할 대상이다.
- 슬라이드는 `file://`로 열면 정상이지만 **Claude 프리뷰 창은 프로젝트 밖 파일을 `data:` 스냅샷으로 렌더해 상대경로 CSS가 끊긴다.** 검증하려면 로컬 HTTP 서버를 쓴다(이 세션에서 쓴 8731 포트는 종료함 — **현재 떠 있는 서버 없음**).
- 매트릭스 원본 HTML의 `rows` 배열은 328행 근처에 있다. JS 배열이라 정적 HTML 파싱으로는 안 나온다 — 스크립트 블록을 직접 읽어야 한다.

## 9. 새 세션이 먼저 읽을 것

1. `docs/PLAN.md` — S0부터의 실행 순서. **가장 먼저.**
2. `docs/SPEC.md` — 구현의 주 참조. 특히 §0(검증된 CLI 사실), §3(어댑터), §4(파이프라인)
3. `docs/DECISIONS.md` — 왜 그렇게 정했는지. 재논의 전에 읽는다
4. `~/.claude/skills/delegation-router/SKILL.md` — Gatekeeper가 구현할 §1 하한선의 원문
5. `~/Documents/Codex/2026-09-20/astra-terra-fable-opus-test/outputs/gpt-5-6-claude-practical-matrix-v6.html` — 매트릭스 원본. `matrix.json` 생성 소스

적용할 규칙: `~/.claude/CLAUDE.md`, `~/.claude/rules/hs-00-core.md`(게이트는 마지막 1회, 새 파일은 템플릿 복제, 교정 모드 ON), `~/.claude/rules/hs-engineering.md`(착수 순서 "코드보다 파이프라인 먼저" — S0이 정확히 이것이다).

`hs-orchestrator-meta-prompt.md`는 요약본이다. **SPEC·PLAN과 충돌하면 그쪽이 이긴다.**

## 인계 종결

사유: 수행함 — §6의 다음 한 걸음(`docs/PLAN.md` S0)을 실행하고 커밋했다.

- **한 것**: S0 전부. TypeScript strict 초기화 · 레이어 4종을 디렉터리로 고정하고 역방향 import를 lint 에러로 · `no-floating-promises` error · `githooks/pre-commit`(gitleaks + matrix 대조 + type-check + lint + test) · `scripts/gen-matrix.mjs` → `data/matrix.json`(11행·8모델·사다리 4단, 생성 중 INV-1 검사). 커밋 `142435d`.
- **게이트 실측**: 타입 에러 · 레이어 위반(core→shell) · 떠 있는 promise · 실패 테스트 · 수기 편집된 `matrix.json` · 가짜 GitHub 토큰 **6종이 각각 차단되고 되돌리면 통과**한다. 게이트 1회 1.5초.
- **남은 것**: S1(뼈대 e2e)부터. §5의 미검증 항목(실제 모델 id 문자열, stream-json 스키마)은 그대로 열려 있다 — S1에서 실행으로 확인해 `data/engines.json`에 박는다.
- **함정 1**: S0 커밋은 워크트리 브랜치 `claude/exciting-euclid-305787`에 있다. `main`에 머지하기 전까지 메인 체크아웃에는 소스가 없다.
- **함정 2**: `matrix.json`은 순수 JSON이라 SPEC §9의 "첫 줄 `// GENERATED`"를 지킬 수 없다(`JSON.parse` 실패). 대신 **첫 키 `$generated`**(source·sha256·generator)로 대체했다. SPEC §9를 이 형태로 고치거나 명시적으로 반려할 것.
- **함정 3**: gitleaks는 `EXAMPLE`이 들어간 값을 allowlist한다 — 훅 자가검증에 AWS 예제 키를 쓰면 "통과"해서 훅이 죽은 것처럼 보인다. 실측은 무작위 `ghp_` 토큰으로 했다.
- **함정 4**: `typescript-eslint@8.70`의 peer는 `typescript <6.1.0`이다. TS 7.0.2가 나와 있지만 아직 못 올린다 — TS는 `6.0.3`에 핀했다.
- **함정 5**: 원격이 없어 CI YAML 대신 pre-commit이 유일한 집행 지점이다. 원격이 생기면 `npm run gate`를 그대로 CI로 옮긴다. 훅은 인덱스가 아니라 작업 트리를 본다(부분 스테이징 주의).
