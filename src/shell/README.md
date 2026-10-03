# shell — 교체 가능한 UI 계층 (SPEC §1)

터미널은 CLI(`cli.ts` 한 번 실행 · `chat.ts` 대화 세션), 화면은 GUI(`gui/`). v1 의 TUI 는 D-077 로 제거했다.
Core 를 바꾸지 않고 이 디렉터리만 교체·추가한다 (D-001).

Core를 소비하기만 하고, Core는 이쪽을 모른다.
