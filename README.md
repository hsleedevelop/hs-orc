# hs-orchestrator (`hs-orc`)

작업 한 건을 **분류 → 두 슬롯 배정 → 하한선 검사 → 실제 CLI 엔진 실행 → 증거로 종료**까지 밀어붙이는 로컬 오케스트레이터.

「GPT-5.6 × Claude 실무 사용 매트릭스 v6」(11행)을 실행 가능한 라우터로 바꾼 것이다. 자체 LLM API를 부르지 않는다 — **설치된 CLI(`claude` / `codex` / `cursor-agent`)를 그대로 띄운다.**

```
$ hs-orc "이 타입 에러 고쳐줘"
업무   R01 짧은 구현 / 타입 수정  (키워드 타입 에러, 타입 (점수 7))
배정   primary  Luna · medium  → codex / gpt-5.6-luna
       reviewer Haiku · low  → claude / claude-haiku-4-5-20251001
기준   빠르게 수정하고 기존 test만 실행
비용   $0.39 = primary $0.18 + reviewer $0.21  [INDEPENDENT]
       Artificial Analysis max-effort 벤치마크 작업당 비용. 실제 지출이 아니다.
쓰기   꺼짐 — 두 슬롯 다 읽기 전용이다. 파일을 고치게 하려면 --write 다.
제시만 했다. 실제 실행은 --run 이다 (승인 게이트).
```

## 왜 두 슬롯인가

매트릭스 11행은 전부 `primary + independent reviewer` 쌍이다. 배정만 두 슬롯으로 하고 실행은 primary만 하면 **이 제품은 단일 엔진 선택기로 축소된다.** 그래서 기본 경로가 두 슬롯을 다 띄운다.

- **INV-1 교차 벤더** — primary와 reviewer는 항상 다른 벤더다(OpenAI ↔ Anthropic). 같은 벤더 쌍은 타입 수준에서 만들어지지 않는다.
- **reviewer는 작업을 다시 하지 않는다** — primary 산출물의 누락·반례를 찾고 운영 기준 충족 여부를 `PASS`/`FAIL` 한 단어로 판정한다.
- **reviewer는 어떤 경우에도 파일을 못 고친다.** 판정 대상을 스스로 고칠 수 있으면 독립 검증이 아니다.

## 설치

Node **22.18+** 또는 **23.6+** 가 필요하다 — `.ts`를 빌드 없이 그대로 실행하므로 타입 스트리핑이 기본 활성이어야 한다. 그보다 낮으면 `NODE_OPTIONS=--experimental-strip-types`를 준다.

```bash
git clone https://github.com/hsleedevelop/hs-orc.git
cd hs-orc
npm install
npm link            # 또는: ln -s "$PWD/bin/hs-orc.mjs" ~/.local/bin/hs-orc
```

엔진은 쓰려는 것만 있으면 된다: [`claude`](https://claude.com/claude-code) · `codex` · `cursor-agent`.

## 쓰는 법

```bash
hs-orc "<작업>"                      # 배정·비용 제시까지. 여기서 멈춘다
hs-orc "<작업>" --run                # 두 슬롯 실행 (읽기 전용)
hs-orc "<작업>" --write --run        # primary 가 파일을 고칠 수 있다
hs-orc tui "<작업>"                  # TUI
hs-orc gui                           # GUI (Electron)
hs-orc --help
```

**승인 게이트가 둘이다.** `--run`은 비용 승인, `--write`는 쓰기 승인 — 다른 결정이라 끼워 팔지 않는다. 둘 다 실행 **전에** 화면에 찍힌다.

주요 옵션:

| 옵션 | 뜻 |
|---|---|
| `--task R01`…`R11` | 분류를 건너뛰고 행을 직접 지정 |
| `--effort` / `--reviewer-effort` | 슬롯별 effort (`low`…`max`) |
| `--gate <항목>` | §1 하한선. 걸리면 **엔진을 아예 띄우지 않는다** |
| `--mode pingpong\|loop\|graph` | 진행 방식 (기본 `once`) |
| `--verify "[phase:]<명령>"` | 증거로 쓸 명령. exit code를 받는다 |
| `--no-classify-llm` | 규칙이 빗나갔을 때의 LLM 분류 폴백을 끈다 |
| `--no-reviewer` | reviewer 생략 (끈 것이지 통과가 아니다) |

그래프 모드는 커밋된 예제가 있다:

```bash
hs-orc "<작업>" --mode graph --graph examples/graph-nodes.json --run
```

## 증거 없이는 완료가 아니다

`"성공했습니다"`는 증거가 아니다. 행마다 요구 증거가 정해져 있고, 그것이 모였을 때만 `outcome: ok`로 닫힌다. 안 모이면 `unverified`로 남는다 — 실패가 아니라 **아직 모른다**는 뜻이다.

증거로 인정하는 것은 실제로 돌린 명령의 **exit code**, git이 보고한 **변경 파일**, reviewer의 **판정**, 그리고 사람이 적어 주는 `--evidence <file.json>`이다. exit code 없는 명령, `file:line` 아닌 인용, 환경 표기 없는 측정값은 거절한다.

**프로젝트마다 검증 명령을 선언해야 한다.** `data/verify.json`이 비어 있으면 무엇을 해도 `unverified`로 닫힌다 — 제품 결함이 아니라 선언 부재다.

```json
{ "default": [], "R01": ["npm test"], "R04": ["npm run gate"] }
```

## 산출물이 어디 쌓이는가

경로 기준이 두 가지로 갈리고, 그게 의도다.

| 대상 | 기준 |
|---|---|
| `data/*.json` (매트릭스·엔진·상한·검증 선언) | **설치 위치** — 어디서 부르든 같은 매트릭스 |
| `.hs-orc/runs/<id>/` (원시 stdout·stderr·meta) | **부른 디렉터리** — 산출물은 작업 중인 프로젝트에 |
| 결정 로그 | `~/.claude/logs/delegation-router.jsonl` (`HS_ORC_DECISION_LOG`로 분리 가능) |

결정 로그는 작업 1건당 **두 줄**이다: 배정을 확정한 시점의 `pending`, 그리고 같은 id로 append하는 결과. 갱신이 아니라 append라 1차 줄이 그대로 남는다.

## 비용 표기를 믿는 법

실행 **전에** 항상 비용을 보여준다. 다만 그 숫자의 출처가 셋이고, **섞이면 섞였다고 적는다.**

| 출처 | 뜻 | 누적 표시 |
|---|---|---|
| `actual` | 엔진이 돌려준 값 (`claude`의 `total_cost_usd`) | 실측 |
| `metered` | 측정 토큰 × **선언 단가** — 벤더 청구액이 아니다 | 토큰×선언단가 |
| `estimate` | AA 벤치마크 작업당 비용 | 추정 |

`codex`·`cursor`는 토큰만 주므로 기본은 `estimate`다. `data/pricing.json`에 단가를 적으면 그 모델이 `metered`로 바뀐다 — **저장소 기본값은 비어 있다. 제품은 단가를 추측하지 않는다.**

```json
{ "models": { "gpt-5.6-luna": { "inputPerMTok": 0.25, "outputPerMTok": 2 } } }
```

기본 상한은 $20이고 넘으면 다음 슬롯을 시작하지 않는다.

## 알려진 한계

- **분류는 결정적이지 않다.** 규칙 표가 빗나가면 Haiku·low가 분류만 재시도하는데(+$0.001 내외, 돌 때마다 표기한다), 같은 문장이 실행마다 다른 행으로 갈 수 있다. 승인 게이트가 마지막 방어선이다.
- **비용은 단가를 선언하기 전까지 추정이다** (위 참조).
- **`--mode graph`는 [`examples/graph-nodes.json`](examples/graph-nodes.json)을 보면 된다.** 그 파일이 실제로 파싱되는지는 테스트가 고정한다.
- **primary는 워크스페이스 안에서만 쓴다.** `codex -s workspace-write` / `claude --permission-mode acceptEdits` / `cursor-agent --force`를 쓰고, 그보다 넓게 여는 값(`danger-full-access`·`bypassPermissions`)은 선언하지 않는다.

## 개발

```bash
npm run gate        # matrix:check → type-check → lint → test (201 tests)
npm run gen:matrix  # data/matrix-source.html → data/matrix.json 재생성
```

`data/matrix.json`은 **생성물이다.** 진실은 `data/matrix-source.html`이고, 수기 편집하면 `matrix:check`가 게이트 첫 단계에서 막는다. 행을 늘리려면 원본 HTML을 고치고 재생성한다.

설계 문서: [`docs/PRD.md`](docs/PRD.md) · [`docs/SPEC.md`](docs/SPEC.md) · [`docs/PLAN.md`](docs/PLAN.md) · [`docs/DECISIONS.md`](docs/DECISIONS.md)(D-001~D-027, 기각한 대안과 이유 포함).

## 라이선스

[MIT](LICENSE)
