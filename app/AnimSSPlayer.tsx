"use client";

import { useEffect, useRef, useState } from "react";
import { loadAnss } from "./anss/useAnss";
import { effectTextureUrl } from "./anss/AnssStage";

/**
 * Plays the app's own AnimSS animation data. (v2)
 *
 * Attribute ids and the keyframe struct were read out of libAll.so
 * (AnimssNormalModel::updatePartAttributeSub dispatches a 33-entry jump table
 * onto AnimssPart::setPosX / setPosY / setRotZ / setScaleX / setScaleY /
 * setHide / …), so the transforms here are the game's own values.
 *
 * v2: 키프레임 보간 모드(0=hold, 1=linear, 2=hermite) 반영, 부모-자식을
 * 2×2 행렬로 합성(회전+비균등 스케일의 왜곡 제거), hide/priority/cell 은
 * 스텝 샘플링, 로컬 인스턴스(kind 3)의 USERDATA 시차 재생(8.8 고정소수점
 * 프레임), ROTX/ROTY 는 직교투영 cos 스쿼시, PRIORITY 는 z-index 로 반영.
 */

// [frame, value, curve] plus AnimssDescCurve handles for hermite / bezier
type Key = [number, number, number] | [number, number, number, number[]];
type CellKey = [number, number, number];        // [frame, cellIndex, interp]
type Cell = { file: string; w: number; h: number; px: number; py: number };
type Track = Key[];
type Part = {
  n: string; p: number; k: number; role: "back" | "front";
  t: {
    x?: Track; y?: Track; rot?: Track; rx?: Track; ry?: Track;
    sx?: Track; sy?: Track; a?: Track; hide?: Track; prio?: Track;
    fh?: Track; fv?: Track; pvx?: Track; pvy?: Track;
    ifh?: Track; ifv?: Track;
    uvx?: Track; uvy?: Track; uvrot?: Track; uvsx?: Track; uvsy?: Track;
  };
  c?: Cell;
  cells?: Cell[];
  ct?: CellKey[];
  v?: { blend: number; c: [number, number, number, number][] };
  user?: number;
  bl?: number;                         // SpriteStudio BlendType: 1=Mul 2=Add 3=Sub (0=Mix 은 생략)
};

/** BlendType -> CSS mix-blend-mode. Add 는 plus-lighter(정확한 GL_ONE,GL_ONE 가산). */
function blendMode(bl?: number): string | undefined {
  if (bl === 2) return "plus-lighter";   // Add
  if (bl === 1) return "multiply";        // Mul
  if (bl === 3) return "difference";      // Sub (근사)
  return undefined;                       // Mix = 일반 알파
}
export type AnimDoc = { effectId: number; canvasW: number; canvasH: number; stageW?: number; stageH?: number; frames: number; fps: number; parts: Part[] };

/** Center alpha per sprite cell, so solid cells are drawn rather than masked. */
let alphaIndex: Record<string, number> | null = null;
let alphaRequest: Promise<Record<string, number>> | null = null;
function loadAlpha() {
  if (alphaIndex) return Promise.resolve(alphaIndex);
  if (!alphaRequest) {
    alphaRequest = fetch("/effects/sprite-alpha.json")
      .then(r => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then((a: Record<string, number>) => { alphaIndex = a; return a; });
  }
  return alphaRequest;
}

/**
 * The six curve modes AnimssInterpolation dispatches on
 * (AnimssDescKeyFrame+0x04, table in interpolateKeyFrameFloat):
 *   0 hold  1 linear  2 hermite  3 bezier  4 acceleration  5 deceleration
 * Hermite and bezier read AnimssDescCurve at keyframe+0x08, which the exporter
 * carries as a fourth element [x0, y0, x1, y1].
 */
function solveBezierT(t: number, x0: number, x1: number) {
  // cubic bezier x(u) with p0=0, p3=1; two Newton passes are plenty at 11fps
  let u = t;
  for (let i = 0; i < 4; i += 1) {
    const w = 1 - u;
    const x = 3 * w * w * u * x0 + 3 * w * u * u * x1 + u * u * u - t;
    const dx = 3 * w * w * x0 + 6 * w * u * (x1 - x0) + 3 * u * u * (1 - x1);
    if (Math.abs(dx) < 1e-6) break;
    u -= x / dx;
    if (u < 0) u = 0; else if (u > 1) u = 1;
  }
  return u;
}

function sample(track: Track | undefined, frame: number, fallback: number) {
  if (!track || !track.length) return fallback;
  if (frame <= track[0][0]) return track[0][1];
  const last = track[track.length - 1];
  if (frame >= last[0]) return last[1];
  for (let i = 1; i < track.length; i += 1) {
    const key = track[i];
    const f1 = key[0], v1 = key[1], curve = key[2];
    if (frame <= f1) {
      const prev = track[i - 1];
      const f0 = prev[0], v0 = prev[1];
      const span = f1 - f0;
      if (span <= 0) return v1;
      const t = (frame - f0) / span;
      switch (curve) {
        case 0: return v0;                                   // hold
        case 4: return v0 + (v1 - v0) * t * t;               // acceleration
        case 5: return v0 + (v1 - v0) * (1 - (1 - t) * (1 - t)); // deceleration
        case 2: {                                            // hermite
          const h = key[3];
          const m0 = h ? h[1] : 0, m1 = h ? h[3] : 0;
          const t2 = t * t, t3 = t2 * t;
          return (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * m0
               + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * m1;
        }
        case 3: {                                            // bezier
          const h = key[3];
          if (!h) return v0 + (v1 - v0) * t;
          const u = solveBezierT(t, h[0], h[2]);
          const w = 1 - u;
          return w * w * w * v0 + 3 * w * w * u * (v0 + h[1])
               + 3 * w * u * u * (v1 + h[3]) + u * u * u * v1;
        }
        default: return v0 + (v1 - v0) * t;                  // linear
      }
    }
  }
  return last[1];
}

/** 정수/토글 트랙은 보간 없이 최근 키 값을 그대로 쓴다. */
function sampleStep(track: Track | undefined, frame: number, fallback: number) {
  if (!track || !track.length) return fallback;
  let v = frame < track[0][0] ? fallback : track[0][1];
  for (let i = 0; i < track.length; i += 1) {
    if (track[i][0] <= frame) v = track[i][1];
    else break;
  }
  return v;
}

/**
 * AnimSS works y-up and places the origin on the player's body, not the middle
 * of the card frame, so the vertical axis is flipped on the way out and the
 * origin sits below centre.
 */
const ORIGIN_Y = 58;
/** The clip canvas is not drawn edge to edge of the card frame. */
const CANVAS_FILL = 0.84;

/** row-major 2x2 + translation (canvas units). */
type World = { a: number; b: number; c: number; d: number; e: number; f: number; alpha: number; hidden: boolean; off: number; prio: number };

function solve(doc: AnimDoc, frame: number) {
  const world: World[] = new Array(doc.parts.length);
  const F = doc.frames;
  for (let i = 0; i < doc.parts.length; i += 1) {
    const part = doc.parts[i];
    const parent = part.p >= 0 && part.p < i ? world[part.p] : null;
    // [ADVANCE]#N phase-shifts a part by N frames. root carries [LOOP] at frame 0,
    // so the clip repeats and the shift has to wrap -- otherwise every shifted
    // copy settles on its last pose (the arrows freeze into a fan) instead of
    // travelling. Shifts are inherited so a whole sub-clip moves together.
    let off = parent ? parent.off : 0;
    if (part.user != null) off += part.user;
    const lf = F > 0 ? ((frame + off) % F + F) % F : frame + off;

    const lx = sample(part.t.x, lf, 0);
    const ly = sample(part.t.y, lf, 0);
    const lrot = sample(part.t.rot, lf, 0);
    const lrx = sample(part.t.rx, lf, 0);
    const lry = sample(part.t.ry, lf, 0);
    let lsx = sample(part.t.sx, lf, 1);
    let lsy = sample(part.t.sy, lf, 1);
    const la = sample(part.t.a, lf, 1);
    const hide = sampleStep(part.t.hide, lf, 0) > 0.5;
    const prio = sampleStep(part.t.prio, lf, 0);
    if (sampleStep(part.t.fh, lf, 0) > 0.5) lsx = -lsx;
    if (sampleStep(part.t.fv, lf, 0) > 0.5) lsy = -lsy;
    // 직교투영에서 3D 기울임은 cos 스쿼시로 나타난다
    lsx *= Math.cos((lry * Math.PI) / 180);
    lsy *= Math.cos((lrx * Math.PI) / 180);

    const rad = (lrot * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    // local = T(x,y) · R(rot) · S(sx,sy)
    const la2 = cos * lsx, lb = sin * lsx, lc = -sin * lsy, ld = cos * lsy;
    if (!parent) {
      world[i] = { a: la2, b: lb, c: lc, d: ld, e: lx, f: ly, alpha: la, hidden: hide, off, prio };
      continue;
    }
    world[i] = {
      a: parent.a * la2 + parent.c * lb,
      b: parent.b * la2 + parent.d * lb,
      c: parent.a * lc + parent.c * ld,
      d: parent.b * lc + parent.d * ld,
      e: parent.a * lx + parent.c * ly + parent.e,
      f: parent.b * lx + parent.d * ly + parent.f,
      alpha: parent.alpha * la,
      hidden: parent.hidden || hide,
      off,
      prio: prio || parent.prio,
    };
  }
  return world;
}

/** Mean tint luminance; multiplied-to-black parts add nothing additively. */
function tintLuma(part: Part) {
  if (!part.v) return 255;
  const cs = part.v.c;
  return cs.reduce((sum, [r, g, b]) => sum + (r * 0.299 + g * 0.587 + b * 0.114), 0) / cs.length;
}

function tintStyle(part: Part, cell: Cell): React.CSSProperties | null {
  const v = part.v;
  if (!v) return null;
  const rgb = v.c.map(([r, g, b]) => `rgb(${r},${g},${b})`);
  const flat = v.c.every(([r, g, b]) => r > 245 && g > 245 && b > 245);
  if (flat) return null;                       // white -> no modulation
  if ((alphaIndex?.[cell.file] ?? 0) >= 250) return null;
  const bg = v.blend && rgb.length === 4
    ? `linear-gradient(to right, ${rgb[0]} 0%, ${rgb[1]} 50%, ${rgb[3]} 100%)`
    : rgb[0];
  const mask = `url(${effectTextureUrl(`sprites-webp/${cell.file}.webp`)})`;
  return {
    background: bg,
    WebkitMaskImage: mask, maskImage: mask,
    WebkitMaskSize: "100% 100%", maskSize: "100% 100%",
    WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
    WebkitMaskPosition: "center", maskPosition: "center",
  } as React.CSSProperties;
}

export default function AnimSSPlayer({
  effectId, layer = "back", paused = false,
}: { effectId: number; layer?: "back" | "front"; paused?: boolean }) {
  const [doc, setDoc] = useState<AnimDoc | null>(null);
  const [frame, setFrame] = useState(0);
  const raf = useRef<number | null>(null);

  const [, setAlphaReady] = useState(alphaIndex != null);
  useEffect(() => {
    let alive = true;
    loadAlpha().then(() => { if (alive) setAlphaReady(true); });
    setDoc(null);
    loadAnss(effectId).then(d => { if (alive) setDoc(d as AnimDoc | null); });
    return () => { alive = false; };
  }, [effectId]);

  useEffect(() => {
    if (!doc || paused) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const start = performance.now();
    const tick = () => {
      const elapsed = (performance.now() - start) / 1000;
      setFrame((elapsed * doc.fps) % doc.frames);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current != null) cancelAnimationFrame(raf.current); };
  }, [doc, paused]);

  if (!doc) return <div className={`fx fx-${layer}`} aria-hidden="true" />;

  const world = solve(doc, frame);
  // Positions are authored against the animation stage (720-ish wide); the
// clip "canvas" is a constant 320x320 in every effect and is not the frame.
  const ref = doc.stageW || doc.canvasW;
  const unit = (100 / ref) * CANVAS_FILL;   // canvas units -> % of the container

  return <div className={`fx fx-${layer}`} aria-hidden="true" data-effect-id={effectId}>
    {doc.parts.map((part, i) => {
      if (part.role !== layer) return null;
      const w = world[i];
      if (!w || w.hidden || w.alpha <= 0.01) return null;
      // 셀 플립북
      let cell = part.c;
      if (part.cells && part.ct) {
        const lf = frame + w.off;
        const ci = sampleStep(part.ct as unknown as Track, lf, 0);
        cell = part.cells[Math.max(0, Math.min(part.cells.length - 1, Math.round(ci)))];
      }
      if (!cell) return null;
      if (tintLuma(part) < 12) return null;   // multiplied to black

      const base: React.CSSProperties = {
        width: `${cell.w * unit}%`,
        aspectRatio: `${cell.w} / ${cell.h}`,
        left: `${50 + w.e * unit}%`,
        top: `${ORIGIN_Y - w.f * unit}%`,
        opacity: Math.min(1, w.alpha),
        zIndex: 100 + Math.round(w.prio),
        mixBlendMode: blendMode(part.bl) as React.CSSProperties["mixBlendMode"],
        transform: `translate(-50%, -50%) matrix(${w.a}, ${w.b}, ${w.c}, ${w.d}, 0, 0)`
          + ` translate(${cell.px * 100}%, ${cell.py * 100}%)`,
      };
      const tint = tintStyle(part, cell);
      if (tint) {
        return <span key={`${i}-${part.n}`} className="fx-part fx-tint" style={{ ...base, ...tint }} />;
      }
      return <img
        key={`${i}-${part.n}`}
        className="fx-part"
        src={effectTextureUrl(`sprites-webp/${cell.file}.webp`)}
        alt=""
        loading="lazy"
        decoding="async"
        style={base}
      />;
    })}
  </div>;
}
