import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the player archive", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /PROSPI/);
  assert.match(html, /ARCHIVE/);
  assert.match(html, /選手一覧/);
  assert.match(html, /href="\/effects"/);
});

test("published card, reference and effect datasets agree", async () => {
  const [cards, refs, effectIds, knownDoc] = await Promise.all([
    readFile(new URL("../public/data/cards.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../public/data/ref-stats.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../public/effects/effect-keys.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../public/effects/known-map.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const cardIds = new Set(cards.map((card) => String(card.id)));
  // 원장은 최신화로 계속 증가한다. 예전 장수를 고정하면 정상적인
  // 신규 카드도 회귀로 오판하므로, 최소 보장과 ID 유일성을 같이 검증한다.
  assert.ok(cards.length >= 15_222);
  assert.equal(cardIds.size, cards.length);
  assert.ok(Object.keys(refs).every((id) => cardIds.has(id)));
  const availableEffects = new Set(effectIds);
  assert.ok(Object.values(knownDoc.map).every((id) => /^\d{10}$/.test(id) || availableEffects.has(id)));
  assert.equal(refs["1139453200"].kind, "batter");
  assert.equal(refs["1139455100"].kind, "pitcher");
});
