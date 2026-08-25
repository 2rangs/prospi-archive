"use client";

import { useEffect, useRef } from "react";
import { Application, Container, Sprite, Texture, Matrix, Assets } from "pixi.js";

/**
 * WebGL(PixiJS) 재현. AnimSSPlayer(DOM)와 같은 키프레임 모델을 쓰되,
 * 합성을 GPU 프리멀티플라이드로 처리한다.
 *   - BlendType 2(Add) -> Pixi 'add' (진짜 GL_ONE,GL_ONE 가산; mix-blend-mode 근사가 아님)
 *   - BlendType 1(Mul) -> 'multiply'
 *   - VertexColor -> sprite.tint (셀을 곱해 흰 글로우를 팀색으로)
 * 노드 그래프/트랙/보간/인스턴스 시차는 export_anim(v2) JSON 그대로.
 */

type Key = [number, number, number];
type CellKey = [number, number, number];
type Cell = { file: string; w: number; h: number; px: number; py: number };
type Track = Key[];
type Part = {
  n: string; p: number; k: number; role: "back" | "front";
  t: Record<string, Track | undefined>;
  c?: Cell; cells?: Cell[]; ct?: CellKey[];
  v?: { blend: number; c: [number, number, number, number][] };
  user?: number; bl?: number;
};
/** The clip canvas is not drawn edge to edge, and its origin sits on the
 *  player's body rather than the middle of the card frame. */
const CANVAS_FILL = 0.84;
const ORIGIN_Y = 0.58;

type AnimDoc = { effectId: number; canvasW: number; canvasH: number; stageW?: number; stageH?: number; frames: number; fps: number; parts: Part[] };

const docCache = new Map<number, AnimDoc | null>();
function loadDoc(effectId: number) {
  if (docCache.has(effectId)) return Promise.resolve(docCache.get(effectId)!);
  return fetch(`/effects/anim/${effectId}.json`)
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((d: AnimDoc | null) => { docCache.set(effectId, d); return d; });
}

/**
 * The six curve modes AnimssInterpolation dispatches on, from the table in
 * interpolateKeyFrameFloat (AnimssDescKeyFrame+0x04):
 *   0 hold  1 linear  2 hermite  3 bezier  4 acceleration  5 deceleration
 * Hermite / bezier read AnimssDescCurve at keyframe+0x08, carried here as a
 * fourth key element [x0, y0, x1, y1].
 */
function solveBezierT(t: number, x0: number, x1: number) {
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
    const key = track[i] as number[];
    const f1 = key[0], v1 = key[1], curve = key[2];
    if (frame <= f1) {
      const prev = track[i - 1] as number[];
      const f0 = prev[0], v0 = prev[1];
      const span = f1 - f0;
      if (span <= 0) return v1;
      const t = (frame - f0) / span;
      const h = key[3] as unknown as number[] | undefined;
      switch (curve) {
        case 0: return v0;
        case 4: return v0 + (v1 - v0) * t * t;
        case 5: return v0 + (v1 - v0) * (1 - (1 - t) * (1 - t));
        case 2: {
          const m0 = h ? h[1] : 0, m1 = h ? h[3] : 0;
          const t2 = t * t, t3 = t2 * t;
          return (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * m0
               + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * m1;
        }
        case 3: {
          if (!h) return v0 + (v1 - v0) * t;
          const u = solveBezierT(t, h[0], h[2]);
          const w = 1 - u;
          return w * w * w * v0 + 3 * w * w * u * (v0 + h[1])
               + 3 * w * u * u * (v1 + h[3]) + u * u * u * v1;
        }
        default: return v0 + (v1 - v0) * t;
      }
    }
  }
  return last[1];
}
function sampleStep(track: Track | undefined, frame: number, fallback: number) {
  if (!track || !track.length) return fallback;
  let v = frame < track[0][0] ? fallback : track[0][1];
  for (let i = 0; i < track.length; i += 1) { if (track[i][0] <= frame) v = track[i][1]; else break; }
  return v;
}

type World = { a: number; b: number; c: number; d: number; e: number; f: number; alpha: number; hidden: boolean; off: number; prio: number };

function solve(doc: AnimDoc, frame: number, out: World[]) {
  for (let i = 0; i < doc.parts.length; i += 1) {
    const part = doc.parts[i];
    const parent = part.p >= 0 && part.p < i ? out[part.p] : null;
    let off = parent ? parent.off : 0;
    if (part.user != null) off += part.user;
    const F = doc.frames;
    const lf = F > 0 ? ((frame + off) % F + F) % F : frame + off;
    const lx = sample(part.t.x, lf, 0), ly = sample(part.t.y, lf, 0);
    const lrot = sample(part.t.rot, lf, 0);
    const lrx = sample(part.t.rx, lf, 0), lry = sample(part.t.ry, lf, 0);
    let lsx = sample(part.t.sx, lf, 1), lsy = sample(part.t.sy, lf, 1);
    const la = sample(part.t.a, lf, 1);
    const hide = sampleStep(part.t.hide, lf, 0) > 0.5;
    const prio = sampleStep(part.t.prio, lf, 0);
    if (sampleStep(part.t.fh, lf, 0) > 0.5) lsx = -lsx;
    if (sampleStep(part.t.fv, lf, 0) > 0.5) lsy = -lsy;
    lsx *= Math.cos((lry * Math.PI) / 180);
    lsy *= Math.cos((lrx * Math.PI) / 180);
    const rad = (lrot * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const la2 = cos * lsx, lb = sin * lsx, lc = -sin * lsy, ld = cos * lsy;
    if (!parent) { out[i] = { a: la2, b: lb, c: lc, d: ld, e: lx, f: ly, alpha: la, hidden: hide, off, prio }; continue; }
    out[i] = {
      a: parent.a * la2 + parent.c * lb, b: parent.b * la2 + parent.d * lb,
      c: parent.a * lc + parent.c * ld, d: parent.b * lc + parent.d * ld,
      e: parent.a * lx + parent.c * ly + parent.e, f: parent.b * lx + parent.d * ly + parent.f,
      alpha: parent.alpha * la, hidden: parent.hidden || hide, off, prio: prio || parent.prio,
    };
  }
}

function tintOf(part: Part): number {
  if (!part.v || part.v.blend !== 0) return 0xffffff;
  const [r, g, b] = part.v.c[0];
  if (r > 245 && g > 245 && b > 245) return 0xffffff;
  return (r << 16) | (g << 8) | b;
}

/**
 * AnimssPart::setVertexColor blend 1 carries one colour per corner, and those
 * corner colours are the effect's colour split (a card's red side and blue side
 * are one quad tinted per corner). Averaging them collapses the split into one
 * muddy tone, so the gradient is baked onto a copy of the cell instead: draw
 * the cell, then multiply a bilinear 2x2 of the four corners over it.
 */
const gradientCache = new Map<string, Texture>();

function cornerGradientTexture(cell: Cell, v: NonNullable<Part["v"]>) {
  const cs = v.c;
  const key = `${cell.file}|${cs.map(c => c.slice(0, 3).join(",")).join("|")}`;
  const hit = gradientCache.get(key);
  if (hit) return hit;

  const base = Texture.from(`/effects/sprites/${cell.file}.png`);
  const src = base.source?.resource as CanvasImageSource | undefined;
  if (!src) return base;

  const cv = document.createElement("canvas");
  cv.width = cell.w; cv.height = cell.h;
  const ctx = cv.getContext("2d");
  if (!ctx) return base;
  ctx.drawImage(src, 0, 0, cell.w, cell.h);

  // 2x2 of the corner colours, upscaled with smoothing = bilinear across the quad
  const g = document.createElement("canvas");
  g.width = 2; g.height = 2;
  const gc = g.getContext("2d");
  if (!gc) return base;
  const at = (i: number) => cs[Math.min(i, cs.length - 1)];
  const put = (x: number, y: number, c: number[]) => {
    gc.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    gc.fillRect(x, y, 1, 1);
  };
  // corner order is column major: top-left, bottom-left, top-right, bottom-right
  put(0, 0, at(0)); put(0, 1, at(1)); put(1, 0, at(2)); put(1, 1, at(3));

  ctx.globalCompositeOperation = "multiply";
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(g, 0, 0, 2, 2, 0, 0, cell.w, cell.h);
  ctx.globalCompositeOperation = "source-over";

  const tex = Texture.from(cv);
  gradientCache.set(key, tex);
  return tex;
}

const blendOf = (bl?: number): "add" | "multiply" | "normal" =>
  bl === 2 ? "add" : bl === 1 ? "multiply" : "normal";

export default function AnimSSPlayerGL({
  effectId, size = 320, layer,
}: { effectId: number; size?: number; layer?: "back" | "front" }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let disposed = false;
    let app: Application | null = null;
    let raf = 0;

    (async () => {
      const doc = await loadDoc(effectId);
      if (disposed || !doc || !hostRef.current) return;

      app = new Application();
      await app.init({ width: size, height: size, backgroundAlpha: 0, antialias: true });
      if (disposed) { app.destroy(true); return; }
      app.canvas.style.width = "100%";
      app.canvas.style.height = "100%";
      app.canvas.style.objectFit = "contain";
      hostRef.current.appendChild(app.canvas);

      // canvas(320) -> px 로 스케일하고 중앙 원점
      // AnimSS is y-up and its canvas is not stretched to the card edges, so
      // scale below 1:1 and drop the origin onto the player's body.
      // Positions are authored against the animation stage; the clip "canvas"
      // is a constant 320x320 in every effect and is not the reference frame.
      const ref = doc.stageW || doc.canvasW;
      const s = (size / ref) * CANVAS_FILL;
      const stage = new Container();
      stage.position.set(size / 2, size * ORIGIN_Y);
      stage.scale.set(s);
      app.stage.addChild(stage);

      // (선택) back/front 한 레이어만 렌더
      const visibleParts = layer ? doc.parts.map(p => p.role === layer) : doc.parts.map(() => true);

      // 유니크 셀 텍스처 프리로드(누락 파일은 조용히 스킵)
      const files = new Set<string>();
      doc.parts.forEach((p, i) => {
        if (!visibleParts[i]) return;
        if (p.c) files.add(p.c.file);
        if (p.cells) for (const c of p.cells) files.add(c.file);
      });
      const loaded = new Set<string>();
      await Promise.all([...files].map(f =>
        Assets.load(`/effects/sprites/${f}.png`).then(() => { loaded.add(f); }).catch(() => null)));
      if (disposed) { app.destroy(true); return; }

      // 파트별 스프라이트 생성(정적 셀). 플립북/틴트/블렌드 지정.
      const sprites: (Sprite | null)[] = doc.parts.map((part, i) => {
        if (!visibleParts[i]) return null;
        const cell = part.c ?? part.cells?.[0];
        if (!cell || !loaded.has(cell.file)) return null;
        const tex = part.v && part.v.blend !== 0
          ? cornerGradientTexture(cell, part.v)
          : Texture.from(`/effects/sprites/${cell.file}.png`);
        const sp = new Sprite(tex);
        sp.anchor.set(0.5);
        sp.blendMode = blendOf(part.bl);
        sp.tint = tintOf(part);
        sp.visible = false;
        stage.addChild(sp);
        return sp;
      });

      const world: World[] = new Array(doc.parts.length);
      const start = performance.now();
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

      const draw = () => {
        const frame = reduce ? 0 : ((performance.now() - start) / 1000 * doc.fps) % doc.frames;
        solve(doc, frame, world);
        for (let i = 0; i < doc.parts.length; i += 1) {
          const sp = sprites[i]; if (!sp) continue;
          const part = doc.parts[i]; const w = world[i];
          if (!w || w.hidden || w.alpha <= 0.01) { sp.visible = false; continue; }
          let cell = part.c!;
          if (part.cells && part.ct) {
            const ci = sampleStep(part.ct as unknown as Track, frame + w.off, 0);
            const idx = Math.max(0, Math.min(part.cells.length - 1, Math.round(ci)));
            const next = part.cells[idx];
            if (loaded.has(next.file)) {
              cell = next;
              const tex = part.v && part.v.blend !== 0
                ? cornerGradientTexture(cell, part.v)
                : Texture.from(`/effects/sprites/${cell.file}.png`);
              if (sp.texture !== tex) sp.texture = tex;
            }
          }
          sp.visible = true;
          sp.alpha = Math.min(1, w.alpha);
          sp.zIndex = 100 + Math.round(w.prio);
          // 피벗을 매트릭스 뒤에 곱해 posX/Y 에 반영(DOM translate(px%,py%) 과 동일)
          const ox = cell.px * cell.w, oy = cell.py * cell.h;
          // AnimSS is y-up; mirror the frame (not the texture) by negating the
          // y row of the matrix and the y translation.
          const posX = w.e + (w.a * ox + w.c * oy);
          const posY = -(w.f + (w.b * ox + w.d * oy));
          sp.setFromMatrix(new Matrix(w.a, -w.b, -w.c, w.d, posX, posY));
        }
        stage.sortChildren();
        raf = requestAnimationFrame(draw);
      };
      stage.sortableChildren = true;
      raf = requestAnimationFrame(draw);
    })();

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      if (app) app.destroy(true);
    };
  }, [effectId, size]);

  return <div ref={hostRef} className="fx-gl" aria-hidden="true"
    style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }} />;
}
