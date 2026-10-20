// 3.1 / 3.2 / 3.3 / 4.1 / 4.2: 引き尺・実効ポンド・初速、ボウの慣性テンソルとリリース後の回転運動。
import { LBF, INCH, OZ, G, deg } from './units.js';
import { add, scale, cross, matVec, matInverse, qMul, qNormalize, qRotate, qRotateInv } from './vec.js';

// 3.1: 引き尺 L_draw ≈ 身長 × 0.38 / 2.54 [inch]
export function drawLengthFromHeight(heightCm) {
  return (heightCm * 0.38) / 2.54;
}

export function drawLengthIn(player) {
  return player.drawLengthIn ?? drawLengthFromHeight(player.heightCm);
}

// 実効ポンド: リムを線形バネとみなし、ブレースハイト位置を 0 として表示ポンド(28")から比例させる。
// この仮定のもとで spec 4.1 の E = 1/2 · F · (L_draw − Brace) が厳密な蓄積エネルギーになる。
export function effectiveLbs(bow, drawIn) {
  const stroke = drawIn - bow.braceIn;
  if (stroke <= 0) return 0;
  return (bow.markedLbs * stroke) / (28 - bow.braceIn);
}

// 4.1: 蓄積エネルギー [J]
export function storedEnergy(bow, drawIn) {
  const F = effectiveLbs(bow, drawIn) * LBF;
  const stroke = (drawIn - bow.braceIn) * INCH;
  return Math.max(0, 0.5 * F * stroke);
}

// 4.1: v0 = sqrt(2 η E / (m_arrow + m_eff))。restLoss はレスト摩擦によるエネルギー損失率。
export function launchSpeed(bow, drawIn, arrowMassKg, restLoss = 0) {
  const E = storedEnergy(bow, drawIn) * (1 - restLoss);
  return Math.sqrt((2 * bow.eta * E) / (arrowMassKg + bow.effMassG / 1000));
}

// ---- 4.2: パーツ構成 → 質点群 → 慣性テンソル ----
// ボウ座標系: 原点=グリップのピボット, x=右, y=上, z=的方向。右利き射手を想定。

const SPACER_G_PER_IN = 14;   // スペーサー (ステンレス) の線密度
const DAMPER_G = 25;
const VBAR_MOUNT = [0, -0.085, 0.045];

function segment(points, a, b, mass, n) {
  for (let i = 0; i < n; i++) {
    const s = (i + 0.5) / n;
    points.push({ m: mass / n, r: [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s] });
  }
}

function rod(points, parts, name, origin, dir, rodCfg, stab) {
  const len = (rodCfg.lengthIn + rodCfg.spacerIn) * INCH;
  const tip = add(origin, scale(dir, len));
  const rodMass = (stab.rodGPerIn * rodCfg.lengthIn + SPACER_G_PER_IN * rodCfg.spacerIn) / 1000;
  segment(points, origin, tip, rodMass, 8);
  if (rodCfg.damper) points.push({ m: DAMPER_G / 1000, r: add(origin, scale(dir, len * 0.92)) });
  points.push({ m: rodCfg.tipOz * OZ, r: tip });
  parts.push({ name, from: origin, to: tip, tipOz: rodCfg.tipOz, damper: rodCfg.damper });
}

export function sideRodDirection(side, sign) {
  const h = deg(side.spreadDeg), v = deg(side.dropDeg);
  return [sign * Math.sin(h) * Math.cos(v), -Math.sin(v), -Math.cos(h) * Math.cos(v)];
}

export function bowMassModel(bow, stab) {
  const points = [];
  const parts = [];
  segment(points, [0, -0.3, 0.01], [0, 0.3, 0.01], bow.riserMassG / 1000, 10);
  segment(points, [0, 0.3, 0.01], [0, 0.84, -0.06], bow.limbMassG / 1000, 6);
  segment(points, [0, -0.3, 0.01], [0, -0.84, -0.06], bow.limbMassG / 1000, 6);
  points.push({ m: bow.sightMassG / 1000, r: [-0.035, 0.13, 0.25] });

  const c = stab.center;
  if (c.lengthIn > 0) {
    const a = deg(c.angleDeg);
    rod(points, parts, 'center', VBAR_MOUNT, [0, -Math.sin(a), Math.cos(a)], c, stab);
  }
  if (stab.side.count > 0) {
    points.push({ m: stab.vbarMassG / 1000, r: add(VBAR_MOUNT, [0, 0, -0.02]) });
    const signs = stab.side.count >= 2 ? [-1, 1] : [1];
    for (const sgn of signs) {
      rod(points, parts, sgn < 0 ? 'sideL' : 'sideR', add(VBAR_MOUNT, [0, 0, -0.02]), sideRodDirection(stab.side, sgn), stab.side, stab);
    }
  }

  const mass = points.reduce((s, p) => s + p.m, 0);
  const cg = scale(points.reduce((s, p) => add(s, scale(p.r, p.m)), [0, 0, 0]), 1 / mass);
  return { points, parts, mass, cg };
}

// spec 4.2 の式そのまま: I = Σ m_i [[y²+z², −xy, −xz], [−xy, x²+z², −yz], [−xz, −yz, x²+y²]]
export function inertiaTensor(points) {
  const I = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const { m, r: [x, y, z] } of points) {
    I[0][0] += m * (y * y + z * z);
    I[1][1] += m * (x * x + z * z);
    I[2][2] += m * (x * x + y * y);
    I[0][1] -= m * x * y;
    I[0][2] -= m * x * z;
    I[1][2] -= m * y * z;
  }
  I[1][0] = I[0][1];
  I[2][0] = I[0][2];
  I[2][1] = I[1][2];
  return I;
}

// 減衰係数 c_damp [N·m·s/rad]: 手・構造による基礎減衰 + ダンパー1個ごとの追加分
export function dampingCoefficient(stab) {
  let c = 0.4;
  if (stab.center.lengthIn > 0 && stab.center.damper) c += 0.8;
  if (stab.side.damper) c += 0.8 * stab.side.count;
  return c;
}

// ---- 4.2: リリース後の回転運動 ----
//   I dω/dt + ω × (Iω) = τ_release − c_damp ω   (+ 重力トルク, 手・スリングの拘束)
// をボディ座標で RK4 積分し、姿勢はクォータニオンで追跡する。

export const RELEASE_TAU_S = 0.012;   // リリース反動トルクの減衰時定数
const HAND_OPEN_S = 0.06;             // 弓手が開くまでの時間 (以降は重力で前倒れ)
const HAND_K = 40, HAND_C = 1.2;      // 弓手の把持剛性 [N·m/rad] と減衰
const SLING_ANGLE = 0.95, SLING_K = 30, SLING_C = 2.5;
// 弓手・腕がグリップに接している間はその慣性も一緒に回る (ピッチ, ヨー, ロール) [kg·m²]
export const HAND_INERTIA = [0.12, 0.12, 0.02];

// 回転ベクトル (小角度ではほぼ [ピッチ, ヨー, ロール])
export function rotationVector(q) {
  const w = Math.min(1, Math.max(-1, q[0]));
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  if (s < 1e-9) return [2 * q[1], 2 * q[2], 2 * q[3]];
  const angle = 2 * Math.acos(Math.abs(w));
  const sg = w < 0 ? -1 : 1;
  return [(sg * q[1] / s) * angle, (sg * q[2] / s) * angle, (sg * q[3] / s) * angle];
}

/**
 * @param {object} model   bowMassModel の結果
 * @param {object} opts
 * @param {number[]} opts.torque0  リリース瞬間のトルク [N·m] (ボディ座標)
 * @param {number} opts.cDamp
 * @param {number} opts.duration   シミュレーション時間 [s]
 * @param {number} [opts.sampleEvery] 何秒ごとに姿勢を記録するか
 * @param {number} [opts.probeTime]   この時刻の回転ベクトルを返す (矢が離れる瞬間)
 * @param {boolean} [opts.free]       手・重力・スリングを外した自由剛体として解く (検証用)
 * @param {number[]} [opts.w0]        初期角速度 (ボディ座標)
 */
export function simulateBowRelease(model, I, opts) {
  const Ihand = I.map((row, i) => row.map((v, j) => (i === j ? v + HAND_INERTIA[i] : v)));
  const IinvFree = matInverse(I);
  const IinvHand = matInverse(Ihand);
  const mcg = scale(model.cg, model.mass);
  const dt = 0.0005;
  const sampleEvery = opts.sampleEvery ?? 0.01;
  let q = [1, 0, 0, 0];
  let w = opts.w0 ? [...opts.w0] : [0, 0, 0];
  let t = 0;
  const samples = [{ t: 0, q }];
  let probe = null;
  let nextSample = sampleEvery;

  const torqueAt = (tt, qq, ww) => {
    const decay = Math.exp(-tt / RELEASE_TAU_S);
    let tau = scale(opts.torque0, decay);
    const rv = rotationVector(qq);
    if (opts.free) {
      // 拘束なし
    } else if (tt < HAND_OPEN_S) {
      tau = add(tau, add(scale(rv, -HAND_K), scale(ww, -HAND_C)));
    } else {
      // 手が開いた後: 重力トルク (Σ m r) × g をボディ座標で
      const gBody = qRotateInv(qq, [0, -G, 0]);
      tau = add(tau, cross(mcg, gBody));
      if (rv[0] > SLING_ANGLE) tau = add(tau, [-SLING_K * (rv[0] - SLING_ANGLE) - SLING_C * ww[0], 0, 0]);
    }
    return add(tau, scale(ww, -opts.cDamp));
  };

  const deriv = (tt, qq, ww) => {
    const tau = torqueAt(tt, qq, ww);
    const held = !opts.free && tt < HAND_OPEN_S;
    const gyro = cross(ww, matVec(held ? Ihand : I, ww));
    const dw = matVec(held ? IinvHand : IinvFree, [tau[0] - gyro[0], tau[1] - gyro[1], tau[2] - gyro[2]]);
    const dq = qMul(qq, [0, ww[0], ww[1], ww[2]]).map((c) => 0.5 * c);
    return { dq, dw };
  };

  const qAdd = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s, a[3] + b[3] * s];

  while (t < opts.duration - 1e-12) {
    const k1 = deriv(t, q, w);
    const k2 = deriv(t + dt / 2, qAdd(q, k1.dq, dt / 2), add(w, scale(k1.dw, dt / 2)));
    const k3 = deriv(t + dt / 2, qAdd(q, k2.dq, dt / 2), add(w, scale(k2.dw, dt / 2)));
    const k4 = deriv(t + dt, qAdd(q, k3.dq, dt), add(w, scale(k3.dw, dt)));
    q = qNormalize([0, 1, 2, 3].map((i) => q[i] + (dt / 6) * (k1.dq[i] + 2 * k2.dq[i] + 2 * k3.dq[i] + k4.dq[i])));
    w = [0, 1, 2].map((i) => w[i] + (dt / 6) * (k1.dw[i] + 2 * k2.dw[i] + 2 * k3.dw[i] + k4.dw[i]));
    t += dt;
    if (probe === null && opts.probeTime !== undefined && t >= opts.probeTime) probe = { rv: rotationVector(q), w: [...w] };
    if (t >= nextSample - 1e-12) {
      samples.push({ t, q });
      nextSample += sampleEvery;
    }
  }
  return { samples, probe, final: { q, w } };
}

// ボディ座標の点をワールドへ (アニメーション用)
export const bodyToWorld = (q, r) => qRotate(q, r);
