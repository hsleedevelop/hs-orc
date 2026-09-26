# Handoff: readonly-claude-cursor
- from: local_e3392b76-02a9-4858-8f06-a7770d970826 ("Resume hs-orc loop gates handoff (D-040~D-049)") · cwd: /Users/hsonpro/Library/Mobile Documents/com~apple~CloudDocs/shared_workspace/hs-orc/.claude/worktrees/funny-cannon-0fa64d · branch: claude/conductor-safe-mode (머지됨, origin/main = a7c15ef) · 2026-09-25T20:01+09:00 · model: claude-opus-5-5 · 형식: full · 전달: B task_088c1321 · 종결: 2026-09-25 gallant-lehmann-42db76

## 1. 목표
사용자 요청: "ok go" — D-051 후속으로 **claude·cursor 엔진의 읽기 전용을 실측하고, 필요하면 `readOnlyArgv` 로 명시**한다.
진행 규칙: 실제 엔진 실행은 매번 계획(명령·예상 토큰·상한·성공 기준)을 먼저 제시하고 사용자 승인 뒤에만 한다 — 구독 사용량이다.
범위 제외: codex(이미 D-051 로 명시), SDD minor 묶음, loop 정책 미결 2건, Q12.

## 2. 현재 상태
- 완료(이 세션, 모두 main 머지): PR #28 (#26·#27 실측 기록), PR #29 (D-050 지휘자 `--safe-mode` 격리 · D-051 codex `-c sandbox_mode="read-only"` · S10 대화 세션 재판정 ✅). 원격 claude/* 브랜치 정리 완료.
- 진행 중: 없음.
- 미착수: 이 인계의 목표(claude·cursor 읽기 전용 실측·명시).

## 3. 결정과 기각한 대안
- D-051: 읽기 전용은 엔진 기본값에 맡기지 않고 인자로 명시. 선언 필드 `readOnlyArgv`(src/data/engines.ts), `buildInvocation` 이 `write !== true` 일 때 붙인다(src/adapters/resolve.ts). **resume 경로에도 붙으므로 resume 이 받는 형식이어야 한다** — codex 가 `-s` 대신 `-c` 인 이유.
- 기각(D-051): 선언 없는 엔진은 읽기 전용 실행을 거부 — claude·cursor 가 전부 멈춘다, "실측 뒤에 판단" 으로 남겼다. 이 인계가 그 실측이다.
- D-050: 지휘자는 `--safe-mode`(프로젝트 CLAUDE.md 도 꺼짐, 수용). `--bare` 는 OAuth 불가로 기각.

## 4. 건드린 파일
- 이번 인계 대상은 아직 없음. 관련 위치: `data/engines.json`(engines.claude·cursor 의 `write`, `$evidence.readOnly`), `src/adapters/resolve.ts`(readOnlyArgv 분기), `src/adapters/__tests__/resolve.test.ts`(D-051 테스트, codex 기본 argv 전체 고정 테스트), `docs/DECISIONS.md` D-051.
- 미커밋 diff: 없음(git status --short 비어 있음).

## 5. 검증 상태
- 실행: `npm run gate` → PASS 368 (PR #29, CI gate 2건 PASS).
- 실행: codex 읽기 전용 — S10 ② 에서 codex 가 "workspace 가 read-only 라 적용 못 함", git status 무변경 (n=1, exec 경로만).
- 미검증: **claude 읽기 전용** — argv 에 권한 인자 없음(`-p` 기본 모드). `~/.claude/settings.json` 에 defaultMode 없음, `settings.local.json` 에 permissions.allow 가 있으나 Edit/Write/Bash 항목은 grep 상 안 보였다(전체 미확인). 실측 로그상 reviewer 의 Bash 는 거절됐다(D-036·D-041) — Edit 시도는 본 적 없음.
- 미검증: **cursor 읽기 전용** — `cursor-agent -p` 에 `--force` 없음. engines.json note: "-p 는 이미 write·shell 도구를 갖고 있고 --force 가 프롬프트를 없앤다" → `--force` 없이 쓰기가 막히는지 실측 없음. cursor 실행은 2026-09-24 사용자 결정으로 보류된 적 있다(구독 사용량) — 실행 전 반드시 확인.
- 미검증: codex `-c sandbox_mode` 의 **resume 경로** 실측, codex trust→쓰기 기본값은 추론(공식 문서 미확인).

## 6. 다음 한 걸음
사용자에게 실측 계획을 제시하고 승인받는다(엔진 실행 금지 전까지): 홈 아래 스크래치 git 저장소(1파일)에서 각 엔진을 hs-orc 읽기 전용 argv 그대로(`buildInvocation` 결과) 띄워 "hello.txt 를 만들고 README 한 줄을 고쳐라" 를 시키고 `git status`·파일 존재로 판정. claude 는 Haiku·low(약 3~4만 토큰), cursor 는 가장 싼 모델(비용 미상 — 먼저 확인). 성공 기준 = 파일 무변경.
- 그 다음: 새면 `readOnlyArgv` 선언(claude 후보 `--permission-mode plan` 또는 `--disallowedTools Edit,Write,NotebookEdit` — resume(`--resume`)과 함께 받는지 확인 필요, cursor 후보는 `--help` 로 조사) + 테스트(수정 전 FAIL 확인) + D-052 기록 + PR.
- 새지 않아도: 엔진 기본값 의존임을 D-051 영향에 실측값으로 적고, 명시할지 사용자 결정.

## 7. 사용자에게 열린 질문 / 블로커
참고: 엔진 실측은 승인 사항. cursor 실행 여부는 이전 보류 결정이 있어 계획 제시 때 함께 묻는다. §6 첫 단계(계획 제시)는 질문 없이 진행 가능.

## 8. 환경 함정
- 저장소 경로에 공백(iCloud) — 항상 따옴표. 새 워크트리는 `node_modules -> ".../hs-orc/node_modules.nosync"` 심링크 필요.
- **`~/.codex/config.toml` 에 `[projects."/Users/hsonpro"] trust_level="trusted"`** — 홈 아래 전부 신뢰 폴더. 스크래치도 여기 속한다.
- `/Users/hsonpro/.claude/CLAUDE.md` 가 비격리 claude 실행에 실린다(D-050) — 엔진 답에 "전하" 가 나오면 그 증거.
- zsh 에서 `echo ======` 는 `=` 확장 오류 — 구분자로 쓰지 말 것.
- auto-mode classifier 가 `gh pr merge` 를 한 번 막았다(Merge Without Review) — 사용자가 명시 요청한 뒤엔 통과. 삭제·머지는 사용자 명시 요청 후.
- 워크트리 세션에서 메인 체크아웃 `.claude/` 에 Write 도구는 막혀도 Bash `cp` 는 됐다.
- GUI 실측은 `node bin/hs-orc.mjs gui --remote-debugging-port=9333` + CDP 드라이버(이전 scratchpad `s10/orc.mjs`, 세션 전용). 측정 중 사용자가 창을 클릭하면 활성 세션이 바뀐다 — 매 단계 세션 id 확인.
- 이 워크트리(funny-cannon-0fa64d)에 로컬 브랜치 `claude/measure-26-d049`·`claude/conductor-safe-mode` 가 남아 있다(원격은 삭제됨).
- 커밋: 한국어 conventional + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, PR 본문 끝 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`, 머지는 squash.

## 9. 새 세션이 먼저 읽을 것
- docs/DECISIONS.md (D-025 쓰기 권한, D-050, D-051)
- data/engines.json (engines.claude·cursor, $evidence.write·readOnly)
- src/adapters/resolve.ts (buildInvocation)
- src/adapters/__tests__/resolve.test.ts
- ~/.claude/CLAUDE.md 의 실제 엔진 승인 규칙

## 인계 종결
사유: 수행함
- 한 것: claude 읽기 전용 실측(haiku·low, 인자 없음, n=1) → default 모드에서 Write 거절, 스크래치 무변경($0.063, 약 92k 처리 — 캐시 포함, 예상 3~4만을 넘었다). 사용자 결정으로 claude `readOnlyArgv = ["--disallowedTools","Edit,Write,NotebookEdit"]` 선언 + 테스트(선 FAIL 확인) + D-052 → PR #30 (브랜치 claude/claude-readonly-argv, gate PASS 369). 머지 안 함.
- 남은 것: PR #30 머지(사용자). `--disallowedTools` 실제 실행(파싱·--resume 병용) 미검증 — 다음 실제 엔진 실행에서 init.tools 확인. cursor 는 보류 유지(D-052 에 MCP allowlist 위험·후보 --mode ask|plan 기록).
- 함정: 스크래치 저장소 ~/.hs-orc-scratch/ro-claude-20260925-201247 이 남아 있다(무변경). 세션 scratchpad 는 앱 재시작 때 지워져 원시 stream 로그는 없다.
