/**
 * 큰 데이터 파일은 **미리 gzip 해 둔 것**을 받는다.
 *
 * [문제] 목록 화면이 무압축 JSON 을 받고 있었다 — cards.json 만 10.7MB.
 *   게다가 preload 는 `/data/cards.json`, 목록은 `/data/cards.json?v=…` 로
 *   **URL 이 달라 캐시가 안 맞아 같은 파일을 두 번** 받았다(실측 21.9MB).
 * [측정] gzip -9 기준 cards 10.7→1.42MB(87%↓) · ref-stats 3.4→0.36MB(89%↓)
 *   · card-shards 합계 10.4→1.32MB.
 * [처리] .json.gz 를 두고 fetchGzipJson 으로 받는다(매직바이트로 판별하므로
 *   서버가 알아서 풀어 줘도 그대로 동작한다). URL 은 이 상수 하나로 통일해
 *   두 번 받는 일이 다시 생기지 않게 한다.
 */
/**
 * [갱신] slim-1 = tools/slim_cards.py 로 상세 전용 값을 뺀 목록용 원장
 *   (gz 1.61 → 0.78MB). 내용이 바뀌었으므로 토큰을 올려 캐시를 비운다.
 */
export const CARDS_URL = "/data/cards.json.gz?v=slim-2-2138";
