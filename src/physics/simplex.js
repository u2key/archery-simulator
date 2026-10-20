// 4D Simplex Noise (Stefan Gustavson の参照実装に基づく)。
// 戻り値はおおよそ [-1, 1]。空間 (x,y,z) と時間 t の4次元で連続な乱流場を作るのに使う。
import { mulberry32 } from './random.js';

const F4 = (Math.sqrt(5) - 1) / 4;
const G4 = (5 - Math.sqrt(5)) / 20;

const GRAD4 = new Float64Array([
  0, 1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1,
  0, -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1,
  1, 0, 1, 1, 1, 0, 1, -1, 1, 0, -1, 1, 1, 0, -1, -1,
  -1, 0, 1, 1, -1, 0, 1, -1, -1, 0, -1, 1, -1, 0, -1, -1,
  1, 1, 0, 1, 1, 1, 0, -1, 1, -1, 0, 1, 1, -1, 0, -1,
  -1, 1, 0, 1, -1, 1, 0, -1, -1, -1, 0, 1, -1, -1, 0, -1,
  1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1, 0,
  -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1, 0,
]);

export function createNoise4D(seed = 1) {
  const rand = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const r = Math.floor(rand() * (i + 1));
    const tmp = p[i];
    p[i] = p[r];
    p[r] = tmp;
  }
  const perm = new Uint8Array(512);
  const permMod32 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod32[i] = perm[i] % 32;
  }

  const corner = (gi, x, y, z, w) => {
    let t = 0.6 - x * x - y * y - z * z - w * w;
    if (t < 0) return 0;
    const g = gi * 4;
    t *= t;
    return t * t * (GRAD4[g] * x + GRAD4[g + 1] * y + GRAD4[g + 2] * z + GRAD4[g + 3] * w);
  };

  return function noise4D(x, y, z, w) {
    const s = (x + y + z + w) * F4;
    const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s), l = Math.floor(w + s);
    const t = (i + j + k + l) * G4;
    const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t), w0 = w - (l - t);

    // どの単体 (simplex) に入っているかを座標の大小関係から決める
    let rx = 0, ry = 0, rz = 0, rw = 0;
    if (x0 > y0) rx++; else ry++;
    if (x0 > z0) rx++; else rz++;
    if (x0 > w0) rx++; else rw++;
    if (y0 > z0) ry++; else rz++;
    if (y0 > w0) ry++; else rw++;
    if (z0 > w0) rz++; else rw++;

    const i1 = rx >= 3 ? 1 : 0, j1 = ry >= 3 ? 1 : 0, k1 = rz >= 3 ? 1 : 0, l1 = rw >= 3 ? 1 : 0;
    const i2 = rx >= 2 ? 1 : 0, j2 = ry >= 2 ? 1 : 0, k2 = rz >= 2 ? 1 : 0, l2 = rw >= 2 ? 1 : 0;
    const i3 = rx >= 1 ? 1 : 0, j3 = ry >= 1 ? 1 : 0, k3 = rz >= 1 ? 1 : 0, l3 = rw >= 1 ? 1 : 0;

    const x1 = x0 - i1 + G4, y1 = y0 - j1 + G4, z1 = z0 - k1 + G4, w1 = w0 - l1 + G4;
    const x2 = x0 - i2 + 2 * G4, y2 = y0 - j2 + 2 * G4, z2 = z0 - k2 + 2 * G4, w2 = w0 - l2 + 2 * G4;
    const x3 = x0 - i3 + 3 * G4, y3 = y0 - j3 + 3 * G4, z3 = z0 - k3 + 3 * G4, w3 = w0 - l3 + 3 * G4;
    const x4 = x0 - 1 + 4 * G4, y4 = y0 - 1 + 4 * G4, z4 = z0 - 1 + 4 * G4, w4 = w0 - 1 + 4 * G4;

    const ii = i & 255, jj = j & 255, kk = k & 255, ll = l & 255;
    const gi = (a, b, c, d) => permMod32[ii + a + perm[jj + b + perm[kk + c + perm[ll + d]]]];

    return 27 * (
      corner(gi(0, 0, 0, 0), x0, y0, z0, w0) +
      corner(gi(i1, j1, k1, l1), x1, y1, z1, w1) +
      corner(gi(i2, j2, k2, l2), x2, y2, z2, w2) +
      corner(gi(i3, j3, k3, l3), x3, y3, z3, w3) +
      corner(gi(1, 1, 1, 1), x4, y4, z4, w4)
    );
  };
}
