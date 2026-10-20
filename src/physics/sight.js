// 5章 サイト調整: 射手は「目 → サイトピン → 的中心」を一直線に揃える。
// ピンはボウに固定されているので、ピンを上げると (同じ照準を保つために) ボウを下げることになり着弾は下がる。
// → 「当たった方向にピンを動かす」(follow the arrow) が成り立つ。

export const EYE_ABOVE_ARROW = 0.09;   // アンカー時の目と矢の高さの差 [m]

/** 照準時の発射仰角・方位角 [rad] (eyeElev は目から的中心を見た仰角) */
export function aimAngles(sight, eyeElev) {
  return {
    elev: eyeElev - (sight.yMm / 1000 - EYE_ABOVE_ARROW) / sight.radiusM,
    azim: -(sight.xMm / 1000) / sight.radiusM,
  };
}

/** 着弾のずれ (dx 右+, dy 上+ [m]) を打ち消すためのピン移動量 [mm] */
export function correctionMm(dx, dy, distance, radiusM) {
  return { xMm: (dx * radiusM / distance) * 1000, yMm: (dy * radiusM / distance) * 1000 };
}

export function applyCorrection(sight, dx, dy, distance, gain = 1) {
  const c = correctionMm(dx, dy, distance, sight.radiusM);
  return { ...sight, xMm: sight.xMm + gain * c.xMm, yMm: sight.yMm + gain * c.yMm };
}

export function groupCenter(impacts) {
  if (!impacts.length) return null;
  const n = impacts.length;
  return {
    dx: impacts.reduce((s, p) => s + p.dx, 0) / n,
    dy: impacts.reduce((s, p) => s + p.dy, 0) / n,
  };
}
