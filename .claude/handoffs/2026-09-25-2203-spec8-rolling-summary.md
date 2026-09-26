# Handoff: spec8-rolling-summary
- from: local_8dc4d54b-008b-46e3-ab38-274279dd45ed ("Measure claude/cursor read-only enforcement") · cwd: /Users/hsonpro/Library/Mobile Documents/com~apple~CloudDocs/shared_workspace/hs-orc/.claude/worktrees/awesome-bell-f98d29 · branch: claude/gallant-lehmann-42db76 (= origin/main 2a00c25) · 2026-09-25T22:03+0900 · model: claude-opus-5-5 · 형식: full · 전달: B task_25ced028 · 종결: 2026-09-25 goofy-matsumoto-c55dc2

## 1. 목표
사용자 요청: "spec 8 진행해줘" — SPEC 미해결 8 "맥락 자르기(최근 N턴)가 부족할 때 rolling 요약을 열 기준 — 실측 뒤 (§6.4.3)" 를 정한다.
범위 제외: rolling 요약 **구현** 자체(기준이 정해지고 사용자가 열기로 결정한 뒤), cursor 읽기 전용 실측(보류 유지).

## 2. 현재 상태
- 완료(이 세션, 모두 main 머지): #30 claude readOnlyArgv --disallowedTools (D-052), #31 그 실측(exec·resume), #32 SDD minor 5건, #33 loop 미결 2건·CLI/TUI 거절·Q12 닫기, #34 해결된 미결 표시 동기화.
- 진행 중: 없음.
- 미착수: SPEC 8 전부. 아직 코드·문서 한 줄도 안 읽었다(§6.4.3 원문만 확인).

## 3. 결정과 기각한 대안
- 이 주제에 대한 결정 없음. 전제(SPEC §6.4.3): 맥락 = 기록의 user·direct·summary 만, 최근 contextTurns(6) 턴, 끝에서 contextChars(6000) 자. 엔진 원문 미포함. rolling 요약은 "부족하다는 실측이 나오면 연다".
- 관련 확정: primary 는 조건 맞으면 엔진 resume(§3.8) 으로 이어 붙이고 그 이후 대화만 싣는다. reviewer 는 resume 안 한다(D-009 독립).
- #32 에서 limits.json 검사 추가: contextChars 는 2 이상 정수, contextTurns 양의 정수.

## 4. 건드린 파일
- 이번 인계 대상은 아직 없음. 관련 위치: docs/SPEC.md:434-440(§6.4.3)·:563(미해결 8), src/core/context.ts(buildContext), data/limits.json(contextTurns·contextChars·contextRationale), docs/DECISIONS.md D-031(대화 세션), docs/PLAN.md S10(실측 기록 — 세션 누적 토큰 등).
- 미커밋 diff: 없음(git status --short 비어 있음).

## 5. 검증 상태
- 실행: npm run gate → PASS 375 (main 2a00c25 기준, #34 CI gate PASS).
- 미검증: "6턴·6000자가 부족한가" 에 대한 실측 없음 — S10 재판정의 ③(앞 결과 참조 후속)은 통과했지만 긴 세션(수십 턴)·맥락이 잘려 앞 내용을 잃는 경우는 측정한 적 없다. 잘림이 실제로 몇 번 일어났는지 기록하는 계측도 없다(추론 — 코드 미확인).

## 6. 다음 한 걸음
실제 엔진을 쓰지 않는 조사부터: context.ts·기록 형식을 읽고 "잘림이 일어났는지" 를 기존 transcript(~/.hs-orc/scratch, project 폴더 .hs-orc/sessions) 로 오프라인 재계산할 수 있는지 확인 → 열 기준 후보(예: 잘려 나간 턴이 이후 답에서 참조되는 빈도, 잘림 발생률, 사용자가 이전 내용을 다시 설명한 횟수)와 측정 방법·비용을 사용자에게 제시하고 승인받는다.
- 그 다음: 승인된 측정(오프라인 재계산 우선, 실제 엔진 대화는 계획·토큰 상한 제시 후 승인) → 기준을 D-053 으로 기록 → SPEC 8·PRD 목록 갱신.
- 측정 없이 정할 수 있는 최소안(예: "잘림 계측만 먼저 넣고 N회 이상이면 재검토")도 선택지로 같이 제시.

## 7. 사용자에게 열린 질문 / 블로커
참고: 실제 엔진 실행은 매번 계획(명령·예상 토큰·상한·성공 기준) 제시 후 승인 — 구독 사용량. 실측 비용은 추정보다 커지는 경향(이 세션 claude haiku·low 1회 추정 $0.13 → 실측 $0.26). §6 첫 단계(오프라인 조사·계획 제시)는 질문 없이 진행 가능.

## 8. 환경 함정
- 저장소 경로에 공백(iCloud) — 항상 따옴표. 새 워크트리는 node_modules -> ".../hs-orc/node_modules.nosync" 심링크 필요(ln -s).
- 앱이 워크트리를 재활용(recycle)하면 cwd·scratchpad 가 바뀐다 — 세션 scratchpad 의 로그는 사라진다. 원시 로그는 저장소 밖 영구 위치에 떠 둘 것.
- 머지: auto-mode 분류기가 "Merge Without Review" 로 gh pr merge 를 막는다. 사용자가 "머지해줘" 로 **명시**하면 통과한다(이 세션 #30·#32·#33·#34). 애매한 승인("do as ur suggest")은 막혔다.
- gh pr merge 는 워크트리가 그 브랜치를 체크아웃 중이면 로컬 삭제를 건너뛴다 → 세션 브랜치로 checkout, ff-only, diff 가 비었는지 확인 뒤 branch -D.
- git fetch --prune 은 분류기에 막힌 적 있다 — git fetch origin main 은 통과.
- zsh 에서 "====" 는 = 확장 오류 — 구분자로 쓰지 말 것. timeout 명령 없음.
- 커밋: 한국어 conventional + Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>, PR 본문 끝 🤖 Generated with [Claude Code](https://claude.com/claude-code), squash 머지. pre-commit 훅이 gitleaks·gate 를 돈다(약 5초).
- 스크래치 저장소 ~/.hs-orc-scratch/ro-claude-20260925-201247 이 남아 있다(무변경, 지워도 됨).

## 9. 새 세션이 먼저 읽을 것
- docs/SPEC.md §6.4.3 (434-440), 미해결 목록 (555-565)
- src/core/context.ts
- data/limits.json
- docs/DECISIONS.md D-031
- docs/PLAN.md S10 (대화 세션 실측 기록)

## 인계 종결
사유: 수행함
- 한 것: 기존 기록 6개 오프라인 재계산 → 전부 3턴 이하·최대 596자·잘림 0회. 사용자가 "계측 + 기준 명문화" 선택. buildContext 가 { text, cut } 반환, direct·result 기록에 잘렸을 때만 cut{turns,chars}. D-053 작성, SPEC §6.4.3·미해결 8·테스트 표 갱신. gate 376 PASS.
- 남은 것: 없음 — PR #35 squash 머지 (main cd3ccbe).
- 함정: cut 판정(D-053 기준 2)은 사람 몫 — 긴 세션을 쓴 뒤 grep -l '"cut"' 로 찾아 읽어야 기준이 돈다. 화면 표시는 없다.
