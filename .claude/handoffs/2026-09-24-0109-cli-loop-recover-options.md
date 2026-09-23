# Handoff: cli-loop-recover-options
- from: local_78f112cd-94ef-4ac9-94ff-2a654c664183 · cwd: /Users/hsonpro/Library/Mobile Documents/com~apple~CloudDocs/shared_workspace/hs-orc · branch: main · 2026-09-23T16:09:28Z · model: claude-opus-5-5 · 형식: full · 전달: B task_411e229d

## 1. 목표
사용자 원문: "CLI loop 복구 방식 선택지 정리해줘" — **분석·선택지 제시만** (구현 요청 아님). 사용자가 안을 고르면 이 저장소 관례대로 D-036 결정 기록 → 커밋 → 브랜치에서 구현(서브에이전트) → 리뷰 → 사용자 승인 시 로컬 ff merge.
범위 제외: push, 다른 후속 과제(§6 뒤 목록).

## 2. 현재 상태
- 완료 (이 세션, 모두 main 에 ff merge 됨, push 안 함): v2.1 대화 세션(D-031, PLAN S10 부분 통과) · D-032 codex 캐시 이중계산 수정 + 세션 단위 토큰 예산 + 지휘자 격리 · D-033 세션은 분류 폴백 대신 지휘자 SUGGEST · D-034 분류 폴백 비용을 예산에 과금 · D-035 CLI 모든 진행 방식에 토큰 상한 + `--token-budget`. main HEAD = `3e92dd2`.
- 진행 중: CLI loop 복구 방식 선택지 정리 — 코드 읽기까지 끝, **사용자에게 아직 아무것도 제시하지 않았다.**
- 미착수: 선택지 제시, D-036.

## 3. 결정과 기각한 대안
- 이번 주제는 아직 결정 없음. 지금까지의 사실(코드 읽기):
  - `src/shell/cli.ts` ~268: `recover: () => 'abort'`, `stop: (_ctx, verdict) => verdict.passed`. → 1사이클 PASS 면 goal-reached, FAIL 이면 aborted. **CLI loop 는 사실상 1사이클짜리**다; `maxIterations`(8) 에 닿을 길이 없다.
  - `src/core/modes/loop.ts` ~140: FAIL 시 `recover` → `'abort'` 중단 / `'escalate'` 중단(escalated) / `'retry'` 다음 사이클(Planner 가 다시 고름). recover 미지정 기본은 abort. Core 테스트 "검증에 실패하면 기본은 중단이다" 가 이 기본값을 고정한다 — 설계 선택일 수 있다.
  - CLI Planner 는 2사이클부터 `"<task> — 직전 사이클의 지적을 반영하라"` 만 붙인다. **reviewer 의 FAIL 사유(평가 텍스트)는 다음 프롬프트에 실리지 않는다** → 지금 retry 로 바꾸면 "눈먼 재시도" 가 된다.
  - 추가 발견(미보고): loop.ts 의 Evaluator 과금은 `budget.charge(..., undefined, estimate, undefined, plan)` 이고 `countTokens` 가 없다 — CLI `evaluate` 클로저 안의 reviewer `execute()` 실제 금액·토큰이 버려진다. 토큰 상한(D-035)이 reviewer 몫을 세지 않는다.
  - SPEC §6.2: Recovery = "재시도 / 롤백 / 중단 / 사용자 승인", 규칙 "검증 없이 다음 사이클로 넘어가지 않는다", "최대 반복 수 없이는 구현하지 않는다".
- 초안 선택지 (아직 미제시): L1 abort 유지 + "CLI loop = 검증된 1회 시도" 로 문서화 / L2 retry (maxIterations·토큰 상한까지) / L3 `--recover retry|abort|escalate` 옵션 / L4 retry 시 reviewer FAIL 사유를 다음 Planner 프롬프트에 싣기. 잠정 권장: **L2+L4** (+ Evaluator 실제 비용·토큰 과금 수정은 별도 결함으로 함께 제시).
- 이 세션의 관례적 결정(유지): 결정은 사용자 선택 → DECISIONS 에 D-0xx 기록·커밋(main) → `feat/...` 브랜치 → 서브에이전트 구현(브리프 파일) → 리뷰 서브에이전트 → 사용자 승인 후 `git merge --ff-only`.

## 4. 건드린 파일
- 이번 주제: 없음 (읽기만: `src/shell/cli.ts:255-290`, `src/core/modes/loop.ts:95-175`, `docs/SPEC.md` §6.2).
- 미커밋 diff: 없음 (`git status --short` 빈 출력, stash 없음).

## 5. 검증 상태
- 실행: `npm run gate` (D-035 재리뷰 시점, head 3e92dd2) → PASS 321/321.
- 미검증: §3 의 loop 동작·Evaluator 과금 누락은 **코드 읽기로만** 확인했다 — 테스트나 실행으로 재현하지 않았다. L4 가 품질을 올리는지는 실측 없음.

## 6. 다음 한 걸음
사용자에게 CLI loop 복구 방식 선택지를 제시한다: §3 사실(1사이클 한계, 눈먼 재시도 위험, Evaluator 과금 누락) → L1~L4 표(장점·단점) → 권장 L2+L4 와 Evaluator 과금 수정 → 규모 추정(1사이클 ≈ 34만 토큰, 기본 상한 200만이면 retry 약 5~6회) → 사용자 결정 요청. 구현하지 않는다.
그 다음: 결정되면 D-036 기록·커밋 → 브랜치 구현 → 리뷰 → merge 여부 확인.
나머지 후속(PLAN S10 목록): D-034 리뷰 Minor 2건(metered 경로 테스트 없음, 분류 엔진 실패가 "맞는 행 없음" 으로 표시) · 분류기 후보 luna(codex, 격리 선언 없음) · `.superpowers/sdd/2026-09-23-conversation-session/final-review.md` 의 Minor 목록을 PLAN S10 으로 옮긴 뒤 그 원장 폴더 정리.

## 7. 사용자에게 열린 질문 / 블로커
없음 (§6 은 분석 제시라 질문 없이 진행 가능). 참고: 사용자는 전역 CLAUDE.md 대로 "전하" 호칭·존댓말·결론 먼저를 원한다.

## 8. 환경 함정
- 저장소 경로에 공백이 있다 (iCloud `Mobile Documents/...`) — 항상 따옴표.
- `node_modules` 는 `node_modules.nosync` 로의 symlink. **새 git worktree 에는 deps 가 없어 `npm run gate` 가 안 돈다** → 이 세션은 worktree 대신 같은 체크아웃에서 브랜치를 썼다(ledger Ruling). spawn_task 로 열린 fresh worktree 에서 구현하려면 deps 연결부터 필요.
- 서브에이전트는 scratchpad 에 보고 파일을 못 쓴다(정책 거부) — 보고를 답변으로 받는다.
- 서브에이전트 작업 중 IDE 진단(Cannot find module…)은 중간 상태 잔상이다 — `npm run type-check` 로 확인.
- 실제 엔진 호출(claude/codex/cursor-agent)은 구독 사용량을 쓴다 — 사전 승인 받는다. 테스트는 가짜 바이너리·PATH 가드만.
- 커밋: 한국어 conventional, 제목·빈 줄·본문·빈 줄·`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. pre-commit 이 gitleaks + 전체 gate 를 돈다.
- `src/shell/gui/renderer/bundle.js` 는 gitignore — `npm run build:gui` 로 재생성.
- 남은 산출물(git 무시): `.superpowers/sdd/2026-09-23-conversation-session/` (final-review.md 가 Minor 목록 유일본), `~/.hs-orc/scratch/0923-2155-dce`, 저장소 `.hs-orc/`.
- 켜진 dev server·포트 없음.

## 9. 새 세션이 먼저 읽을 것
- docs/DECISIONS.md (D-030, D-031~D-035)
- docs/SPEC.md §6.2
- src/core/modes/loop.ts
- src/shell/cli.ts (loop 분기, ~255-290)
- docs/PLAN.md S10 절
- 스킬: 분석만이면 없음. 구현 단계에서 superpowers:test-driven-development 관례(RED→GREEN) 유지.
