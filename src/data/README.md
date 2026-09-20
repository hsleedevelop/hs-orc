# data — 설정·매트릭스 접근 (SPEC §9)

| 파일 | 성격 |
|---|---|
| `data/matrix.json` | **생성물.** 원본 HTML이 진실이다 (D-013). `npm run gen:matrix` 로만 갱신한다 |
| `data/engines.json` | 수기. 바이너리 해석·모델↔엔진 매핑·가용성·effort 표기 (S1~S2에서 추가) |
| `data/limits.json` | 수기. 반복 상한·노드 상한·비용 상한·타임아웃 (S4에서 추가) |

이 계층은 `core/`·`adapters/`·`shell/` 을 import하지 않는다.
