# adapters — EngineAdapter (SPEC §3)

`claude` / `codex` / `cursor` 세 CLI를 하나의 인터페이스 뒤에 둔다.

**CLI 플래그 문자열은 이 디렉터리 밖으로 나가지 않는다.** `core/`·`shell/` import는 lint 에러다.

`jev.ts` 는 엔진이 아니라 **분류용 HTTP 클라이언트**다 (D-065) — 요청 문장이 `api.typesafe.ai` 로 나간다. core 는 `RowClassifier` 인터페이스만 안다.
