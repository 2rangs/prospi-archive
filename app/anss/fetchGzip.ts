"use client";

/**
 * 미리 압축해 둔 JSON 자산을 정밀도 손실 없이 읽는다.
 *
 * [문제] `.json.gz` 를 내려 주는 쪽이 `Content-Encoding: gzip` 을 붙이면
 *   브라우저 fetch 가 **본문을 이미 풀어서** 준다. 그 위에 다시
 *   DecompressionStream("gzip") 을 걸면 매직바이트가 없어 예외가 나고,
 *   여기서 null 을 돌려주는 바람에 문서가 통째로 비었다 — 이펙트가
 *   한 장도 안 그려진 원인(`docId: null · draws: 0`).
 * [측정] vinext 개발 서버는 `Content-Encoding: gzip` 을 붙인다(실측).
 *   호스트마다 다르므로 헤더를 믿지 않고 **본문 첫 두 바이트**로 판정한다.
 * [처리] 1f 8b 로 시작하면 우리가 직접 풀고, 아니면 그대로 JSON 으로 읽는다.
 *   두 경우 모두에서 같은 문서가 나오므로 호스트 설정에 의존하지 않는다.
 */
export async function fetchGzipJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
    const gzipped = head.length === 2 && head[0] === 0x1f && head[1] === 0x8b;
    if (!gzipped) return JSON.parse(new TextDecoder().decode(buf)) as T;
    if (typeof DecompressionStream === "undefined") return null;
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).json() as T;
  } catch {
    return null;
  }
}
