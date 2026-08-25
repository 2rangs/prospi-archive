"use client";
import { useT } from "./i18n";

/**
 * 탄도(弾道) 표기.
 *
 * [확인된 사실] 게임은 7종을 쓴다 — 사용자가 인게임 아이콘으로 확인해 준 순서:
 *   アーチスト · パワーヒッター · ラインドライブ · 高弾道 · 中弾道 · 低弾道 · グラウンダー
 *   각 아이콘은 **색이 다른 화살표 + 이름**이고 화살 각도가 탄도를 나타낸다.
 * [문제] 우리 원장 표(TRAJECTORY, 1~6)에는 **グラウンダー가 없다**. 실제로
 *   레퍼런스 표기값에는 58장이 그라운더인데 우리 값은 전부 비어 있다. 그 카드들은
 *   카드 마스터 레코드 자체가 없어서(우리 값 None 이 1,302장) 코드를 확인할 수 없다.
 * [처리] 표기값(ref)이 있으면 그것을 쓰고, 없을 때만 원장 값을 쓴다. 우리 값과
 *   ref 가 둘 다 있는 3,727장에서 일치율은 98.8%(불일치 45장)다.
 * [신뢰도] 7종 목록 CONFIRMED(사용자 실측) · 원장 코드 6종 STRONG · 그라운더 코드 UNKNOWN
 */

/** [색, 화살 각도(도, 위가 +)] — 인게임 아이콘에서 읽었다. */
const TRAJECTORY: Record<string, [string, number]> = {
  "アーチスト": ["#e33bb0", 58],
  "パワーヒッター": ["#e0402f", 45],
  "ラインドライブ": ["#7fd23a", 30],
  "高弾道": ["#d8a521", 45],
  "中弾道": ["#f0d02a", 27],
  "低弾道": ["#36a8e0", 0],
  "グラウンダー": ["#3ecde0", -38],
};

export const TRAJECTORY_ORDER = Object.keys(TRAJECTORY);

/** 화살표만. 칩·범례처럼 이름을 따로 쓰는 자리에 쓴다. */
export function TrajArrow({ value, size = 18 }: { value: string; size?: number }) {
  const hit = TRAJECTORY[value];
  if (!hit) return null;
  const [color, deg] = hit;
  return <svg viewBox="0 0 24 24" aria-hidden width={size} height={size}
    style={{ transform: `rotate(${-deg}deg)`, flex: `0 0 ${size}px` }}>
    <path d="M2 15.5 L14 15.5 L14 20 L22 12 L14 4 L14 8.5 L2 8.5 Z"
      fill={color} stroke="rgba(0,0,0,.45)" strokeWidth="1.1" strokeLinejoin="round"/>
  </svg>;
}

export const trajColor = (v: string) => TRAJECTORY[v]?.[0] ?? "#8b93a3";

/** 화살표 + 이름. 표 칸에 그대로 넣는다. */
export function Trajectory({ value }: { value?: string | null }) {
  const { tv } = useT();
  const hit = value ? TRAJECTORY[value] : undefined;
  if (!hit) return <span className="traj-cell" data-label="탄도"><i className="traj-none">—</i></span>;
  const [color, deg] = hit;
  return <span className="traj-cell" data-label="탄도" title={value ?? undefined}>
    <svg viewBox="0 0 24 24" aria-hidden style={{ transform: `rotate(${-deg}deg)` }}>
      <path d="M2 15.5 L14 15.5 L14 20 L22 12 L14 4 L14 8.5 L2 8.5 Z"
        fill={color} stroke="rgba(0,0,0,.45)" strokeWidth="1.1" strokeLinejoin="round"/>
    </svg>
    <b style={{ color }}>{tv(value)}</b>
  </span>;
}
