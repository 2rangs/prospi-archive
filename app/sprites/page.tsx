"use client";

import { useEffect, useMemo, useState } from "react";
import { useScrollRestore, useUrlState } from "../useUrlState";

/**
 * 인게임 UI · 배경 스프라이트 도감.
 *
 * tools/extract_ui_sprites.py 가 JP/*.CHK 안의 PNG 를 청크 단위로 잘라
 * public/sprites/<CHK이름>/ 아래에 풀고 index.json 을 남긴다.
 */
type Sheet = {
  source: string; index: number; offset: number;
  w: number; h: number; bytes: number; file: string; md5: string;
};

/** CHK 이름 -> 사람이 읽을 이름. 파일명에서 유추한 것이라 확정은 아니다. */
const LABEL: Record<string, string> = {
  ANSS_COM_BG800: "공용 배경",
  ANSS_COM_BUTTON230: "공용 버튼",
  ANSS_COM_SWITCH1800: "공용 스위치",
  ANSS_MM_MENU_RECOVERY: "메뉴 · 회복",
  ANSS_NY_CHOSHI: "調子 연출",
  ANSS_NY_LOCK: "잠금 연출",
  ANSS_OP_TAP: "오프닝 탭",
  BACKGROUND600: "배경",
  CARD2015S: "2015 카드 틀",
  SELECT2220: "선택 화면",
  TITLE_IPX_1850: "타이틀",
  TMFLAG400: "구단 깃발",
  USERICON1660: "유저 아이콘",
  USERMENU2100: "유저 메뉴",
};

const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

export default function SpritesPage() {
  const [all, setAll] = useState<Sheet[]>([]);
  const [ui, setUi] = useUrlState({ src: "전체", min: 0, q: "", zoom: 1 });
  const [open, setOpen] = useState<Sheet | null>(null);

  useEffect(() => {
    fetch("/sprites/index.json").then(r => r.json()).then(setAll).catch(() => setAll([]));
  }, []);
  useScrollRestore("sprites", all.length > 0);

  // 같은 PNG 가 여러 CHK 에 들어 있는 경우가 있어 md5 로 한 번만 보여 준다
  const uniq = useMemo(() => {
    const seen = new Set<string>();
    return all.filter(s => (seen.has(s.md5) ? false : (seen.add(s.md5), true)));
  }, [all]);

  const sources = useMemo(
    () => ["전체", ...[...new Set(uniq.map(s => s.source))].sort()], [uniq]);

  const shown = useMemo(() => {
    const needle = ui.q.trim().toLowerCase();
    return uniq
      .filter(s => (ui.src === "전체" || s.source === ui.src)
        && Math.max(s.w, s.h) >= ui.min
        && (!needle || s.source.toLowerCase().includes(needle) || `${s.w}x${s.h}`.includes(needle)))
      .sort((a, b) => b.w * b.h - a.w * a.h);
  }, [uniq, ui.src, ui.min, ui.q]);

  const bytes = shown.reduce((n, s) => n + s.bytes, 0);

  return <main>
    <header className="topbar">
      <a className="brand" href="/"><span className="brand-glyph">P</span><span>PROSPI<br/><b>PLAYER DATA</b></span></a>
      <nav><a href="/">선수 목록</a><a href="/effects">원본 효과</a><a className="active" href="/sprites">스프라이트</a></nav>
    </header>

    <section className="sprite-head">
      <p className="eyebrow">IN-GAME SPRITE SHEETS</p>
      <h2>{uniq.length}장의 원본 시트</h2>
      <p>앱이 내려받는 <code>JP/*.CHK</code> 안의 PNG 를 청크 단위로 잘라 냈습니다.
      같은 그림이 여러 CHK 에 중복되는 경우가 있어 md5 로 한 번만 보여 줍니다.
      RES*.RDB(177 MB)에는 PNG 시그니처가 하나도 없어 별도 아카이브로 보입니다.</p>
      <div className="sprite-filter">
        <label>출처<select value={ui.src} onChange={e => setUi({ src: e.target.value })}>
          {sources.map(s => <option key={s} value={s}>{s === "전체" ? "전체" : `${LABEL[s] ?? s} (${s})`}</option>)}
        </select></label>
        <label>최소 크기<select value={ui.min} onChange={e => setUi({ min: Number(e.target.value) })}>
          {[0, 64, 128, 256, 512, 1024].map(n => <option key={n} value={n}>{n ? `${n}px 이상` : "전체"}</option>)}
        </select></label>
        <label>표시 배율<select value={ui.zoom} onChange={e => setUi({ zoom: Number(e.target.value) })}>
          {[1, 2, 4].map(n => <option key={n} value={n}>{n}×</option>)}
        </select></label>
        <span className="sprite-count">{shown.length}장 · {kb(bytes)}</span>
      </div>
    </section>

    <section className="sprite-grid">
      {shown.map(s => (
        <button key={s.md5} className="sprite-cell" onClick={() => setOpen(s)}
                style={{ ["--zoom" as string]: ui.zoom }}>
          <span className="sprite-box"><img loading="lazy" decoding="async" src={`/sprites/${s.file}`} alt=""/></span>
          <b>{s.w}×{s.h}</b>
          <small>{LABEL[s.source] ?? s.source} · {kb(s.bytes)}</small>
        </button>
      ))}
      {all.length > 0 && shown.length === 0 && <p className="empty">조건에 맞는 시트가 없습니다.</p>}
    </section>

    {open && <div className="sprite-modal" role="dialog" onClick={() => setOpen(null)}>
      <div onClick={e => e.stopPropagation()}>
        <span className="sprite-box big"><img src={`/sprites/${open.file}`} alt=""/></span>
        <dl>
          <div><dt>출처</dt><dd>{LABEL[open.source] ?? open.source} <code>{open.source}.CHK</code></dd></div>
          <div><dt>크기</dt><dd>{open.w}×{open.h} · {kb(open.bytes)}</dd></div>
          <div><dt>파일 안 위치</dt><dd>0x{open.offset.toString(16)} (#{open.index})</dd></div>
          <div><dt>경로</dt><dd><a href={`/sprites/${open.file}`} target="_blank" rel="noreferrer">{open.file}</a></dd></div>
        </dl>
        <button onClick={() => setOpen(null)}>닫기</button>
      </div>
    </div>}
  </main>;
}
