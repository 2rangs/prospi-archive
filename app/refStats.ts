"use client";
import { useEffect, useState } from "react";

/**
 * prospi-a.rakda3.net 표기값 (사용자 승인 하에 수집).
 * tools/scrape_ref.py 가 긁고 tools/merge_ref.py 가 우리 카드 id 에 붙인다.
 * 1차 매칭 키는 (이름, 수비 3종 정확 일치) — 清宮 동일카드 검증으로 확립.
 */
export type RefStats = {
  refId?: number; series?: string; team?: string; pos?: string;
  spirits?: number; cost?: number; hand?: string;
  abilities?: string[];
  refAptitude?: Record<string, [string, number] | string>;
  kind?: "batter" | "pitcher";
  /** 3차 부분 매칭 — team/kind/hand/trajectory 만 있고 능력치는 없다. */
  partial?: boolean;
  max?: Record<string, number>;
  defense?: Record<string, number>;
  trajectory?: string | null;
  lv0?: Record<string, number>;
  pitchRanks?: string;
};

let cache: Record<string, RefStats> | null | undefined;
const waiters: ((v: Record<string, RefStats> | null) => void)[] = [];
const detailCache = new Map<string, RefStats | null>();

export function useRefStats(): Record<string, RefStats> | null {
  const [v, setV] = useState<Record<string, RefStats> | null>(cache ?? null);
  useEffect(() => {
    if (cache !== undefined) { setV(cache); return; }
    waiters.push(setV);
    if (waiters.length === 1) {
      fetch("/data/ref-stats.json")
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null)
        .then(j => { cache = j; waiters.splice(0).forEach(w => w(j)); });
    }
  }, []);
  return v;
}

/** 상세 페이지는 3.6MB 전체 원장 대신 해당 id 접두사 조각만 읽는다. */
export function useRefStatsForId(id: string | undefined): RefStats | null {
  const [value, setValue] = useState<RefStats | null>(id ? detailCache.get(id) ?? null : null);
  useEffect(() => {
    if (!id) { setValue(null); return; }
    if (detailCache.has(id)) { setValue(detailCache.get(id) ?? null); return; }
    let alive = true;
    fetch(`/data/ref-shards/${id.slice(0, 2)}.json`)
      .then(r => (r.ok ? r.json() : {}))
      .then((shard: Record<string, RefStats>) => {
        const found = shard[id] ?? null;
        detailCache.set(id, found);
        if (alive) setValue(found);
      })
      .catch(() => { if (alive) setValue(null); });
    return () => { alive = false; };
  }, [id]);
  return value;
}

/**
 * 특훈 성장표.
 * [확인된 사실] Δ = round(Lv0 × 0.12), Lv n 값 = Lv0 + floor(Δ·n/10).
 *   레퍼런스 성장표 앵커 3명 × 3스탯 × 11레벨 전부 적중
 *   (清宮 67→75/68→76/57→64 · 菊池 60→67/61→68/67→75 · 田淵 69→77/74→83/47→53).
 */
export function growthRow(lv0: number): number[] {
  const d = Math.round(lv0 * 0.12);
  return Array.from({ length: 11 }, (_, n) => lv0 + Math.floor((d * n) / 10));
}
