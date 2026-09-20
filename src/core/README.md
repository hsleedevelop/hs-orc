# core — 헤드리스 오케스트레이션 (SPEC §1)

Classifier → Gatekeeper → Assigner → ModeRunner → EvidenceCollector.

**Core는 UI를 모른다.** 바깥과는 이벤트 스트림·콜백으로만 통신한다. `shell/` import는 lint 에러다.
