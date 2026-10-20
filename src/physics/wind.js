// 4.5 風・大気・乱気流モデル
//   w(x,y,z,t) = V_ref * (h / h_ref)^p + n_turb(x,y,z,t)
// spec では高さを z と書いているが、本実装の座標系では高さは y (z は射線方向)。
import { createNoise4D } from './simplex.js';
import { deg } from './units.js';

// simplex noise の標準偏差は約 0.25〜0.3 なので、強度 sigma [m/s] が標準偏差になるよう正規化する
const NOISE_STD = 0.28;

/**
 * @param {object} p
 * @param {number} p.speed       基準高さでの平均風速 [m/s]
 * @param {number} p.directionDeg 風が吹いていく向き。0=追い風(射線方向), 90=左→右, 180=向かい風, 270=右→左
 * @param {number} p.refHeight   風速計の高さ h_ref [m]
 * @param {number} p.shearExp    べき指数 p (平地で約 1/7)
 * @param {number} p.turbulence  乱流強度 (各成分の標準偏差) [m/s]
 * @param {number} p.lengthScale 乱流の空間スケール [m]
 * @param {number} p.timeScale   乱流の時間スケール [s]
 * @param {number} p.seed
 */
export function createWindField(p) {
  const nx = createNoise4D(p.seed * 3 + 1);
  const ny = createNoise4D(p.seed * 3 + 2);
  const nz = createNoise4D(p.seed * 3 + 3);
  const dir = deg(p.directionDeg);
  const ux = Math.sin(dir), uz = Math.cos(dir);
  const L = Math.max(p.lengthScale, 0.1), T = Math.max(p.timeScale, 0.05);
  const k = p.turbulence / NOISE_STD;

  function mean(y) {
    const h = Math.max(y, 0.05);
    const s = p.speed * Math.pow(h / p.refHeight, p.shearExp);
    return [s * ux, 0, s * uz];
  }

  // 乱流は平均風で流される (凍結乱流仮説) ので、座標を平均風で移流させてからノイズを引く
  function turbulence(x, y, z, t) {
    if (p.turbulence <= 0) return [0, 0, 0];
    const m = p.speed;
    const X = (x - m * ux * t) / L, Y = y / L, Z = (z - m * uz * t) / L, W = t / T;
    // 鉛直成分は地表付近で抑えられるので水平の半分程度にする
    return [k * nx(X, Y, Z, W), 0.5 * k * ny(X, Y, Z, W), k * nz(X, Y, Z, W)];
  }

  function at(x, y, z, t) {
    const a = mean(y);
    const b = turbulence(x, y, z, t);
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  }

  return { at, mean, turbulence, params: p };
}

export const calmWind = { at: () => [0, 0, 0], mean: () => [0, 0, 0], turbulence: () => [0, 0, 0] };
