// 4.4 矢の飛翔弾道 (RK4)
//   m dv/dt = F_gravity + F_drag + F_lift + F_magnus
// 揚力が矢の軸 d̂ に依存するため、並進 (r, v) に加えて矢の姿勢 d̂・首振り角速度 ω・自転 p も同時に積分する。
import { G, RHO_AIR } from './units.js';
import { add, sub, scale, dot, cross, norm, normalize, addScaled } from './vec.js';
import { paradoxDeflection } from './arrow.js';

const PARADOX_DRAG = 0.3;   // しなり振幅/外径 の2乗に比例する抗力増加
const ROLL_TAU = 0.15;      // 自転が平衡回転数に近づく時定数 [s]

/**
 * 運動方程式の右辺。
 * spec の揚力式 (d̂×v̂)×v̂ は −d̂⊥ (機首と逆向き) になるため符号を反転し、
 * 機首が向いている側へ働く法線力 v̂×(d̂×v̂) = d̂⊥ として扱う。
 * spec のマグヌス式は長さの次元が1つ足りないので、シャフト半径 r を掛けている。
 */
export function forces(state, t, arrow, wind) {
  const { r, v, d, w: omega, p } = state;
  const vrel = sub(v, wind.at(r[0], r[1], r[2], t));
  const V = norm(vrel);
  const m = arrow.mass;
  const q = 0.5 * RHO_AIR;
  if (V < 1e-9) return { acc: [0, -G, 0], torque: [0, 0, 0], vrel, V, alpha: 0 };
  const vh = scale(vrel, 1 / V);

  const ys = paradoxDeflection(arrow.paradox, t);
  const dragArea = arrow.dragArea * (1 + PARADOX_DRAG * (ys / arrow.d) ** 2);
  const Fdrag = scale(vrel, -q * dragArea * V);

  const axisCross = cross(d, vh);                     // |d×v̂| = sin α
  const Flift = scale(cross(vh, axisCross), q * arrow.normalArea * V * V);
  const Fmagnus = scale(cross(scale(d, p), vrel), q * arrow.cm * arrow.area * arrow.r);
  const F = add(add(Fdrag, Flift), Fmagnus);
  const acc = [F[0] / m, F[1] / m - G, F[2] / m];

  // 重心まわりのモーメント: ベインによる風見安定 (d̂ を v̂ へ向ける) と首振り減衰
  const torque = sub(scale(axisCross, q * arrow.momentArea * V * V), scale(omega, q * arrow.dampArea * V));
  return { acc, torque, vrel, V, alpha: Math.asin(Math.min(1, norm(axisCross))), Fdrag, Flift, Fmagnus };
}

function derivative(state, t, arrow, wind) {
  const f = forces(state, t, arrow, wind);
  let dw = scale(f.torque, 1 / arrow.inertiaT);
  dw = sub(dw, scale(state.d, dot(dw, state.d)));    // 軸方向の成分 (自転) は p で別に扱う
  const pEq = (2 * Math.PI * dot(f.vrel, state.d)) / arrow.spinPitch;
  return {
    r: state.v,
    v: f.acc,
    d: cross(state.w, state.d),
    w: dw,
    p: (pEq - state.p) / ROLL_TAU,
  };
}

function step(s, k, h) {
  return {
    r: addScaled(s.r, k.r, h),
    v: addScaled(s.v, k.v, h),
    d: addScaled(s.d, k.d, h),
    w: addScaled(s.w, k.w, h),
    p: s.p + k.p * h,
  };
}

export function rk4Step(s, t, h, arrow, wind) {
  const k1 = derivative(s, t, arrow, wind);
  const k2 = derivative(step(s, k1, h / 2), t + h / 2, arrow, wind);
  const k3 = derivative(step(s, k2, h / 2), t + h / 2, arrow, wind);
  const k4 = derivative(step(s, k3, h), t + h, arrow, wind);
  const comb = (key) => {
    const out = [0, 0, 0];
    for (let i = 0; i < 3; i++) out[i] = s[key][i] + (h / 6) * (k1[key][i] + 2 * k2[key][i] + 2 * k3[key][i] + k4[key][i]);
    return out;
  };
  const d = normalize(comb('d'));
  let w = comb('w');
  w = sub(w, scale(d, dot(w, d)));
  return { r: comb('r'), v: comb('v'), d, w, p: s.p + (h / 6) * (k1.p + 2 * k2.p + 2 * k3.p + k4.p) };
}

/**
 * 的の平面 z = targetZ に達するまで積分する。
 * @param {object} init { r, v, d } 初期位置・速度・矢の軸
 * @param {object} arrow arrowProperties の結果
 * @param {object} wind  createWindField の結果 (at(x,y,z,t))
 * @param {object} opts  { targetZ, dt, t0, recordEvery }
 */
export function simulateFlight(init, arrow, wind, opts) {
  const dt = opts.dt ?? 0.0005;
  const t0 = opts.t0 ?? 0;          // 風場の時刻 (射撃ごとに進む)
  const recordEvery = opts.recordEvery ?? 0.005;
  let s = { r: [...init.r], v: [...init.v], d: normalize(init.d ?? init.v), w: [0, 0, 0], p: 0 };
  let t = 0;
  const path = [{ t, r: s.r, d: s.d }];
  let nextRec = recordEvery;
  let maxAlpha = 0;
  const windAt = { at: (x, y, z, tt) => wind.at(x, y, z, t0 + tt) };
  // パラドックスの時間は発射からの経過時間なので、風だけ時刻をずらす
  while (t < (opts.tMax ?? 6)) {
    const n = rk4Step(s, t, dt, arrow, windAt);
    const tn = t + dt;
    if (n.r[2] >= opts.targetZ) {
      const f = (opts.targetZ - s.r[2]) / (n.r[2] - s.r[2]);
      const lerp = (a, b) => a.map((x, i) => x + (b[i] - x) * f);
      const hit = { t: t + dt * f, r: lerp(s.r, n.r), v: lerp(s.v, n.v), d: normalize(lerp(s.d, n.d)) };
      path.push({ t: hit.t, r: hit.r, d: hit.d });
      return { reached: true, impact: hit, path, maxAlpha, v0: norm(init.v) };
    }
    if (n.r[1] <= 0) {
      path.push({ t: tn, r: n.r, d: n.d });
      return { reached: false, impact: { t: tn, r: n.r, v: n.v, d: n.d }, path, maxAlpha, v0: norm(init.v) };
    }
    s = n;
    t = tn;
    const a = Math.acos(Math.min(1, Math.abs(dot(s.d, normalize(s.v)))));
    if (a > maxAlpha) maxAlpha = a;
    if (t >= nextRec - 1e-12) {
      path.push({ t, r: s.r, d: s.d });
      nextRec += recordEvery;
    }
  }
  return { reached: false, impact: { t, r: s.r, v: s.v, d: s.d }, path, maxAlpha, v0: norm(init.v) };
}
