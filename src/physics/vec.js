// 3次元ベクトル・3x3行列・クォータニオンの最小限のユーティリティ。
// ベクトルは [x, y, z] の配列。座標系: x=右, y=上, z=射線方向(的へ向かう向き)。

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a) => {
  const n = norm(a);
  return n > 0 ? scale(a, 1 / n) : [0, 0, 0];
};
// a + b*s をまとめて計算 (RK4 の中間状態生成用)
export const addScaled = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

export const matVec = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

export function matInverse(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) throw new Error('singular matrix');
  const s = 1 / det;
  return [
    [A * s, -(b * i - c * h) * s, (b * f - c * e) * s],
    [B * s, (a * i - c * g) * s, -(a * f - c * d) * s],
    [C * s, -(a * h - b * g) * s, (a * e - b * d) * s],
  ];
}

// クォータニオンは [w, x, y, z]
export const qMul = (p, q) => [
  p[0] * q[0] - p[1] * q[1] - p[2] * q[2] - p[3] * q[3],
  p[0] * q[1] + p[1] * q[0] + p[2] * q[3] - p[3] * q[2],
  p[0] * q[2] - p[1] * q[3] + p[2] * q[0] + p[3] * q[1],
  p[0] * q[3] + p[1] * q[2] - p[2] * q[1] + p[3] * q[0],
];
export const qNormalize = (q) => {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
};
// ボディ座標のベクトルをワールド座標へ回転
export function qRotate(q, v) {
  const r = qMul(qMul(q, [0, v[0], v[1], v[2]]), [q[0], -q[1], -q[2], -q[3]]);
  return [r[1], r[2], r[3]];
}
// ワールド座標のベクトルをボディ座標へ (逆回転)
export const qRotateInv = (q, v) => qRotate([q[0], -q[1], -q[2], -q[3]], v);

