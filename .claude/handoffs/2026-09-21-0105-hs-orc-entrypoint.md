# Handoff: hs-orc-entrypoint
- from: local_9d011a6b-f6e2-471a-b508-477b4adce448 · cwd: ~/Library/Mobile Documents/com~apple~CloudDocs/shared_workspace/hs-orc/.claude/worktrees/exciting-euclid-305787 · branch: claude/exciting-euclid-305787 · 2026-09-21T01:05:00+09:00 · model: claude-opus-5 (effort high) · 형식: full · 전달: B task_8a8dc72e · 종결: 2026-09-21 elastic-ishizaka-2a00e1

## 1. 목표

**hs-orchestrator** — 「GPT-5.6 × Claude 8모델 실무 사용 매트릭스 v6」를 실행 가능한 라우터로 바꾸는 로컬 오케스트레이터. 작업 1건을 ①분류 → ②primary·reviewer **두 슬롯** 배정 → ③`/delegation-router` 하한선 → ④실제 CLI 엔진(claude/codex/cursor) 실행 → ⑤그 업무가 요구하는 증거로 닫는다.

**PLAN S0~S7 전 단계가 끝났고 미결 질문(Q1~Q7)도 전부 종결됐다.** 이 인계의 범위는 그 다음이다:

- **§6 = 진입점(3번)** — 지금은 이 저장소 안에서 `npm run` 으로만 돈다. 아무 프로젝트에서 부를 수 없다.
- 그 다음 **실사용 1건(2번)** — 지금까지 실행은 전부 `'ok' 한 줄만 답하라` 같은 인위적 프롬프트였다.

범위 제외: 모델 벤치마킹, 자체 LLM API 호출(모든 실행은 설치된 CLI 경유), 팀 협업·웹 서비스, IDE 통합, 매트릭스 편집기.

## 2. 현재 상태

- **완료**: PLAN S0~S7 전부 + v1 릴리스 게이트 통과 + 증거 수집기 + 크래시 자가검증 + Q1~Q7 종결 + **두 슬롯 실제 실행(D-009)**. 커밋 18개가 전부 `main`에 머지됨(`d0f66b2`). 169 테스트 PASS.
- **진행 중**: 없음. 작업 트리 깨끗.
- **미착수**: 진입점(어디서나 부를 `bin`), 실사용 검증, 비용 실비화, README.

직전 세션에서 발견·수정한 가장 큰 결함: **reviewer 슬롯이 `--mode loop` 외에는 한 번도 실행되지 않았다.** 배정·비용은 두 슬롯으로 표시하면서 primary만 돌렸다. `core/duo.ts`로 CLI once·TUI·GUI 전부에 붙였고, 실측에서 Luna(codex)의 `"ok"`를 Haiku(claude)가 **FAIL** 판정하며 근거 3건을 지적했다.

## 3. 결정과 기각한 대안

전체 23건은 `docs/DECISIONS.md`에 D-001~D-023. 진입점 작업에 직접 걸리는 것만:

- **D-019 JSX를 쓰지 않는다** — Node 타입 스트리핑이 JSX를 못 읽어 빌드 단계가 생기고, 그러면 S0의 게이트(`node --test`로 `.ts` 직접 실행)가 통째로 바뀐다. **개정(S7)**: Electron 렌더러만 esbuild로 묶는다(Chromium은 TS도 bare specifier도 못 읽어 선택이 아니라 제약). **번들러가 생겼어도 JSX는 안 쓴다.** → **진입점을 만들 때 빌드 산출물(dist/)을 만들지 말 것.** `bin`은 `.ts`를 그대로 실행해야 한다.
- **D-001 v1 TUI / v2 GUI, Shell만 교체** — S7에서 `git diff main -- src/core src/adapters src/data`가 **비어** 있음을 확인했다. 진입점도 `shell/`에만 붙인다.
- **D-009 두 슬롯 + INV-1 교차 벤더** — `CrossVendorPair`가 검사된 팩토리로만 생성되는 branded type.
- **D-013 `matrix.json`은 생성물** — 원본 HTML이 진실. `npm run matrix:check`가 게이트 첫 단계다.
- **D-022 미분류는 제안만** — 행 추가는 원본 HTML 수정 → `gen:matrix`로만. 로컬 오버레이 금지.
- **D-017 누적 비용 상한 $20** — 기각: 무제한(자율 방식은 무한 반복이 곧 비용).

## 4. 건드린 파일

**미커밋 변경 없음.** 워크트리·`main` 둘 다 `d0f66b2`.

```
$ git status --short     (빈 출력)
$ git diff --stat        (빈 출력)
$ git stash list         (빈 출력)
$ git rev-parse --short HEAD
d0f66b2
```

구조(전부 `main`에 있음):
- `src/core/` — classify·pipeline(순서의 유일한 소유자)·gatekeeper·assign·ladder·budget·journal·executor·**duo**·evidence·decision-log·decide·run-store·report·unclassified·modes/{pingpong,loop,graph}
- `src/adapters/` — resolve(argv·바이너리 해석)·engine(EngineAdapter)·stream(3엔진 파서)·run(프로세스 그룹 종료)·types
- `src/data/` — matrix·engines·limits·verify 로더 + `data/*.json`
- `src/shell/` — `cli.ts`(CLI) · `tui/`(Ink) · `gui/`(Electron: main·service·preload.cjs·renderer) · `integrations.ts`
- `docs/` — PRD·SPEC·PLAN·DECISIONS (전부 실측으로 갱신됨)
- `githooks/pre-commit` — gitleaks → matrix:check → type-check → lint → test

## 5. 검증 상태

**실행함:**
- `npm run gate` (= matrix:check → type-check → lint → test) → **exit 0, 169 pass / 0 fail**. 워크트리·`main` 양쪽에서 확인.
- 세 엔진 실제 실행: codex(luna·low) 15.5s · claude(haiku·low) 11.3s · cursor(luna·low) 23.8s, 셋 다 `ok`, 파싱 실패 0줄.
- **두 슬롯 실측**: CLI `--run` → Luna(codex) 실행 → Haiku(claude) 독립 검증 → `FAIL` + 누락 3건. 원시 로그 `01-Luna` / `02-Haiku` 양쪽 보존. TUI·GUI도 reviewer 도달 확인.
- 결정 로그: 같은 `id` 2줄(`pending` → `unverified`/`ok`), 누락 0%.
- 증거 게이팅: 증거 없이 → `unverified`, `--verify` 통과 → `ok`.
- 좀비 테스트 **음성 대조**: 그룹 종료를 자식 종료로 바꾸면 4건이 전부 실패, 되돌리면 통과.
- 하한선 **순서 증명**: PATH를 비운 CLI에서 `--gate --run`이 바이너리 해석조차 안 함(spawn 0회). `--gate`만 빼면 "바이너리를 찾지 못했다"가 나옴.

**미검증 — 다음 세션이 확인해야 할 것:**
- **진입점은 존재하지 않는다.** `npm run tui` / `npm run gui` / `node src/shell/cli.ts` 뿐이다. 다른 디렉터리에서 실행했을 때 `data/*.json` 경로 해석(`import.meta.dirname` 기준)이 맞는지 **확인 안 했다**. 이게 진입점 작업의 첫 번째 위험이다.
- **실사용 0건.** 분류기 키워드 표(11행)가 진짜 작업에 쓸 만한지, 증거 요구가 현실적인지 모른다.
- **비용은 대부분 추정이다.** claude만 `total_cost_usd`를 주고 codex·cursor는 토큰만 준다 — 단가표가 없어 `estimate`로 누적된다. 표시는 `(추정 포함)`으로 정직하다.
- `--mode graph`의 JSON 노드 스펙에 **커밋된 예제가 없다**(usage 줄에만 형식이 있음).
- iCloud `.nosync` 구성이 실제로 동기화를 줄이는지 — iCloud 쪽 동작이라 확인 불가.

## 6. 다음 한 걸음

**`hs-orc` 진입점을 만든다.** 아무 프로젝트 디렉터리에서 부를 수 있어야 하고, **빌드 단계를 추가하지 않는다**(D-019).

1. `package.json`에 `"bin": { "hs-orc": "./bin/hs-orc.mjs" }` 를 추가하고 `bin/hs-orc.mjs`를 만든다. 이 파일은 `src/shell/cli.ts`(기본) / `tui/main.ts`(`tui` 하위명령) / `gui/main.ts`(`gui`)로 분기한다. `.ts`를 그대로 실행하므로 Node 22.6+ 타입 스트리핑이 전제다 — `engines.node`가 이미 `>=22.6`이다.
2. **`data/*.json` 경로 해석을 먼저 확인한다.** `src/data/{matrix,engines,limits,verify}.ts`가 `import.meta.dirname` 기준으로 `../../data/`를 보므로 **설치 위치 기준**이라 맞을 것이다 — 그러나 `run-store.ts`·`unclassified.ts`는 `process.cwd()` 기준이다(**의도적이다**: 실행 산출물은 작업 중인 프로젝트에 쌓여야 한다). 이 둘이 섞여 있다는 점을 테스트로 고정한다.
3. 다른 디렉터리(예: `/tmp`의 빈 git repo)에서 `hs-orc "이 타입 에러 고쳐줘"`를 돌려 배정·비용 제시까지 통과하는지 확인한다. `--run`까지 가면 그 프로젝트에 `.hs-orc/runs/`가 생겨야 한다.
4. `npm link` 또는 `~/.local/bin` 심볼릭 링크로 실제 설치하고, **설치 후 경로에서** 게이트를 다시 돌린다.

**완료 판정**: 이 저장소 **바깥**의 디렉터리에서 `hs-orc "<작업>"`이 분류·배정·비용까지 내고, `--run`이 두 슬롯을 띄우며, 그 디렉터리에 `.hs-orc/runs/<id>/01-*·02-*`가 생긴다.

그 다음:
- **실사용 1건** — 진짜 작업(예: 이 저장소의 실제 개선 하나)을 `hs-orc`로 통과시킨다. 분류가 틀리면 키워드 표를, 증거 요구가 비현실적이면 `REQUIREMENTS`를 고친다. **고칠 때 SPEC §5를 먼저 고친다**(코드가 SPEC의 전사이므로).
- **비용 실비화** — codex·cursor의 토큰 사용량은 이미 파싱된다. 모델별 단가표(수기 `data/pricing.json`)를 두면 `estimate`를 `actual`로 바꿀 수 있다. 출처 표기(`actual`/`estimate`)를 섞지 말 것.
- **README** — 없다.

## 7. 사용자에게 열린 질문 / 블로커

**없음.** Q1~Q7이 전부 D-015~D-023으로 종결됐고 §6을 막는 질문은 없다.

참고 (답 불필요):
- 사용자는 `node_modules`를 `node_modules.nosync` + 심볼릭 링크로 바꿔 두었다. `npm ci`는 링크를 지우므로 그 뒤엔 링크를 다시 걸어야 한다(`npm install`은 안전).
- 결정 로그 기본 경로가 사용자의 개인 라우터 로그(`~/.claude/logs/delegation-router.jsonl`)와 같다. `note`에 `hs-orchestrator`가 들어가 구분되고 `HS_ORC_DECISION_LOG`로 분리 가능하다.

## 8. 환경 함정

- **작업 디렉터리가 iCloud Drive 안이고 경로에 공백이 있다.** 셸에서 반드시 인용한다.
- **`node_modules`는 심볼릭 링크다**(`node_modules -> node_modules.nosync`). `.gitignore`와 `eslint.config.js`가 둘 다 `node_modules.nosync`를 무시하도록 이미 고쳐 뒀다 — **이름을 또 바꾸면 lint가 의존성을 통째로 훑어 게이트가 깨진다**(실측).
- **`codex`는 stdin이 TTY가 아니면 무기한 블록한다.** 어댑터는 `stdio[0]='ignore'`로 닫는다. 셸에서 직접 부를 땐 `< /dev/null`.
- **`codex`에는 `--output-format`이 없다** — `--json`이다. 스키마도 claude/cursor 계열과 완전히 다르다.
- **`codex -m`은 없는 모델 id를 거부하지 않는다** — 경고만 내고 fallback metadata로 실행한다. `claude --model`은 즉시 거부한다.
- **`cursor-agent`는 `--trust` 없이는 Workspace Trust 프롬프트에서 막힌다.**
- **`cursor-cli` 바이너리는 없다.** `cursor-agent`가 실체이고 폴백이 이미 구현돼 있다.
- **Ink `useInput`은 비-TTY에서 화면을 통째로 죽인다.** `isRawModeSupported`가 파이프에서 `false`가 아니라 `undefined`라 가드가 안 된다 — `process.stdin.isTTY`를 직접 본다. TUI를 파이프로 확인할 땐 `--screen <이름>`.
- **테스트에서 `pgrep -f "<패턴>"`을 쓰지 말 것** — 검사 셸 자신의 커맨드라인이 패턴에 걸려 자기를 센다(실측으로 초록 거짓말이 날 뻔했다). pid를 직접 추적한다.
- **`execFileSync`는 성공 시 stderr를 돌려주지 않는다** — "조용히 끝났다"를 확인할 수 없다. `spawnSync`를 쓴다.
- Electron 드라이브는 `webContents.executeJavaScript`로 한다. React 입력에 값을 넣으려면 네이티브 setter 호출 후 `input` 이벤트를 디스패치해야 한다.
- 현재 떠 있는 서버·프로세스 **없음**.

## 9. 새 세션이 먼저 읽을 것

1. `docs/PLAN.md` — 단계별 완료 판정과 실측 기록. 맨 뒤 "v1 릴리스 게이트"에 무엇이 충족됐고 무엇이 남았는지 있다.
2. `docs/SPEC.md` — 구현의 주 참조. §0.1(함정 7가지)·§3(어댑터)·§4(파이프라인)·§5(증거)·§8(결정 로그)
3. `docs/DECISIONS.md` — D-001~D-023. **D-019(JSX/빌드 금지)가 §6에 직접 걸린다.**
4. `src/shell/cli.ts` — 진입점이 감쌀 대상. 인자 파싱과 모드 분기가 전부 여기 있다.
5. `src/data/matrix.ts` / `src/core/run-store.ts` — 경로 해석이 **설치 기준 vs cwd 기준**으로 갈리는 두 예.

적용할 규칙: `~/.claude/CLAUDE.md`, `~/.claude/rules/hs-00-core.md`(게이트는 마지막 1회, 새 방식 도입 시 구 방식 제거까지가 한 작업, 조용한 폴백 금지), `~/.claude/rules/hs-engineering.md`(exact 버전 핀, 순수 로직엔 반드시 단위 테스트).

---

## 인계 종결

사유: 수행함 — §6 진입점을 만들고 저장소 바깥에서 실측으로 닫았다 (커밋 `365db3f`, 브랜치 `claude/elastic-ishizaka-2a00e1`).

- **한 것**: `bin/hs-orc.mjs`(package.json `bin`) + `src/shell/__tests__/bin.test.ts` 4건. `npm run tui|gui|build:gui` 를 같은 래퍼로 모아 실행 경로를 하나로 줄였다. `docs/DECISIONS.md` D-024, `docs/PLAN.md` S8 기록. 게이트 **173 pass / 0 fail**(pre-commit 훅에서 재확인).
- **실측**: `/tmp` 빈 git repo에서 임시 PATH 심볼릭 링크로 `hs-orc "broken.ts 의 타입 에러를 고쳐라" --run` → R01 분류 → Luna(codex) 65.6s → Haiku(claude) 독립 검증 `FAIL` → 그 디렉터리에 `.hs-orc/runs/0921-0107-df6/{01-Luna,02-Haiku}.*` 생성. 결정 로그 2줄(`pending` → `unverified`).
- **남은 것 (사용자 결정 대기)**: `main` 머지와 `~/.local/bin/hs-orc` 실설치. 머지 전에 링크를 걸면 워크트리가 지워질 때 끊기므로 **묻고 멈췄다**(사용자가 그 질문을 취소함). 그 외 남은 것은 실사용 1건 · 비용 실비화 · README.

**다음 세션이 알아야 할 함정**

- 이 워크트리에는 `node_modules` 가 없어서 메인 체크아웃의 `node_modules.nosync` 로 심볼릭 링크를 직접 걸었다. 새 워크트리마다 같은 조치가 필요하다(`npm ci` 는 링크를 지운다).
- **codex 슬롯이 read-only 샌드박스로 뜬다.** 실측에서 Luna 가 파일을 못 고치고 "수정안"만 냈고 reviewer 가 그것을 FAIL 로 잡았다 — 두 슬롯 설계는 의도대로 작동했지만 **primary 에 쓰기 권한을 주는 방법이 SPEC 에 없다.** 실사용 1건보다 이것이 먼저다.
- `package.json` 의 `engines.node: ">=22.6"` 은 **플래그 없는 타입 스트리핑 기준으로는 부정확하다**(22.6~22.17 은 `--experimental-strip-types` 가 필요하다). 진입점은 버전 대신 `process.features.typescript` 로 판정하므로 동작은 안전하지만, `engines` 는 언젠가 정정해야 한다.
- 진입점 테스트는 반드시 저장소 **바깥** 디렉터리를 cwd 로 잡는다. 저장소 안에서 돌리면 cwd 기준 경로와 설치 위치 기준 경로가 우연히 같아져 초록 거짓말이 난다.
