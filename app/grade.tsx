/**
 * 인게임 등급 표기.
 *
 * [확인된 사실] 경계값은 사용자가 인게임에서 확인해 준 것이다.
 *   G ~19 / F 20~29 / E 30~39 / D 40~49 / C 50~69 / B 70~79 / A 80~89 / S 90~
 *   C 만 20칸으로 넓고 나머지는 10칸이다.
 * [해석] 예전 표(S90/A80/B70/C60/D50/E40/F20/G1)는 D~F 가 한 칸씩 밀려 있었다.
 *   50~59 를 D 로, 40~49 를 E 로, 30~39 를 F 로 잘못 매겼다.
 * 아이콘은 게임 원본 80x80 PNG(public/grade/*.png).
 */
export const GRADES: [number, string][] =
  [[90, "S"], [80, "A"], [70, "B"], [50, "C"], [40, "D"], [30, "E"], [20, "F"], [0, "G"]];

export const grade = (value: number) => GRADES.find(([floor]) => value >= floor)?.[1] ?? "G";

/** 등급 뱃지. size 는 픽셀. */
export function Grade({ value, size }: { value?: number | null; size?: number }) {
  if (value == null) return <em className="grade grade-none" />;
  const g = grade(value);
  return <em className="grade" style={size ? { width: size, height: size } : undefined}>
    <img src={`/grade/${g}.png`} alt={g} width={80} height={80} decoding="async"/>
  </em>;
}

/** SVG 안에서 쓰는 등급 아이콘. */
export function GradeMark({ value, x, y, size }: { value: number; x: number; y: number; size: number }) {
  return <image href={`/grade/${grade(value)}.png`} x={x - size / 2} y={y - size / 2}
    width={size} height={size}/>;
}
