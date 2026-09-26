# Handoff: cli-tui-conversation-session
- from: local_2b7d6cf5-5e40-4c16-891f-db56d60abed8 ("Decide SPEC 8 rolling-summary criterion") · cwd: /Users/hsonpro/Library/Mobile Documents/com~apple~CloudDocs/shared_workspace/hs-orc/.claude/worktrees/goofy-matsumoto-c55dc2 · branch: claude/nongit-project-codex-readonly (= origin/main db5510f, 머지됨) · 2026-09-26T01:15+0900 · model: claude-opus-5-5 · 형식: full · 전달: B task_1ee53e53 · 종결: 2026-09-26 determined-clarke-e2c243

## 1. 목표
PLAN S10 후속의 마지막 항목: "GuiService 는 활성 세션 하나. CLI·TUI 는 아직 `ConversationSession` 을 쓰지 않는다 (D-031 결정 8)". D-031 결정 8 원문: "Core 에 헤드리스 `ConversationSession` 을 둔다 (D-001). 첫 셸은 GUI, CLI·TUI 는 뒤따른다."
이번 인계의 범위: **계획 수립까지** — 무엇을 CLI·TUI 에 붙일지(범위·UX·기존 --mode pingpong 과의 관계) 사용자 결정을 받고 계획 문서를 쓴다. 구현은 계획 승인 뒤.
범위 제외: GuiService 다중 세션, cursor 읽기 전용 실측(D-052 보류 유지).

## 2. 현재 상태
- 완료(이 세션, 모두 main 머지): #35 D-053 맥락 잘림 기록(SPEC 미해결 8 닫음) · #36 journal 실행 줄에 primary charge(GUI·TUI) · #37 D-054 세션 Budget 을 기록의 `spend` 줄로 영속 · #38 D-055 git 아닌 project 의 codex 읽기 전용 위임.
- 진행 중: 없음.
- 미착수: CLI·TUI 대화 세션 전부. 코드 한 줄도 안 읽었다(파일 크기만 확인: cli.ts 649줄, tui/app.ts 241줄, core/session.ts 392줄).

## 3. 결정과 기각한 대안
- 이 주제의 결정 없음. 전제(이미 확정):
  - `ConversationSession`(core/session.ts)은 헤드리스 — deps: matrix·catalog·kind·dir·id·budget·journal·conduct·executorFor·context?. GUI 는 `GuiService.attach()`(src/shell/gui/service.ts) 가 조립한다: 지휘자는 isolate(D-032 B1·D-050), 위임은 사용자 설정 그대로, nonGit 은 `skipGitCheck`(D-055), 세션 Budget 은 기록 `spend` 재생(D-054).
  - D-033: 대화 세션은 LLM 분류 폴백 대신 지휘자 SUGGEST. **CLI·TUI 는 대화 맥락이 없어 D-026 폴백(기본 켜짐)을 그대로 쓴다** — 대화 세션을 붙이면 이 규칙을 다시 봐야 한다.
  - 2026-09-25 사용자 결정: CLI·TUI 승인 거절은 결정 로그에 옮기지 않는다(기록할 거절 행위가 없음). 대화 세션을 붙여 거절 행위가 생기면 재검토 대상.
  - D-015/D-031 결정 6: `/pingpong` 이 GUI 의 기본 진행, 배정은 턴마다. CLI 에는 `--mode pingpong`(core/modes/pingpong.ts, 세션 고정 배정·resume 없음)이 따로 있다.

## 4. 건드린 파일
- 이번 인계 대상은 아직 없음.
- 미커밋 diff: 없음(git status --short 비어 있음).

## 5. 검증 상태
- 실행: `npm run gate` → PASS 380 (#38 커밋 직전, main db5510f 와 동일 트리). #38 CI 2개 PASS.
- 미검증: 이 세션의 D-054·D-055 는 실제 Electron·실제 codex 로 돌려 보지 않았다(단위 테스트만). CLI·TUI 대화 세션 관련은 아무것도 확인 안 함.

## 6. 다음 한 걸음
코드 조사부터(엔진 비용 0): src/shell/cli.ts 의 --mode pingpong 경로·src/shell/tui/app.ts·src/core/modes/pingpong.ts 를 읽고 `ConversationSession` 과 겹치는 것/다른 것(배정 고정 vs 턴마다, resume, 기록 jsonl, 승인 UX)을 표로 정리 → 선택지(예: A CLI 에 `--chat` REPL 추가 · B TUI 에 세션 화면 추가 · C pingpong 을 ConversationSession 으로 대체 · D 둘 다)와 규모·위험을 AskUserQuestion 으로 제시해 결정받는다.
- 그 다음: 결정을 D-056 으로 기록 → docs/superpowers/plans/ 에 계획 문서(작은 end-to-end 단위부터) → 사용자 승인 뒤 구현.

## 7. 사용자에게 열린 질문 / 블로커
참고: 범위 결정은 §6 첫 단계 조사 뒤 묻는다(조사 자체는 질문 없이 진행). 실제 엔진 실행은 매번 계획(명령·예상 토큰·상한) 제시 후 승인.

## 8. 환경 함정
- 저장소 경로에 공백(iCloud) — 항상 따옴표. 새 워크트리는 node_modules → ".../hs-orc/node_modules.nosync" 심링크 필요(ln -s).
- iCloud 충돌 사본: 이 세션에서 `.git/refs/heads/main 2`·`.git/refs/remotes/origin/main 2` 를 지웠다(git fetch "bad object" 원인). `.git/index 2` 와 워크트리 3곳(awesome-bell·peaceful-goldstine·strange-cori)의 `index 2` 는 남아 있다(무해, 사용자 미요청). fetch 가 다시 "bad object … 2" 를 내면 같은 원인 — 가리키는 커밋이 origin/main 의 조상인지 확인 후 지운다.
- 머지: 사용자가 "머지해줘" 로 명시해야 auto-mode 분류기가 통과. squash 머지, 브랜치는 머지마다 origin/main 에서 새로 딴다(squash 뒤 옛 브랜치 재사용 불가).
- 커밋: 한국어 conventional + Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>, PR 본문 끝 🤖 Generated with [Claude Code](https://claude.com/claude-code). pre-commit 훅이 gitleaks·gate(약 5초).
- stash 는 공유 — 태그 붙여 push, sha 로 apply, 태그로 찾아 drop.
- zsh: "====" 구분자 금지, timeout 명령 없음, `--include=*.ts` 같은 glob 인자는 nomatch 로 죽는다(따옴표로 감쌀 것).

## 9. 새 세션이 먼저 읽을 것
- docs/DECISIONS.md D-031(651~) 결정 8 · D-033 · D-054 · D-055
- src/core/session.ts
- src/shell/gui/service.ts (attach·sessionBudget·skipGitCheck — GUI 조립의 기준)
- src/shell/cli.ts · src/shell/tui/app.ts
- docs/superpowers/plans/2026-09-23-conversation-session.md (GUI 대화 세션 계획 — 형식 참고)

## 인계 종결
사유: 수행함
- 한 것: cli.ts·tui/app.ts·pingpong.ts·session.ts·service.ts 조사 → 사용자 결정(A: CLI `hs-orc chat` 먼저 · pingpong 유지 + 안내) → D-056 기록 + 계획 `docs/superpowers/plans/2026-09-26-cli-chat.md` (Task 1~6). 커밋 8378ced (브랜치 claude/determined-clarke-e2c243, 미푸시, gate PASS 380).
- 남은 것: 사용자 계획 승인·실행 방식 선택 → 구현(Task 1~5) → Task 6 실제 엔진 확인(유료, 승인 후).
- 함정: 조사 중 확인 — CLI `--mode pingpong` 은 1턴 뒤 종료·결정 로그 없음(D-056 표). 새 워크트리는 node_modules 심링크 필요. zsh 에서 "====" 구분자가 명령을 죽인다(이번에도 재현).
