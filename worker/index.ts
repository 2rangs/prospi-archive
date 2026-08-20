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
      const signature = [137, 80, 78, 71, 13, 10, 26, 10];
      let start = -1;
      for (let index = 0; index <= payload.length - signature.length; index += 1) {
        if (signature.every((byte, inner) => payload[index + inner] === byte)) { start = index; break; }
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
      return new Response(payload.slice(start, end), {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" },
      });
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
