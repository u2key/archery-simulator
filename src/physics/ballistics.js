// 4.4 矢の飛翔弾道 (RK4)
//   m dv/dt = F_gravity + F_drag + F_lift + F_magnus
// 揚力が矢の軸 d̂ に依存するため、並進 (r, v) に加えて矢の姿勢 d̂・首振り角速度 ω・自転 p も同時に積分する。
import { G } from './units.js';
import { STANDARD_AIR } from './atmosphere.js';
import { add, sub, scale, dot, cross, norm, normalize, addScaled } from './vec.js';
import { paradoxDeflection } from './arrow.js';

const PARADOX_DRAG = 0.3;   // しなり振幅/外径 の2乗に比例する抗力増加

/**
 * 運動方程式の右辺。
 * spec の揚力式 (d̂×v̂)×v̂ は −d̂⊥ (機首と逆向き) になるため符号を反転し、
 * 機首が向いている側へ働く法線力 v̂×(d̂×v̂) = d̂⊥ として扱う。
 * spec のマグヌス式は長さの次元が1つ足りないので、シャフト半径 r を掛けている。
 * env: { rho 空気密度, nu 動粘性係数, g 重力加速度, coriolis (v → 加速度) }。省略時は標準大気・標準重力
 */
export function forces(state, t, arrow, wind, env = {}) {
  const { r, v, d, w: omega, p } = state;
  const vrel = sub(v, wind.at(r[0], r[1], r[2], t));
  const V = norm(vrel);
  const m = arrow.mass;
  const q = 0.5 * (env.rho ?? STANDARD_AIR.rho);
  const g = env.g ?? G;
  const ac = env.coriolis ? env.coriolis(v) : [0, 0, 0];
  if (V < 1e-9) return { acc: [ac[0], ac[1] - g, ac[2]], torque: [0, 0, 0], vrel, V, alpha: 0 };
  const vh = scale(vrel, 1 / V);

  // 抗力係数はレイノルズ数 (直径基準) で変わる (境界層の層流 ↔ 乱流)
  const Re = (V * arrow.d) / (env.nu ?? STANDARD_AIR.nu);
  const ys = paradoxDeflection(arrow.paradox, t);
  const baseDragArea = arrow.dragAreaAt ? arrow.dragAreaAt(Re) : arrow.dragArea;
  const dragArea = baseDragArea * (1 + PARADOX_DRAG * (ys / arrow.d) ** 2);
  const Fdrag = scale(vrel, -q * dragArea * V);

  const axisCross = cross(d, vh);                     // |d×v̂| = sin α
  const sinA = norm(axisCross);
  // 法線力: 線形 (ベイン + 細長体) + 横流れ (sin²α)
  const Flift = scale(cross(vh, axisCross), q * (arrow.normalArea + (arrow.crossArea ?? 0) * sinA) * V * V);
  const Fmagnus = scale(cross(scale(d, p), vrel), q * arrow.cm * arrow.area * arrow.r);
  const F = add(add(Fdrag, Flift), Fmagnus);
  const acc = [F[0] / m + ac[0], F[1] / m - g + ac[1], F[2] / m + ac[2]];

  // 重心まわりのモーメント: ベインによる風見安定 (d̂ を v̂ へ向ける) と首振り減衰
  const torque = sub(scale(axisCross, q * (arrow.momentArea + (arrow.crossMomentArea ?? 0) * sinA) * V * V), scale(omega, q * arrow.dampArea * V));
  return { acc, torque, vrel, V, Re, q, alpha: Math.asin(Math.min(1, sinA)), Fdrag, Flift, Fmagnus };
}

function derivative(state, t, arrow, wind, env) {
  const f = forces(state, t, arrow, wind, env);
  let dw = scale(f.torque, 1 / arrow.inertiaT);
  dw = sub(dw, scale(state.d, dot(dw, state.d)));    // 軸方向の成分 (自転) は p で別に扱う
  // 自転: ベインのカント角で決まる平衡回転数へ、ロール減衰 (½ρV · C_Lα S r_v² · 3) と軸まわりの慣性で決まる時定数で近づく
  const pEq = (2 * Math.PI * dot(f.vrel, state.d)) / arrow.spinPitch;
  const rollTau = arrow.rollInertia && arrow.rollDampArea ? arrow.rollInertia / Math.max(1e-12, f.q * f.V * arrow.rollDampArea) : 0.15;
  return {
    r: state.v,
    v: f.acc,
    d: cross(state.w, state.d),
    w: dw,
    p: (pEq - state.p) / Math.max(rollTau, 1e-4),
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

export function rk4Step(s, t, h, arrow, wind, env) {
  const k1 = derivative(s, t, arrow, wind, env);
  const k2 = derivative(step(s, k1, h / 2), t + h / 2, arrow, wind, env);
  const k3 = derivative(step(s, k2, h / 2), t + h / 2, arrow, wind, env);
  const k4 = derivative(step(s, k3, h), t + h, arrow, wind, env);
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
 * @param {object} opts  { targetZ, dt, t0, recordEvery, env }  env は forces() を参照
 */
export function simulateFlight(init, arrow, wind, opts) {
  const dt = opts.dt ?? 0.0005;
  const t0 = opts.t0 ?? 0;          // 風場の時刻 (射撃ごとに進む)
  const recordEvery = opts.recordEvery ?? 0.005;
  let s = { r: [...init.r], v: [...init.v], d: normalize(init.d ?? init.v), w: init.w ? [...init.w] : [0, 0, 0], p: 0 };
  let t = 0;
  const path = [{ t, r: s.r, d: s.d }];
  let nextRec = recordEvery;
  let maxAlpha = 0;
  const windAt = { at: (x, y, z, tt) => wind.at(x, y, z, t0 + tt) };
  // パラドックスの時間は発射からの経過時間なので、風だけ時刻をずらす
  while (t < (opts.tMax ?? 6)) {
    const n = rk4Step(s, t, dt, arrow, windAt, opts.env);
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
