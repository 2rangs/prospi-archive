"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 배너 인물 배치기.
 *
 * 내가 눈으로 못 맞추는 값(위치·크기·반전)을 화면에서 직접 잡고,
 * 그 결과를 CSS 로 복사해 코드에 굳힐 수 있게 한다.
 * `?layout=1` 이 붙었을 때만 조작 UI 가 뜬다 — 평소에는 굳힌 값만 그려진다.
 */
export type Placement = {
  id: string;      // 카드 image id
  x: number;       // 배너 폭 대비 % (좌측 기준, 요소 중심)
  y: number;       // 배너 높이 대비 % (상단 기준, 요소 바닥)
  h: number;       // 배너 높이 대비 % (요소 높이)
  flip: boolean;
  z: number;
};

/** 굳힌 기본 배치. 배치기에서 복사한 값을 여기에 붙인다. */
/**
 * 배너 인물 한 명.
 * 글이 오른쪽 단에 있으므로 인물은 왼쪽에 세우고, 바닥을 살짝 넘겨
 * 판을 벗어나게 둔다. 액자에 가두지 않아야 포스터로 읽힌다.
 * 반전은 쓰지 않는다 — 유니폼 글자와 등번호가 뒤집힌다.
 */
export const HERO_PLACEMENT: Placement[] = [
  { id: "814762700", x: 17, y: 102, h: 104, flip: false, z: 1 },
];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function HeroStage({ src, layout }: {
  src: (id: string) => string;
  layout: boolean;
}) {
  const [items, setItems] = useState<Placement[]>(HERO_PLACEMENT);
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ i: number; dx: number; dy: number } | null>(null);

  const onDown = (i: number) => (e: React.PointerEvent) => {
    if (!layout) return;
    e.preventDefault();
    setSel(i);
    const r = box.current!.getBoundingClientRect();
    const it = items[i];
    drag.current = {
      i,
      dx: e.clientX - (r.left + (it.x / 100) * r.width),
      dy: e.clientY - (r.top + (it.y / 100) * r.height),
    };
  };

  const onMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    if (!d || !box.current) return;
    const r = box.current.getBoundingClientRect();
    setItems(prev => prev.map((it, i) => i !== d.i ? it : {
      ...it,
      x: Math.round(clamp(((e.clientX - d.dx - r.left) / r.width) * 100, -30, 130) * 10) / 10,
      y: Math.round(clamp(((e.clientY - d.dy - r.top) / r.height) * 100, -30, 160) * 10) / 10,
    }));
  }, []);

  useEffect(() => {
    const up = () => { drag.current = null; };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", up);
    };
  }, [onMove]);

  const patch = (p: Partial<Placement>) =>
    setItems(prev => prev.map((it, i) => (i === sel ? { ...it, ...p } : it)));

  const code = "export const HERO_PLACEMENT: Placement[] = [\n"
    + items.map(it => `  { id: "${it.id}", x: ${it.x}, y: ${it.y}, h: ${it.h}, `
      + `flip: ${it.flip}, z: ${it.z} },`).join("\n")
    + "\n];";

  return <>
    <div className="hero-stage" ref={box} aria-hidden
      style={{ position: "absolute", inset: 0, alignSelf: "stretch",
        justifySelf: "stretch", width: "auto", height: "auto" }}>
      {items.map((it, i) => (
        <img key={it.id} src={src(it.id)} alt=""
          className={`hero-card${layout ? " movable" : ""}${layout && sel === i ? " sel" : ""}`}
          onPointerDown={onDown(i)}
          data-depth={it.z === 0 ? "back" : "front"}
          style={{
            left: `${it.x}%`, top: `${it.y}%`, height: `${it.h}%`, zIndex: it.z,
            transform: `translate(-50%,-100%)${it.flip ? " scaleX(-1)" : ""}`,
          }}/>
      ))}
    </div>

    {layout && <div className="hero-layout">
      <div className="hl-tabs">
        {items.map((it, i) =>
          <button key={it.id} className={sel === i ? "on" : ""} onClick={() => setSel(i)}>
            {it.id}
          </button>)}
      </div>
      {[["x", -30, 130, 0.5], ["y", -30, 160, 0.5], ["h", 20, 200, 1]].map(([k, lo, hi, st]) => (
        <label key={k as string}>
          <span>{k as string}</span>
          <input type="range" min={lo as number} max={hi as number} step={st as number}
            value={items[sel][k as "x" | "y" | "h"]}
            onChange={e => patch({ [k as string]: Number(e.target.value) } as Partial<Placement>)}/>
          <b>{items[sel][k as "x" | "y" | "h"]}</b>
        </label>
      ))}
      <div className="hl-row">
        <button onClick={() => patch({ flip: !items[sel].flip })}>
          {items[sel].flip ? "좌우반전 ON" : "좌우반전 OFF"}
        </button>
        <button onClick={() => patch({ z: items[sel].z ? 0 : 1 })}>z {items[sel].z}</button>
        <button onClick={() => setItems(HERO_PLACEMENT)}>초기화</button>
      </div>
      <textarea readOnly value={code} rows={4}/>
      <button className="hl-copy"
        onClick={() => navigator.clipboard?.writeText(code)}>값 복사</button>
      <p>드래그로 옮기고, 슬라이더로 크기를 잡은 뒤 <b>값 복사</b> → 붙여 주시면 코드에 굳힙니다.</p>
    </div>}
  </>;
}
