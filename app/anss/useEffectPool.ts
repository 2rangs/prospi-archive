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
    inflight = fetch("/effects/effect-keys.json")
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

export function useKnownMap(): Record<string, string> {
  const [m, setM] = useState<Record<string, string>>(knownCache ?? {});
  useEffect(() => {
    let alive = true;
    if (!knownInflight) {
      knownInflight = fetch("/effects/known-map.json")
        .then(r => (r.ok ? r.json() : { map: {} }))
        .catch(() => ({ map: {} }))
        .then((j: { map?: Record<string, string> }) => {
          knownCache = j.map ?? {};
          return knownCache;
        });
    }
    knownInflight.then(k => { if (alive) setM(k); });
    return () => { alive = false; };
  }, []);
  return m;
}
