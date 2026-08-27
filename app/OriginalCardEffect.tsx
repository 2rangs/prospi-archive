"use client";

import { useEffect, useState } from "react";
import { effectTextureUrl } from "./anss/AnssStage";

/**
 * Card background effects rebuilt from the app's own AnimSS05 data.
 *
 * `ANSS_EF_<effect_id>_L.CHK` is a tagged container: CLMP sections hold PNG
 * texture sheets, PRCT sections hold one AnimSS05 part each. A part names its
 * sprite cells (rect + pivot inside the sheet), its clip canvas (320x320),
 * frame count and fps, plus a node graph. Parts ending in `_b*` draw behind the
 * player and `_f*` in front, so the player image has to sit between two stacks
 * rather than on top of a single background.
 *
 * `public/effects/<id>/sprites/*.png` are those cells cropped out of the sheets
 * and `public/effects/layers.json` is the render plan built from the same data.
 * Frame sequences come from the app's own `_1.._n` cell numbering. Per-node
 * keyframe transforms are not decoded yet, so cells are anchored by their
 * original pivot and stacked largest-first instead of being positioned.
 */

const EFFECT_IDS: Record<number, number> = {
  1: 101005,
  2: 201005,
  3: 301005,
  4: 401005,
  5: 501005,
  6: 601005,
  7: 701005,
  8: 801005,
  9: 901005,
  10: 1001005,
  11: 1101005,
  12: 1201005,
};

export function effectIdForGroup(group: number) {
  return EFFECT_IDS[group] || EFFECT_IDS[12];
}

/** 문자열 안정 해시(FNV-1a). variant→effect 선택을 재현 가능하게. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/**
 * 카드 변형(variant)에서 effect_id를 결정적으로 유도한다.
 * 진짜 effect_id는 서버 carddef(PlayerCardMinInfo)에 있어 로컬엔 없으므로,
 * effect_id의 실제 구조(group+series+sub+rank)를 이용해 다음처럼 매핑한다:
 *   - group  = 카드의 연도 그룹(정확)
 *   - series = 그 group의 재생가능 이펙트 series 목록에서 variant 앞2자리 해시로 선택
 *   - sub    = 해당 series 안에서 variant 뒤2자리 해시로 선택
 *   - rank   = 5(최상위·가장 화려한 연출) 우선
 * 같은 변형은 항상 같은 이펙트, 다른 변형은 대체로 다른 series/sub → 다른 이펙트.
 */
export function effectIdFromVariant(
  group: number, variant: string, plans: Record<string, EffectPlan> | null,
): number {
  if (!plans) return effectIdForGroup(group);
  const all = Object.values(plans).filter(p => p.group === group && p.spriteCount > 4);
  if (!all.length) return effectIdForGroup(group);
  let cand = all.filter(p => p.rank === 5);
  if (!cand.length) cand = all;
  const seriesList = [...new Set(cand.map(p => p.series))].sort();
  const series = seriesList[fnv1a(variant.slice(0, 2)) % seriesList.length];
  const inSeries = cand.filter(p => p.series === series).sort((a, b) => a.effectId - b.effectId);
  return inSeries[fnv1a(variant.slice(2)) % inSeries.length].effectId;
}

/** 카드(group+variant)에 대응하는 effect_id 훅. plans 로딩 전엔 group 기본값. */
export function useCardEffectId(group?: number, variant?: string): number {
  const plans = useAllEffectPlans();
  if (group == null) return effectIdForGroup(12);
  if (!variant) return effectIdForGroup(group);
  return effectIdFromVariant(group, variant, plans);
}

type Anchored = { name: string; w: number; h: number; px: number; py: number };
type StillLayer = Anchored & { kind: "still"; role: "back" | "front"; file: string };
type FlipLayer = Anchored & { kind: "flip"; role: "back" | "front"; frames: string[] };
type Layer = StillLayer | FlipLayer;

export type EffectPlan = {
  effectId: number;
  group: number;
  series: string;
  sub: string;
  rank: number;
  canvasW: number;
  canvasH: number;
  frames: number;
  fps: number;
  spriteCount: number;
  layers: Layer[];
};

let planCache: Record<string, EffectPlan> | null = null;
let planRequest: Promise<Record<string, EffectPlan>> | null = null;

function loadPlans() {
  if (planCache) return Promise.resolve(planCache);
  if (!planRequest) {
    planRequest = fetch("/effects/layers.json")
      .then(response => response.json())
      .then((plans: Record<string, EffectPlan>) => { planCache = plans; return plans; })
      .catch(() => ({}));
  }
  return planRequest;
}

export function useEffectPlanById(effectId?: number) {
  const [plan, setPlan] = useState<EffectPlan | null>(
    effectId != null ? planCache?.[String(effectId)] ?? null : null);
  useEffect(() => {
    if (effectId == null) { setPlan(null); return; }
    let alive = true;
    loadPlans().then(plans => { if (alive) setPlan(plans[String(effectId)] ?? null); });
    return () => { alive = false; };
  }, [effectId]);
  return { plan };
}

export function useAllEffectPlans() {
  const [plans, setPlans] = useState<Record<string, EffectPlan> | null>(planCache);
  useEffect(() => {
    let alive = true;
    loadPlans().then(all => { if (alive) setPlans(all); });
    return () => { alive = false; };
  }, []);
  return plans;
}

export function useEffectPlan(group: number) {
  const effectId = effectIdForGroup(group);
  const [plan, setPlan] = useState<EffectPlan | null>(planCache?.[String(effectId)] ?? null);
  useEffect(() => {
    let alive = true;
    loadPlans().then(plans => { if (alive) setPlan(plans[String(effectId)] ?? null); });
    return () => { alive = false; };
  }, [effectId]);
  return { effectId, plan };
}

/** Shared clock so every sprite on the page advances on the same original-fps beat. */
function useFrameClock(fps: number, frames: number, active: boolean) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active || !fps || !frames) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setFrame(value => (value + 1) % frames), 1000 / fps);
    return () => window.clearInterval(timer);
  }, [fps, frames, active]);
  return frame;
}

function spriteStyle(layer: Layer, plan: EffectPlan): React.CSSProperties {
  return {
    width: `${(layer.w / plan.canvasW) * 100}%`,
    transform: `translate(calc(-50% + ${(layer.px * 100).toFixed(2)}%), calc(-50% + ${(layer.py * 100).toFixed(2)}%))`,
  };
}

export default function OriginalCardEffect({
  group,
  effectId: forced,
  layer = "back",
  compact = false,
}: {
  group: number;
  effectId?: number;
  layer?: "back" | "front";
  compact?: boolean;
}) {
  const { effectId: byGroup, plan: planByGroup } = useEffectPlan(group);
  const { plan: planForced } = useEffectPlanById(forced);
  const effectId = forced ?? byGroup;
  const plan = forced ? planForced : planByGroup;
  const frame = useFrameClock(plan?.fps ?? 0, plan?.frames ?? 0, Boolean(plan));
  const layers = (plan?.layers ?? []).filter(item => item.role === layer);

  return <div
    className={`fx fx-${layer}${compact ? " compact" : ""}`}
    aria-hidden="true"
    data-effect-id={effectId}
    data-sprites={layers.length}
  >
    {plan && layers.map((item, index) => {
      const src = item.kind === "flip" ? item.frames[frame % item.frames.length] : item.file;
      return <img
        key={`${item.role}-${item.name}-${index}`}
        className={`fx-sprite fx-${item.kind}`}
        style={spriteStyle(item, plan)}
        src={effectTextureUrl(`sprites-webp/${src}.webp`)}
        alt=""
        loading="lazy"
        decoding="async"
      />;
    })}
  </div>;
}
