/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/card-image") {
      const group = Number(url.searchParams.get("group"));
      const file = url.searchParams.get("file") ?? "";
      if (!Number.isInteger(group) || group < 1 || group > 12 || !/^(CS|CL)\d+\.CHK$/.test(file)) {
        return new Response("invalid card image", { status: 400 });
      }
      /**
       * 엣지 캐시를 먼저 본다.
       *
       * [문제] 응답에 immutable 캐시 헤더는 있지만 그건 **브라우저** 캐시다.
       *   워커 응답은 저절로 엣지에 남지 않아서, 새 방문자마다 원본 CDN 에
       *   최대 8회 서브요청 + PNG 스캔을 다시 했다. 목록 한 페이지가 카드
       *   이미지 25장이라 방문자 수에 그대로 비례한다.
       * [처리] Cache API 로 엣지에 저장한다. 카드 이미지는 파일명이 곧
       *   내용이라 영구 캐시해도 안전하다. 두 번째 방문자부터는 원본에
       *   나가지 않고 워커 CPU 도 거의 쓰지 않는다.
       */
      // caches.default 는 Cloudflare 확장이라 표준 CacheStorage 타입에 없다.
      const cache = (caches as unknown as { default: Cache }).default;
      const cached = await cache.match(request);
      if (cached) return cached;
      const chunks: Uint8Array[] = [];
      for (let part = 1; part <= 8; part += 1) {
        const source = `https://d2tii5d4auswg2.cloudfront.net/arb/cdn/ver2026/CARD${String(group).padStart(2, "0")}/${file}.${String(part).padStart(3, "0")}`;
        const response = await fetch(source);
        if (!response.ok) {
          if (part === 1) return new Response("image unavailable", { status: 404 });
          break;
        }
        const chunk = new Uint8Array(await response.arrayBuffer());
        chunks.push(chunk);
        if (chunk.byteLength < 1024 * 1024) break;
      }
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const payload = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { payload.set(chunk, offset); offset += chunk.byteLength; }
      /**
       * PNG 시그니처 탐색.
       *
       * [문제] 종전에는 바이트마다 `signature.every(...)` 클로저를 돌려
       *   100KB 페이로드에 80만 번 비교 + 10만 번 클로저 호출이 났다.
       *   워커는 CPU 시간이 곧 비용이라 방문자 수만큼 곱해진다.
       * [처리] 첫 바이트(0x89)만 먼저 훑고 그때만 나머지 7바이트를 본다.
       *   PNG 는 사실상 파일 앞쪽에 있어 대부분 즉시 끝난다.
       */
      let start = -1;
      for (let index = 0; index <= payload.length - 8; index += 1) {
        if (payload[index] !== 137) continue;
        if (payload[index + 1] === 80 && payload[index + 2] === 78 && payload[index + 3] === 71
          && payload[index + 4] === 13 && payload[index + 5] === 10
          && payload[index + 6] === 26 && payload[index + 7] === 10) { start = index; break; }
      }
      if (start < 0) return new Response("PNG not found", { status: 422 });
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      let cursor = start + 8;
      let end = -1;
      while (cursor + 12 <= payload.length) {
        const length = view.getUint32(cursor, false);
        const type = String.fromCharCode(...payload.slice(cursor + 4, cursor + 8));
        cursor += length + 12;
        if (cursor > payload.length) break;
        if (type === "IEND") { end = cursor; break; }
      }
      if (end < 0) return new Response("invalid PNG", { status: 422 });
      const out = new Response(payload.slice(start, end), {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" },
      });
      ctx.waitUntil(cache.put(request, out.clone()));
      return out;
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
