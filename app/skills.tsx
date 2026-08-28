"use client";
import { fetchGzipJson } from "./anss/fetchGzip";
import { useEffect, useState } from "react";

/**
 * 특수능력 설명. tools/scrape_skills.py 가 prospi-a.rakda3.net/sp-list 에서 긁는다.
 *
 * [문제] 카드 표기는 `超豪速球` · `キレ・改` · `内角○` 처럼 접두·접미가 붙는데
 *   설명 목록의 키는 기본 이름(`豪速球` · `キレ`)이다. 다만 `内角○` 처럼 ○ 가
 *   이름의 일부인 것도 있어서 무조건 떼면 안 된다.
 * [처리] 원문 → 超 제거 → ・改 제거 → ◎○ 제거 순으로 차례로 찾아본다.
 * [측정] 카드 특능 26,642건 중 26,365건(99%) 매칭. 남는 6종은 표에 없는 항목.
 */
export type Skill = { title: string; kind: string; desc: string; effect: string[] };

let cache: Record<string, Skill> | null | undefined;
const waiters: ((v: Record<string, Skill> | null) => void)[] = [];

/** 예열용 — 훅과 같은 캐시를 채운다. Preload 가 쓴다. */
export function loadSkills(): Promise<Record<string, Skill> | null> {
  if (cache !== undefined) return Promise.resolve(cache);
  return new Promise(resolve => {
    waiters.push(resolve);
    if (waiters.length === 1) {
      void fetchGzipJson<Record<string, Skill>>("/data/skills.json.gz")
        .catch(() => null)
        .then(j => { cache = j; waiters.splice(0).forEach(w => w(j)); });
    }
  });
}

export function useSkills(): Record<string, Skill> | null {
  const [v, setV] = useState<Record<string, Skill> | null>(cache ?? null);
  useEffect(() => {
    if (cache !== undefined) { setV(cache); return; }
    waiters.push(setV);
    if (waiters.length === 1) {
      fetchGzipJson<Record<string, Skill>>("/data/skills.json.gz")
        .catch(() => null)
        .then(j => { cache = j; waiters.splice(0).forEach(w => w(j)); });
    }
  }, []);
  return v;
}

export function findSkill(table: Record<string, Skill> | null, name: string): Skill | null {
  if (!table) return null;
  const tries = [
    name,
    name.replace(/^超/, ""),
    name.replace(/^超/, "").replace(/[・･]?改$/, ""),
    name.replace(/^超/, "").replace(/[・･]?改$/, "").replace(/[◎○●☆★]+$/, ""),
  ];
  for (const t of tries) if (table[t]) return table[t];
  return null;
}

/** 특수능력 목록. 수가 적으므로 이름과 설명을 처음부터 함께 보여준다. */
export function Skills({ names }: { names: string[] }) {
  const table = useSkills();
  if (!names.length) return null;
  return <div className="skill-grid">
    {names.map(n => {
      const s = findSkill(table, n);
      // 아코디언 — 접힌 상태: 이름 한 줄 / 펼치면: 내용 (사용자 지시)
      return <details key={n} className="skill">
        <summary><h4>{n}</h4>{s?.desc && <em className="skill-hint">{s.desc}</em>}</summary>
        {s ? <div className="skill-body">
          {s.desc && <p>{s.desc}</p>}
          {s.effect.length > 0 && <ul>{s.effect.map((e, i) => <li key={i}>{e.replace(/^・/, "")}</li>)}</ul>}
        </div> : null}
      </details>;
    })}
  </div>;
}
