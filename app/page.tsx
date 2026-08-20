"use client";

import { useMemo, useState } from "react";

type Player = { id:string; name:string; reading:string; team:string; role:string; year:number; image:string; large:string; source:string; largeSource:string; md5:string; accent:string };
const players:Player[] = [
  {id:"151120265",name:"武田 翔太",reading:"TAKEDA SHOTA",team:"ソフトバンク",role:"投手",year:2015,image:"/players/takeda-shota.png",large:"/players/large/takeda-shota.png",source:"CS151120265.CHK",largeSource:"CL151120265.CHK",md5:"e18c69139e0001e846b8ce8a7ffb6a4b",accent:"#f3c600"},
  {id:"151100075",name:"西 勇輝",reading:"NISHI YUKI",team:"オリックス",role:"投手",year:2015,image:"/players/nishi-yuki.png",large:"/players/large/nishi-yuki.png",source:"CS151100075.CHK",largeSource:"CL151100075.CHK",md5:"0cb05981aab30c4205e0c2d5ab43b373",accent:"#b69758"},
  {id:"151090115",name:"炭谷 銀仁朗",reading:"SUMITANI GINJIRO",team:"西武",role:"捕手",year:2015,image:"/players/sumitani-ginjiro.png",large:"/players/large/sumitani-ginjiro.png",source:"CS151090115.CHK",largeSource:"CL151090115.CHK",md5:"85b60d5025707e069e850df1e44dafe1",accent:"#61a5d8"},
  {id:"151080125",name:"中島 卓也",reading:"NAKAJIMA TAKUYA",team:"日本ハム",role:"内野手",year:2015,image:"/players/nakajima-takuya.png",large:"/players/large/nakajima-takuya.png",source:"CS151080125.CHK",largeSource:"CL151080125.CHK",md5:"462cae77752aea8e367945e70d4458fb",accent:"#4fa3df"},
];
const teams=["すべて",...Array.from(new Set(players.map(p=>p.team)))];

function PlayerCard({player,onOpen}:{player:Player;onOpen:()=>void}){return <article className="player-card" onClick={onOpen} style={{"--accent":player.accent} as React.CSSProperties}>
  <div className="photo-wrap"><div className="series-pill">{player.year} SERIES</div><img src={player.image} alt={`${player.name} 추출 이미지`}/><span className="verified-badge"><span>✓</span> 원본 검증</span></div>
  <div className="card-body"><div className="identity"><div><p className="reading">{player.reading}</p><h2>{player.name}</h2></div><div className="team-mark">{player.team.slice(0,1)}</div></div>
  <div className="meta-row"><span>{player.team}</span><i/><span>{player.role}</span><i/><span>ID {player.id}</span></div>
  <div className="source-row"><span className="source-dot"/><div><small>APP RESOURCE</small><strong>{player.source}</strong></div><button onClick={onOpen} aria-label={`${player.name} 상세 보기`}>→</button></div></div>
</article>}

export default function Home(){const[query,setQuery]=useState("");const[team,setTeam]=useState("すべて");const[view,setView]=useState<"grid"|"list">("grid");const[selected,setSelected]=useState<Player|null>(null);
 const filtered=useMemo(()=>players.filter(p=>`${p.name}${p.reading}${p.id}`.toLowerCase().includes(query.toLowerCase())&&(team==="すべて"||p.team===team)),[query,team]);
 return <main>
  <header className="topbar"><a className="brand" href="#"><span className="brand-glyph">P</span><span>PROSPI<br/><b>ARCHIVE</b></span></a><nav><a className="active" href="#players">선수</a><a href="#updates">검증</a><a href="#updates">업데이트</a></nav><div className="live"><span/> APP DATA · LIVE</div></header>
  <section className="hero" id="players"><div><p className="eyebrow">PROFESSIONAL BASEBALL SPIRITS A</p><h1>선수를 찾는 가장<br/><em>정확한 방법.</em></h1><p className="hero-copy">앱에서 직접 추출한 이미지와 선수 데이터를 연결한<br/>검증 가능한 프로스피A 아카이브.</p></div><div className="hero-stats"><div><strong>2,821</strong><span>선수 데이터</span></div><div><strong>15,294</strong><span>이미지 리소스</span></div><div><strong>4</strong><span>현재 원본 검증</span></div></div></section>
  <section className="finder"><div className="searchbox"><span>⌕</span><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="선수명 또는 이미지 ID 검색" aria-label="선수 검색"/><kbd>⌘ K</kbd></div><div className="filter-row"><div className="chips" aria-label="구단 필터">{teams.map(item=><button key={item} onClick={()=>setTeam(item)} className={team===item?"selected":""}>{item}</button>)}</div><div className="view-toggle"><button className={view==="grid"?"selected":""} onClick={()=>setView("grid")} aria-label="그리드 보기">▦</button><button className={view==="list"?"selected":""} onClick={()=>setView("list")} aria-label="목록 보기">☷</button></div></div></section>
  <section className="results-head"><div><span className="section-index">01</span><h2>검증된 선수 이미지</h2><span className="count">{filtered.length}</span></div><p><span className="green-dot"/> CHK 원본과 매니페스트 해시 일치</p></section>
  <section className={`player-grid ${view==="list"?"list-view":""}`}>{filtered.map(player=><PlayerCard player={player} onOpen={()=>setSelected(player)} key={player.id}/>)}{!filtered.length&&<div className="empty">검색 조건에 맞는 선수가 없습니다.</div>}</section>
  {selected&&<div className="modal-backdrop" onClick={()=>setSelected(null)} role="presentation"><section className="detail-modal" onClick={e=>e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`${selected.name} 상세`}>
    <button className="modal-close" onClick={()=>setSelected(null)} aria-label="상세 닫기">×</button>
    <div className="detail-art" style={{"--accent":selected.accent} as React.CSSProperties}><span className="detail-series">{selected.year} SERIES</span><img src={selected.large} alt={`${selected.name} 앱 추출 대형 원본`}/><span className="image-size">512 × 1024 · PHOTO</span></div>
    <div className="detail-info"><p className="eyebrow">VERIFIED PLAYER RECORD</p><p className="reading">{selected.reading}</p><h2>{selected.name}</h2><div className="detail-tags"><span>{selected.team}</span><span>{selected.role}</span><span>{selected.year}</span></div>
      <div className="match-score"><div><span>매칭 신뢰도</span><strong>검증 완료</strong></div><b>100%</b></div>
      <dl><div><dt>IMAGE ID</dt><dd>{selected.id}</dd></div><div><dt>THUMBNAIL</dt><dd>{selected.source}</dd></div><div><dt>LARGE PHOTO</dt><dd>{selected.largeSource}</dd></div><div><dt>MANIFEST MD5</dt><dd>{selected.md5}</dd></div></dl>
      <div className="proof"><span>✓</span><p><strong>앱 원본 확인</strong><br/>CS와 CL 리소스가 동일 인물을 가리키고 매니페스트 해시가 일치합니다.</p></div>
    </div>
  </section></div>}
  <section className="pipeline" id="updates"><div><span className="section-index">02</span><h2>데이터 신뢰도</h2></div><div className="pipeline-grid"><div><b>1</b><span>앱 다운로드</span><p>공식 게임 클라이언트가 받은 원본 CHK만 수집</p></div><div><b>2</b><span>해시 검증</span><p>매니페스트 MD5와 파일을 자동 대조</p></div><div><b>3</b><span>선수 매칭</span><p>이미지·카드·선수 ID를 교차 검증</p></div><div><b>4</b><span>도감 반영</span><p>검증을 통과한 데이터만 공개</p></div></div></section>
  <footer><div className="brand mini"><span className="brand-glyph">P</span><span>PROSPI <b>ARCHIVE</b></span></div><p>Unofficial data archive · Extracted from locally owned app resources</p><span>DATA BUILD 2026.08.20</span></footer>
 </main>}
