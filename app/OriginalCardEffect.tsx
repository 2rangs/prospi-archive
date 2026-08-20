const EFFECT_IDS: Record<number, number> = {
  1: 101005,
  2: 201005,
  3: 301005,
  4: 401005,
  5: 501005,
  6: 601005,
  7: 701005,
  8: 801005,
  9: 901005,
  10: 1001005,
  11: 1101005,
  12: 1201005,
};

export function effectIdForGroup(group: number) {
  return EFFECT_IDS[group] || EFFECT_IDS[12];
}

export default function OriginalCardEffect({ group, compact = false }: { group: number; compact?: boolean }) {
  const effectId = effectIdForGroup(group);
  return <div className={`original-effect${compact ? " compact" : ""}`} aria-hidden="true" data-effect-id={effectId}>
    <div className="effect-aurora" />
    <img className="effect-layer effect-layer-one" src={`/effects/${effectId}/layer-1.png`} alt="" />
    <img className="effect-layer effect-layer-two" src={`/effects/${effectId}/layer-2.png`} alt="" />
    <img className="effect-layer effect-layer-three" src={`/effects/${effectId}/layer-3.png`} alt="" />
    <div className="effect-flash" />
  </div>;
}
