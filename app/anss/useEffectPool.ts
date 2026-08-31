"use client";

import { useEffect, useState } from "react";
import { EffectKey, decodeEffectId } from "./resolve";

/**
 * 재생 가능한 이펙트 id 목록. 파일명이 곧 구조(group+series+sub+rank)이므로
 * 별도 메타데이터 없이 id 문자열만 받아 분해한다. 목록에는 export가 끝난
 * 문서만 들어가므로 여기서 고른 id는 항상 로드된다.
 */
let cached: EffectKey[] | null = null;
let inflight: Promise<EffectKey[]> | null = null;

export function loadEffectPool(): Promise<EffectKey[]> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = fetch("/effects/effect-keys.json?v=2138")
      .then(r => (r.ok ? r.json() : []))
      .catch(() => [] as string[])
      .then((ids: string[]) => {
        cached = ids.map(decodeEffectId).filter((k): k is EffectKey => !!k);
        return cached;
      });
  }
  return inflight;
}

export function useEffectPool(): EffectKey[] {
  const [pool, setPool] = useState<EffectKey[]>(cached ?? []);
  useEffect(() => {
    let alive = true;
    loadEffectPool().then(p => { if (alive) setPool(p); });
    return () => { alive = false; };
  }, []);
  return pool;
}

/**
 * 실측 Image ID → Effect ID 매핑. 사용자가 게임에서 확인해 준 값만 들어간다.
 * 추측값은 여기 넣지 않는다.
 */
let knownCache: Record<string, string> | null = null;
let knownInflight: Promise<Record<string, string>> | null = null;

/**
 * 실측 카드의 종류 코드·리그. known-map.json 의 meta 블록이며
 * tools/known_map_meta.py 가 ref-stats 에서 굽는다. 매칭 키를
 * (group, variant, 종류) 로 넓히는 데 쓴다 — 상세 화면이 ref 전체를 읽지
 * 않으므로 실측분만 여기에 들어 있다.
 */
export type KnownMeta = Record<string, { kind?: string; league?: string }>;
let metaCache: KnownMeta | null = null;

export function useKnownMeta(): KnownMeta {
  const [m, setM] = useState<KnownMeta>(metaCache ?? {});
  useEffect(() => {
    let alive = true;
    void loadKnown().then(j => { if (alive) setM(j.meta ?? {}); });
    return () => { alive = false; };
  }, []);
  return m;
}

type KnownFile = { map?: Record<string, string>; meta?: KnownMeta };
let knownFile: Promise<KnownFile> | null = null;
/** 예열용 — 훅과 같은 캐시를 채운다. */
export function loadKnown(): Promise<KnownFile> {
  if (!knownFile) {
    knownFile = fetch("/effects/known-map.json")
      .then(r => (r.ok ? r.json() : {}))
      .catch(() => ({} as KnownFile))
      .then((j: KnownFile) => { knownCache = j.map ?? {}; metaCache = j.meta ?? {}; return j; });
  }
  return knownFile;
}

export function useKnownMap(): Record<string, string> {
  const [m, setM] = useState<Record<string, string>>(knownCache ?? {});
  useEffect(() => {
    let alive = true;
    if (!knownInflight) knownInflight = loadKnown().then(j => j.map ?? {});
    void knownInflight.then(k => { if (alive) setM(k); });
    return () => { alive = false; };
  }, []);
  return m;
}
