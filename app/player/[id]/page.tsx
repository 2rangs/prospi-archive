"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

type Ability = { meetR: number; meetL: number; power: number; run: number };
type Defense = { catching: number; throwing: number; shoulder: number; version: number };
type Pitch = { direction: number; arrow: string; kind: number; name: string; power: number; level: number; speed: number };
type Pitching = { maxSpeed: number; stamina: number; pitches: Pitch[] };
type Card = {
  id: string; playerId: string; name: string; roman: string; year: number; group: number;
  variant: string; file: string; largeFile: string; verified: boolean; playerType: "batter" | "pitcher";
  base: Ability | null; defense: Defense | null; pitching: Pitching | null;
};

const grade = (value: number) => value >= 80 ? "A" : value >= 70 ? "B" : value >= 60 ? "C" : value >= 50 ? "D" : value >= 40 ? "E" : "F";
const meet = (card: Card) => card.base ? Math.round((card.base.meetR + card.base.meetL) / 2) : undefined;
const maxPitchPower = (card: Card) => card.pitching?.pitches.reduce((best, pitch) => Math.max(best, pitch.power), 0);
const imageUrl = (card: Card) => `/api/card-image?group=${card.group}&file=${encodeURIComponent(card.largeFile)}`;

function Stat({ label, value, suffix = "" }: { label: string; value?: number; suffix?: string }) {
  return <div className="stat"><span>{label}</span><strong>{value == null ? "—" : `${value}${suffix}`}</strong><b>{value == null || suffix ? "" : grade(value)}</b></div>;
}

function PitchTable({ pitching }: { pitching: Pitching }) {
  return <div className="pitch-table"><div className="pitch-head"><span>방향 / 구종</span><span>구위</span><span>변화량</span><span>구속</span></div>{pitching.pitches.map((pitch, index) => <div className="pitch-row" key={`${pitch.direction}-${pitch.kind}-${index}`}><span><i>{pitch.arrow}</i><strong>{pitch.name || "오리지널"}</strong></span><span className={`rank rank-${grade(pitch.power).toLowerCase()}`}>{grade(pitch.power)}</span><span className="pitch-level">{"■".repeat(pitch.level) || "—"}</span><b>{pitch.speed}km/h</b></div>)}</div>;
}

export default function PlayerPage() {
  const params = useParams<{ id: string }>();
  const [card, setCard] = useState<Card | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    fetch("/data/cards.json").then(response => response.json()).then((cards: Card[]) => {
      const found = cards.find(item => item.id === params.id);
      if (found) setCard(found); else setMissing(true);
    }).catch(() => setMissing(true));
  }, [params.id]);

  if (!card) return <main className="player-detail-page"><header className="topbar"><Link className="brand" href="/"><span className="brand-glyph">P</span><span>PROSPI<br/><b>PLAYER DATA</b></span></Link></header><div className="detail-state">{missing ? "선수 카드를 찾을 수 없습니다." : "선수 데이터를 불러오는 중…"}<Link href="/">← 목록으로</Link></div></main>;

  return <main className="player-detail-page"><header className="topbar"><Link className="brand" href="/"><span className="brand-glyph">P</span><span>PROSPI<br/><b>PLAYER DATA</b></span></Link><Link className="back-link" href="/">← 선수 목록</Link></header>
    <section className="detail-page">
      <div className="detail-art"><span className="detail-series">{card.year} · {card.playerType === "pitcher" ? "투수" : "타자"} · {card.variant}</span><img src={imageUrl(card)} alt={`${card.name} 대형 카드 원본`}/><span className="image-size">CL · EXTRACTED PNG</span></div>
      <div className="detail-info"><p className="eyebrow">PLAYER DETAIL</p><p className="reading">{card.roman || `IMAGE ${card.id}`}</p><h1>{card.name}</h1><div className="detail-tags"><span>{card.year}</span><span>{card.playerType === "pitcher" ? "투수 카드" : "타자 카드"}</span><span>VAR {card.variant}</span></div>
        {card.playerType === "pitcher" && card.pitching ? <><h3>투수 능력</h3><div className="detail-stats"><Stat label="최고 구속" value={card.pitching.maxSpeed} suffix="km/h"/><Stat label="최고 구위" value={maxPitchPower(card)}/><Stat label="스태미나" value={card.pitching.stamina}/><Stat label="보유 구종" value={card.pitching.pitches.length}/></div><h3>구종</h3><PitchTable pitching={card.pitching}/></> : <><h3>타격 능력</h3><div className="detail-stats"><Stat label="미트" value={meet(card)}/><Stat label="파워" value={card.base?.power}/><Stat label="주력" value={card.base?.run}/></div><h3>수비 능력</h3><div className="detail-stats"><Stat label="포구" value={card.defense?.catching}/><Stat label="송구" value={card.defense?.throwing}/><Stat label="어깨" value={card.defense?.shoulder}/></div></>}
        <dl><div><dt>PLAYER ID</dt><dd>{card.playerId || "2015 구형 이미지 ID"}</dd></div><div><dt>IMAGE ID</dt><dd>{card.id}</dd></div><div><dt>THUMBNAIL</dt><dd>{card.file}</dd></div><div><dt>LARGE PHOTO</dt><dd>{card.largeFile}</dd></div></dl><div className="proof"><span>{card.verified ? "✓" : "△"}</span><p><strong>{card.verified ? "앱 매니페스트 검증 완료" : "CDN 갱신 파일"}</strong><br/>동일 카드 ID의 능력 원장과 CS·CL 이미지를 연결했습니다.</p></div>
      </div>
    </section>
  </main>;
}
