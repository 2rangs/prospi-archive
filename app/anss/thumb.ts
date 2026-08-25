"use client";

import { Application, Assets, Container, Matrix, Mesh, MeshGeometry, Sprite } from "pixi.js";
import { useEffect, useState } from "react";
import { evaluate } from "./evaluate";
import { cellTexture, cellUrls, flatTint, pixiBlend, prepare, sheetTexture } from "./AnssStage";
import { AnssSize, loadAnssIcon } from "./useAnss";
import { AnssDocument, CARD_ART_H } from "./types";

/**
 * 목록 아이콘 뒤에서 **실제로 재생되는** 이펙트 배경.
 *
 * [문제] 행마다 AnssStage 를 두면 WebGL 컨텍스트가 25개 필요해 브라우저 상한을
 *   넘는다. 정지 프레임 썸네일은 가볍지만 "배경은 다 재생되는 것" 이라는 원본과
 *   다르다.
 * [처리] **캔버스 하나에 타일 아틀라스**를 만든다. 화면에 보이는 이펙트마다
 *   타일 한 칸을 배정하고, 공유 렌더러가 매 프레임 전 타일을 한 번에 그린다.
 *   각 행은 그 캔버스를 CSS 배경으로 깔고 `background-position` 으로 자기
 *   타일만 본다. 컨텍스트는 1개, 드로우콜은 한 번, 재생은 그대로다.
 */
/**
 * 타일 = 소스 이미지 원본 크기(CS 카드 = 128x128). 그 이상으로 키우면
 * 아이콘이 원본보다 커져 흐려진다 — 최대치를 원본에 맞춘다.
 */
const TW = 128, TH = 128;
const COLS = 6, ROWS = 4;      // 최대 24슬롯
const MAX = COLS * ROWS;
const FPS = 24;
/**
 * _S 저작본이 그려지는 좌표 폭. stageW/stageH 는 _L 과 같은 720x1136 이 적혀
 * 있지만 실제로 찍히는 범위는 그 값과 무관하다: 카드 아트 배율(128/660)로
 * 그리면 타일의 0.1~3.5% 만 덮고 실측 사방 24px 에 그친다. 24 / (128/660) ~=
 * 124 이므로 _S 는 **아이콘 픽셀 그대로**, 즉 CS 카드 원본 128px 기준으로
 * 저작돼 있다. 그래서 배율은 타일 크기 / 아이콘 원본 크기다.
 */
const ICON_SRC = 128;

type Slot = { id: number; doc: AnssDocument | null; size: AnssSize; ready: boolean; idx: number };

const slots = new Map<number, Slot>();   // effectId -> slot
const free: number[] = Array.from({ length: MAX }, (_, i) => i);
let app: Application | null = null;
let appP: Promise<Application> | null = null;
let root: Container | null = null;
let raf = 0;
let clock = 0;
let prev = 0;

async function ensureApp() {
  if (appP) return appP;
  const a = new Application();
  appP = a.init({
    width: TW * COLS, height: TH * ROWS,
    backgroundAlpha: 0, antialias: true, resolution: 1, autoDensity: false,
  }).then(() => {
    app = a; root = new Container(); a.stage.addChild(root);
    prev = performance.now();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      clock += Math.min(0.1, (now - prev) / 1000); prev = now;
      draw(clock * FPS);
      blit();
    };
    raf = requestAnimationFrame(tick);
    // 디버그: 패널이 숨겨져 rAF 가 멈춰도 한 프레임 강제로 그린다
    (window as unknown as { __thumbs?: unknown }).__thumbs = {
      step: (f: number) => { draw(f); blit(); },
      slots, sinks, app: a,
    };
    return a;
  });
  return appP;
}

const m = new Matrix();

function draw(frame: number) {
  if (!app || !root) return;
  root.removeChildren().forEach(c => c.destroy());
  for (const s of slots.values()) {
    if (!s.ready || !s.doc) continue;
    const cell = new Container();
    cell.sortableChildren = true;
    const col = s.idx % COLS, row = (s.idx / COLS) | 0;
    // _S 는 아이콘 픽셀 기준, _L 되돌림은 카드 아트 픽셀 기준이다.
    const scale = s.size === "S" ? TH / ICON_SRC : TH / CARD_ART_H;
    cell.position.set(col * TW + TW / 2, row * TH + TH / 2);
    cell.scale.set(scale);
    for (const dr of evaluate(s.doc, frame)) {
      /**
       * 저작본이 쓴 블렌드를 그대로 쓴다.
       * 큰 이펙트(_L)를 아이콘에 줄여 쓸 때는 불투명한 받침판이 사진을 덮어
       * 가산 파츠만 골랐는데, _S 는 아이콘 배경 그 자체라 663개 중 307개가
       * 가산 파츠를 아예 갖고 있지 않다. 골라 그리면 절반이 빈 칸이 된다.
       */
      const bl = pixiBlend(dr.part.bl);
      const tex = cellTexture(dr.cell, dr.vcol, bl === "add");
      if (!tex) continue;
      /**
       * _S 는 _L 을 줄인 파일이 아니라 128px 아이콘용으로 색과 프레임을 이미
       * 구워 둔 별도 저작본이다. 상세용 시트/정점색/좌표 보정을 다시 적용하면
       * 채도가 빠지고 원본과 다른 합성이 된다. _S 는 베이크 셀을 그대로 그리고,
       * _S 가 없어 _L 로 되돌아온 소수의 아이콘만 상세 렌더링 경로를 쓴다.
       */
      const detailedFallback = s.size === "L";
      const wantMesh = detailedFallback && (!!dr.hasUv || !!dr.hasVert);
      const sheetTex = wantMesh && dr.cell.sheet
        ? sheetTexture(dr.cell.sheet, bl === "add") : null;
      const sp = wantMesh
        ? new Mesh({
            geometry: new MeshGeometry({
              positions: new Float32Array(8),
              uvs: new Float32Array(8),
              indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
            }),
            texture: sheetTex ?? tex,
          })
        : new Sprite(tex);
      if (sp instanceof Sprite) sp.anchor.set(0.5);
      if (sp instanceof Mesh) {
        const uv = dr.uv ?? { x: 0, y: 0, sx: 1, sy: 1, rot: 0 };
        const hw = dr.cell.w / 2, hh = dr.cell.h / 2;
        const pos = sp.geometry.getBuffer("aPosition");
        const uvb = sp.geometry.getBuffer("aUV");
        const pd = pos.data as Float32Array;
        const ud = uvb.data as Float32Array;
        const u0 = 0.5 - 0.5 * uv.sx + uv.x, u1 = 0.5 + 0.5 * uv.sx + uv.x;
        const v0 = 0.5 - 0.5 * uv.sy + uv.y, v1 = 0.5 + 0.5 * uv.sy + uv.y;
        const c = dr.cell;
        const useSheet = !!(sheetTex && c.sheet && c.sw && c.sh && c.rw && c.rh);
        const rx = useSheet ? (c.rx ?? 0) / c.sw! : 0;
        const ry = useSheet ? (c.ry ?? 0) / c.sh! : 0;
        const rw = useSheet ? c.rw! / c.sw! : 1;
        const rh = useSheet ? c.rh! / c.sh! : 1;
        const r = uv.rot * Math.PI / 180;
        const cr = Math.cos(r), sr = Math.sin(r);
        const map = (u: number, v: number, i: number) => {
          let cu = u, cv = v;
          if (uv.rot) {
            const du = u - 0.5, dv = v - 0.5;
            cu = 0.5 + du * cr - dv * sr;
            cv = 0.5 + du * sr + dv * cr;
          }
          ud[i] = rx + cu * rw;
          ud[i + 1] = ry + cv * rh;
        };
        const vt = dr.vert;
        pd[0] = -hw + (vt?.[4] ?? 0); pd[1] = -hh - (vt?.[5] ?? 0);
        pd[2] =  hw + (vt?.[6] ?? 0); pd[3] = -hh - (vt?.[7] ?? 0);
        pd[4] =  hw + (vt?.[2] ?? 0); pd[5] =  hh - (vt?.[3] ?? 0);
        pd[6] = -hw + (vt?.[0] ?? 0); pd[7] =  hh - (vt?.[1] ?? 0);
        map(u0, v0, 0); map(u1, v0, 2); map(u1, v1, 4); map(u0, v1, 6);
        pos.update(); uvb.update();
      }
      sp.tint = detailedFallback ? flatTint(dr.vcol) : 0xffffff;
      sp.blendMode = bl;
      sp.alpha = dr.alpha;
      if (detailedFallback) {
        // _L 폴백만 상세 화면과 동일한 y-up → y-down 변환을 한다.
        m.set(dr.a, -dr.b, -dr.c, dr.d, dr.x, -dr.y);
      } else {
        // _S 는 128px 아이콘 좌표로 베이크된 원본 변환을 그대로 쓴다.
        m.set(dr.a, dr.b, dr.c, dr.d, dr.x, dr.y);
      }
      sp.setFromMatrix(m);
      sp.zIndex = dr.prio;
      cell.addChild(sp);
    }
    root.addChild(cell);
  }
  app.render();
}

async function mount(effectId: number) {
  if (slots.has(effectId) || free.length === 0) return;
  const idx = free.shift()!;
  const slot: Slot = { id: effectId, doc: null, size: "S", ready: false, idx };
  slots.set(effectId, slot);
  await ensureApp();
  const got = await loadAnssIcon(effectId);
  if (!got) { slots.delete(effectId); free.push(idx); return; }
  const { doc } = got;
  slot.size = got.size;
  const urls = cellUrls(doc);
  if (urls.length) await Assets.load(urls).catch(() => undefined);
  // _S 는 UV 트랙이 있어도 전체 시트가 아니라 베이크된 아이콘 셀을 그리므로
  // 그 셀까지 캐시에 올려야 한다. 빠지면 캔버스만 있고 배경은 투명해진다.
  await prepare(doc, true);
  slot.doc = doc; slot.ready = true;
}

/**
 * 행 캔버스 등록부. 공유 렌더러가 한 프레임 그린 뒤, 등록된 2D 캔버스마다
 * 자기 타일 구간만 blit 한다. 2D 컨텍스트는 WebGL 컨텍스트 상한과 무관해서
 * 수십 개를 띄워도 안전하다.
 */
const sinks = new Map<number, Set<HTMLCanvasElement>>();

function blit() {
  if (!app) return;
  const src = app.canvas as HTMLCanvasElement;
  for (const [id, set] of sinks) {
    const s = slots.get(id);
    if (!s || !s.ready || set.size === 0) continue;
    const sx = (s.idx % COLS) * TW, sy = ((s.idx / COLS) | 0) * TH;
    for (const cv of set) {
      const g = cv.getContext("2d");
      if (!g) continue;
      if (cv.width !== TW || cv.height !== TH) { cv.width = TW; cv.height = TH; }
      g.clearRect(0, 0, TW, TH);
      g.drawImage(src, sx, sy, TW, TH, 0, 0, TW, TH);
    }
  }
}

/**
 * 행에서 쓰는 훅. 반환된 ref 를 <canvas> 에 걸면 그 캔버스에 이펙트가
 * 계속 재생된다.
 */
export function useEffectTile(effectId: number | null | undefined) {
  const [el, setEl] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (effectId == null || !el) return;
    let set = sinks.get(effectId);
    if (!set) { set = new Set(); sinks.set(effectId, set); }
    set.add(el);
    void mount(effectId);
    return () => {
      const cur = sinks.get(effectId);
      cur?.delete(el);
      if (cur && cur.size === 0) {
        sinks.delete(effectId);
        const s = slots.get(effectId);
        if (s) { slots.delete(effectId); free.push(s.idx); }   // 슬롯 반납
      }
    };
  }, [effectId, el]);
  return setEl;
}

export function stopThumbs() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}
