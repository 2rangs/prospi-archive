"use client";

/** Load a pre-compressed JSON asset without losing any animation precision. */
export async function fetchGzipJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body || typeof DecompressionStream === "undefined") return null;
    const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).json() as T;
  } catch {
    return null;
  }
}
