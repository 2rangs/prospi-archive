"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { isNewCard } from "../newContent";
/** Series/kind come from the label the game engraves into the card art, not from
 *  the scraped ref-stats table - that table only had a series string for 10,354
 *  of 15,445 cards, so a third of the ledger fell out of every filter.
 *  tools/classify_series.py builds this from the art itself. */
type SeriesLabel = {
  half: "S1" | "S2" | null;
  kind: string | null;
  hasKind: boolean;
  /** true when the game engraves no series label on this card at all */
  noLabel?: boolean;
};

type Card = {
  id: number | string;
  name: string;
  roman?: string;
  year?: number;
  group?: number;
  variant?: string;
  file: string;
  largeFile: string;
  playerType?: string;
};

/** Same route the rest of the site uses to serve card art out of the CHK packs. */
const imageUrl = (card: Card, large: boolean) =>
  `/api/card-image?group=${card.group}&file=${encodeURIComponent(large ? card.largeFile : card.file)}&v=2`;

const PAGE = 60;

/** Series 1/2 and the card kind (OB · WS · TS …) both live in the ref-stats
 *  `series` string, so reuse the site's existing parsers rather than re-deriving
 *  them from the variant digits. */
const KIND_TABS = ["OB", "WS", "TS", "Olympic", "SM", "AN", "SL"] as const;

export default function GalleryPage() {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [count, setCount] = useState(PAGE);
  const [query, setQuery] = useState("");
  const [year, setYear] = useState<number | "all">("all");
  // CS files are only 128x128 thumbnails, so show the CL art by default
  const [large, setLarge] = useState(true);
  const [half, setHalf] = useState<"all" | "S1" | "S2" | "none">("all");
  const [kind, setKind] = useState<string>("all");
  const [labels, setLabels] = useState<Record<string, SeriesLabel> | null>(null);

  useEffect(() => {
    fetch("/data/series-labels.json")
      .then((r) => r.json())
      .then(setLabels)
      .catch(() => setLabels({}));
  }, []);
  const sentinel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch("/data/cards.json")
      .then((r) => r.json())
      .then((d) => {
        const list: Card[] = Array.isArray(d) ? d : d.cards ?? [];
        // id descending is newest-first: the 2026 / group-12 cards sort to the top
        list.sort((a, b) => Number(b.id) - Number(a.id));
        setCards(list);
      })
      .catch(() => setCards([]));
  }, []);

  const years = useMemo(() => {
    if (!cards) return [];
    return [...new Set(cards.map((c) => c.year).filter(Boolean) as number[])].sort((a, b) => b - a);
  }, [cards]);

  const meta = useMemo(() => {
    const m = new Map<string, SeriesLabel>();
    if (!cards) return m;
    for (const c of cards) {
      m.set(String(c.id), labels?.[String(c.id)] ?? { half: null, kind: null, hasKind: false });
    }
    return m;
  }, [cards, labels]);

  const filtered = useMemo(() => {
    if (!cards) return [];
    const q = query.trim().toLowerCase();
    return cards.filter((c) => {
      if (year !== "all" && c.year !== year) return false;
      const mm = meta.get(String(c.id));
      if (half === "none") { if (mm?.half) return false; }
      else if (half !== "all" && mm?.half !== half) return false;
      if (kind !== "all") {
        if (kind === "none") { if (mm?.kind) return false; }
        else if (mm?.kind !== kind) return false;
      }
      if (!q) return true;
      return (
        c.name?.toLowerCase().includes(q) ||
        c.roman?.toLowerCase().includes(q) ||
        String(c.id).includes(q)
      );
    });
  }, [cards, query, year, half, kind, meta]);

  // reset paging whenever the filter changes
  useEffect(() => setCount(PAGE), [query, year, half, kind]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setCount((n) => (n < filtered.length ? n + PAGE : n));
      }
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [filtered.length]);

  const shown = filtered.slice(0, count);

  return (
    <div style={{ minHeight: "100vh", background: "#0b0e13", color: "#e6edf3",
                  fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif" }}>
      <header style={{ position: "sticky", top: 0, zIndex: 5, padding: "14px 18px",
                       background: "rgba(11,14,19,.94)", borderBottom: "1px solid #222a33",
                       backdropFilter: "blur(8px)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 17, letterSpacing: .5 }}>선수 이미지 뷰어</strong>
          <span style={{ opacity: .55, fontSize: 12 }}>
            최신순 · 이펙트 없음 · {cards ? `${filtered.length.toLocaleString()}장` : "로딩"}
            {!labels && cards ? " · 라벨 분류 로딩" : ""}
          </span>
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="이름 · 로마자 · ID 검색"
            style={{ padding: "6px 10px", minWidth: 210, borderRadius: 6, fontSize: 13,
                     border: "1px solid #2c3542", background: "#131924", color: "#e6edf3" }} />
          <select value={String(year)}
                  onChange={(e) => setYear(e.target.value === "all" ? "all" : Number(e.target.value))}
                  style={{ padding: "6px 10px", borderRadius: 6, fontSize: 13,
                           border: "1px solid #2c3542", background: "#131924", color: "#e6edf3" }}>
            <option value="all">전체 연도</option>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <div style={{ display: "flex", gap: 4 }}>
            {(["all", "S1", "S2", "none"] as const).map((h) => (
              <button key={h} onClick={() => setHalf(h)}
                style={{ padding: "5px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer",
                         border: "1px solid " + (half === h ? "#58a6ff" : "#2c3542"),
                         background: half === h ? "#1f6feb" : "#131924", color: "#e6edf3" }}>
                {h === "all" ? "S 전체" : h === "S1" ? "Series1"
                  : h === "S2" ? "Series2" : "라벨 없음"}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {(["all", "none", ...KIND_TABS] as const).map((k) => (
              <button key={k} onClick={() => setKind(k)}
                style={{ padding: "5px 9px", fontSize: 12, borderRadius: 6, cursor: "pointer",
                         border: "1px solid " + (kind === k ? "#58a6ff" : "#2c3542"),
                         background: kind === k ? "#1f6feb" : "#131924", color: "#e6edf3" }}>
                {k === "all" ? "종류 전체" : k === "none" ? "기본" : k}
              </button>
            ))}
          </div>
          <label style={{ fontSize: 13, cursor: "pointer", opacity: .85 }}>
            <input type="checkbox" checked={large} onChange={(e) => setLarge(e.target.checked)} /> 대형(CL) · 끄면 128px 썸네일
          </label>
        </div>
      </header>

      {!cards && <p style={{ padding: 24, opacity: .6 }}>cards.json 로딩 중…</p>}
      {cards && !filtered.length && <p style={{ padding: 24, opacity: .6 }}>결과 없음</p>}

      <div style={{ display: "grid", gap: 12, padding: 18,
                    gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))" }}>
        {shown.map((c) => (
          <a key={String(c.id)} href={`/player/${c.id}`}
             style={{ textDecoration: "none", color: "inherit" }}>
            <div style={{ position: "relative", background: "#121722", border: "1px solid #222a33", borderRadius: 8,
                          overflow: "hidden" }}>
              {isNewCard(c.id) && <i className="new-badge gallery-new-badge">NEW!</i>}
              <img src={imageUrl(c, large)} alt={c.name} loading="lazy"
                   style={{ width: "100%", display: "block",
                            aspectRatio: large ? "1 / 2" : "1 / 1",
                            objectFit: "contain",
                            background: "linear-gradient(#141b26,#0d121b)" }} />
              <div style={{ padding: "6px 8px 8px" }}>
                <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
                              overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</div>
                <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 3,
                              flexWrap: "wrap" }}>
                  {meta.get(String(c.id))?.half && (
                    <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 4,
                                   background: "#1d3a5c", color: "#9fd0ff" }}>
                      {meta.get(String(c.id))!.half}
                    </span>
                  )}
                  {meta.get(String(c.id))?.kind && (
                    <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 4,
                                   background: "#4a2f5c", color: "#e0b6ff" }}>
                      {meta.get(String(c.id))!.kind}
                    </span>
                  )}
                  {meta.get(String(c.id))?.noLabel && (
                    <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 4,
                                   background: "#3a3a3a", color: "#b9b9b9" }}>
                      무라벨
                    </span>
                  )}
                  <span style={{ fontSize: 10, opacity: .45 }}>{c.year}</span>
                </div>
                <div style={{ fontSize: 10, opacity: .35, marginTop: 2 }}>{String(c.id)}</div>
              </div>
            </div>
          </a>
        ))}
      </div>
      <div ref={sentinel} style={{ height: 1 }} />
      {shown.length < filtered.length && (
        <p style={{ textAlign: "center", padding: 18, opacity: .5, fontSize: 13 }}>
          {shown.length} / {filtered.length} — 스크롤하면 더 불러옵니다
        </p>
      )}
    </div>
  );
}
