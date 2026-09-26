# Handoff: resume-measurement
- from: local_dda0e959-8976-4ed3-93cf-67b56411d87f ("Plan CLI·TUI conversation session (D-031 #8)") · cwd: /Users/hsonpro/Library/Mobile Documents/com~apple~CloudDocs/shared_workspace/hs-orc/.claude/worktrees/determined-clarke-e2c243 · branch: claude/chat-minors (머지됨·원격 삭제, HEAD 998e49a = origin/main 01e60f2 와 같은 트리) · 2026-09-26T09:00+0900 · model: claude-opus-5-5 · 형식: full · 전달: B task_5523fe90 · 종결: 2026-09-26 practical-carson-cd5f83

## 1. 목표
PLAN S10 후속 "다른 cwd resume, resume 중 모델 변경, 긴 세션 압축 — 미실측" 을 실측으로 닫는다 (D-031 결정 4 · Q10 실측이 "보장하지 않는" 세 경계).
범위: 먼저 무료로 필요성 판단 → 실측 계획(명령·예상 토큰·상한) 제시·승인 → 실측 → 결과를 DECISIONS/PLAN 에 기록(필요하면 결정 D-057).
제외: cursor 실측(2026-09-24 사용자 결정으로 보류 — 구독 사용량), TUI 대화 화면, delegate 실패 시 배정 보존.

## 2. 현재 상태
- 완료(이 세션, 모두 main 머지): #39 D-056 CLI `hs-orc chat`(세션 조립 공용화 src/shell/conversation.ts · REPL src/shell/chat.ts · chat-main.ts · bin `chat`) · #40 chat Minor 3건 + PLAN 에 직접 답 비용 6배 원인(캐시 상태 추론) 기록.
- 진행 중: 없음.
- 미착수: resume 실측 전부. 관련 코드는 읽지 않았다(위치만 확인, §9).

## 3. 결정과 기각한 대안
- 이 주제의 결정 없음. 전제(확정):
  - D-031 결정 4: 맥락의 진실은 orc 의 기록. resume 은 **같은 슬롯(엔진·모델·effort)·같은 세션 폴더** 후속에만 최적화로 쓴다.
  - 현 코드 `ConversationSession.resumable()`(src/core/session.ts): 가장 최근 위임이 성공 + engineSession 이 있고 primary 의 engine·modelId·effort 가 모두 같을 때만. 세션 폴더는 늘 같다. 쓰기 켜고 `resume.write === false`(codex)면 잇지 않는다. reviewer 는 resume 하지 않는다. resume 실패는 새 실행으로 조용히 바꾸지 않는다.
  - 즉 "다른 cwd"·"모델 변경" 은 **정책이 이미 막는다** — 실측의 가치는 (a) 가드가 정말 필요한지 확인(완화 여지), (b) 막히지 않는 "긴 세션 압축" 에서 맥락이 어떻게 되는지다. 첫 단계에서 이 판단을 전하께 먼저 보고할 것.
  - codex `exec resume` 은 `-s` 를 받지 않는다 → write+resume 불가 선언(engines.json $evidence.resume, D-051 로 읽기 전용은 `-c sandbox_mode="read-only"`).

## 4. 건드린 파일
- 이번 인계 대상은 아직 없음.
- 미커밋 diff: 없음(git status --short 비어 있음). stash 없음.

## 5. 검증 상태
- 실행: `npm run gate` → 408 PASS (#40 머지 직전 트리). #39·#40 CI gate PASS.
- 실행: 2026-09-26 `hs-orc chat --scratch` 실제 직접 답 1회 → 기록·누적 `--resume` 복원 확인 ($0.0642 API 환산, 토큰 31,519).
- 미검증: resume 세 경계 전부. 비용 6배 원인(캐시 1h 쓰기)도 산술 추론일 뿐 usage 내역으로 확인하지 않았다. 실제 TTY 에서 위임 중 Ctrl-C.

## 6. 다음 한 걸음
무료 조사부터: docs/DECISIONS.md D-031 의 "Q10 실측" 절과 SPEC §3.8, src/core/session.ts `resumable()`, src/adapters/resolve.ts(120~170행 resume argv)를 읽고, 세 경계 각각에 대해 "현 코드가 그 경계에 도달할 수 있는가 / 실측 결과가 코드·정책을 바꿀 수 있는가" 를 표로 정리해 전하께 보고 → 실측할 항목만 골라 계획(엔진별 명령·예상 토큰·상한·스크래치 폴더) 제시 후 AskUserQuestion 으로 승인.
- 그 다음: 승인된 실측 실행(claude·codex, 무작위 코드워드 방식 — Q10 과 같은 방법) → 결과를 D-031 Q10 절 또는 새 결정으로 기록 → PLAN S10 후속 줄 갱신 → PR.

## 7. 사용자에게 열린 질문 / 블로커
참고: 실측(엔진 실행)은 매번 계획 제시 후 승인. cursor 는 보류 유지(명시 해제 전 실행 금지).

## 8. 환경 함정
- 저장소 경로에 공백(iCloud) — 항상 따옴표. 새 워크트리는 node_modules → ".../hs-orc/node_modules.nosync" 심링크 필요(ln -s).
- zsh: "====" 구분자가 명령을 죽인다(이번 세션에서도 재현). glob 인자는 따옴표.
- PR 머지: `gh pr merge` 는 auto-mode 분류기가 [Merge Without Review] 로 막는다 — 우회하지 말고 `gh pr merge <N> --squash` 명령을 전하께 건넨다(프로젝트 메모리 pr-merge-by-user). 원격 브랜치 삭제는 이번에 통과했다.
- 브랜치는 머지마다 origin/main 에서 새로 딴다(squash). 커밋: 한국어 conventional + Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>, PR 본문 끝 🤖 Generated with [Claude Code](https://claude.com/claude-code). pre-commit 훅이 gitleaks·gate(약 5초).
- 비용 해석: 격리 Haiku 직접 답은 캐시 상태에 따라 $0.01~$0.064(첫 호출 1h 캐시 쓰기 추정). 실측 예산을 잡을 때 첫 호출은 비싸게 잡는다. claude 는 구독제라 청구되지 않고 API 환산만 찍힌다.
- codex 는 세션 목록을 cwd 로 거른다(`resume --all` 이 끈다) — "다른 cwd" 실측의 핵심. 실측은 스크래치(git 아님)에서 하면 codex 에 `--skip-git-repo-check` 필요.
- stash 는 공유 — 태그 붙여 push, sha 로 apply.

## 9. 새 세션이 먼저 읽을 것
- docs/DECISIONS.md — D-031 (651행~, "Q10 실측" 표·"보장하지 않는 것" 문단)
- docs/SPEC.md §3.8 세션 resume (256행~)
- src/core/session.ts (`resumable()`, `approve()`)
- src/adapters/resolve.ts (resume argv·쓰기 가드)
- data/engines.json (`$evidence.resume`, 각 엔진 `resume` 선언)

## 인계 종결
사유: 수행함
- 한 것: 무료 조사로 세 경계 판정 → 사용자 승인 A(다른 cwd·없는 id)만 실측 → D-031 "Q10 후속 실측"·Q14·SPEC §3.8·PLAN·engines.json 기록 → PR #41 (gate 408 PASS, CI pending). 두 엔진 모두 모르는 id 에 exit 1, 다른 cwd 에서도 id 로 회수.
- 발견: resume 한 실행의 비용 보고가 세션 누적(claude total_cost_usd·modelUsage, codex turn.completed.usage) → Budget 이 앞 턴을 다시 센다 = Q14 (미수정).
- 남은 것(사용자 결정): PR #41 머지(`gh pr merge 41 --squash`), Q14 수정(권장: engineSession 에 직전 누적값 저장 후 차감, D-057), 압축 싼 탐색 B(claude -p --resume "/compact", 승인 필요). 모델 변경은 가드로 닿지 않아 미실측 유지.
- 함정: codex resume 은 session 로그의 last_token_usage 만 이번 턴 몫 — stdout 에는 없다. claude 는 result.usage 가 이번 턴 몫이라 토큰은 맞고 비용만 누적이다.
