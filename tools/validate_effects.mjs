#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeEffectId, resolveEffect } from "../app/anss/resolve.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const cards = read("public/data/cards.json");
const pool = read("public/effects/effect-keys.json").map(decodeEffectId).filter(Boolean);
const knownDoc = read("public/effects/known-map.json");
const known = knownDoc.map ?? knownDoc;
const effectIds = new Set(pool.map((value) => value.effectId));
const cardIds = new Set(cards.map((value) => String(value.id)));
const levels = {};
const invalid = [];
const targets = {};

for (const card of cards) {
  const result = resolveEffect(card.group, card.variant, pool, known, String(card.id));
  if (!result) {
    invalid.push({ cardId: card.id, reason: "unresolved" });
    continue;
  }
  levels[result.level] = (levels[result.level] ?? 0) + 1;
  if (result.level !== "none" && !effectIds.has(result.effectId)) {
    invalid.push({ cardId: card.id, effectId: result.effectId, reason: "missing-resource" });
  }
  const decodedGroup = Number(result.effectId.slice(0, result.effectId.length - 5));
  if (result.level !== "none" && decodedGroup !== card.group) {
    invalid.push({ cardId: card.id, effectId: result.effectId, reason: "year-group-mismatch" });
  }
  if (["839453100", "1139453200", "1139455100", "1251410100", "1251410700", "1282670900"].includes(String(card.id))) {
    targets[String(card.id)] = { name: card.name, variant: card.variant, ...result };
  }
}

for (const [cardId, effectId] of Object.entries(known)) {
  if (!cardIds.has(cardId)) invalid.push({ cardId, effectId, reason: "known-card-missing" });
  if (!/^\d{10}$/.test(effectId) && !effectIds.has(effectId)) {
    invalid.push({ cardId, effectId, reason: "known-effect-missing" });
  }
}

const report = {
  cards: cards.length,
  effects: pool.length,
  measuredMappings: Object.keys(known).length,
  levels,
  invalid,
  targets,
};
fs.writeFileSync(path.join(root, "output/rakda3/effect-validation.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (invalid.length) process.exitCode = 1;
