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

// 引き尺は AMO 規格 (ピボット + 1.75")。リムの表示ポンドも AMO 28" で測った値。
// ノックからピボットまでの実距離は 引き尺 − 1.75"、弦の移動量 (ストローク) はそこからブレースハイトを引いた分。
export const AMO_OFFSET_IN = 1.75;
const MARKED_DRAW_IN = 28;

/** ノックからグリップのピボットまでの距離 [m] */
export function nockDistanceM(drawIn) {
  return (drawIn - AMO_OFFSET_IN) * INCH;
}

/** ブレース位置から引いた弦の移動量 [inch] */
export function strokeIn(bow, drawIn) {
  return Math.max(0, drawIn - AMO_OFFSET_IN - bow.braceIn);
}

// 引き重量曲線: F(s) = F_28 · (s / s_28)^p。p = 1 なら直線 (spec の E = ½·F·(L−BH) の形)。
// リカーブは引き始めに重さが立ち上がって後半は寝るので p < 1 (蓄積エネルギー/(F·s) = 1/(1+p) が 0.5 より大きい)。
const curveExp = (bow) => bow.curveExp ?? 1;

// 実効ポンド: 引き尺での保持力 [lbs]。AMO 28" で表示ポンドに一致する
export function effectiveLbs(bow, drawIn) {
  const s = strokeIn(bow, drawIn);
  const s28 = MARKED_DRAW_IN - AMO_OFFSET_IN - bow.braceIn;
  if (s <= 0 || s28 <= 0) return 0;
  return bow.markedLbs * (s / s28) ** curveExp(bow);
}

// 4.1: 蓄積エネルギー [J] = ∫ F ds (ブレース位置から引き尺まで) = F · s / (1 + p)
export function storedEnergy(bow, drawIn) {
  const F = effectiveLbs(bow, drawIn) * LBF;
  const s = strokeIn(bow, drawIn) * INCH;
  return (F * s) / (1 + curveExp(bow));
}

// 4.1: v0 = sqrt(2 η E / (m_arrow + m_eff))。η はヒステリシス・弦の振動・音による損失、
// m_eff はリム・弦の等価運動質量 (仮想質量)。矢が軽いほど m_eff に取られる割合が増え、効率が下がる。
// restLoss はレスト摩擦によるエネルギー損失率。
export function launchSpeed(bow, drawIn, arrowMassKg, restLoss = 0) {
  const E = storedEnergy(bow, drawIn) * (1 - restLoss);
  return Math.sqrt((2 * bow.eta * E) / (arrowMassKg + bow.effMassG / 1000));
}

// ---- 4.2: パーツ構成 → 質点群 → 慣性テンソル ----
// ボウ座標系: 原点=グリップのピボット, x=右, y=上, z=的方向。右利き射手を想定。

const SPACER_G_PER_IN = 14;   // スペーサー (ステンレス) の線密度
const DAMPER_G = 25;
// リム付け根: ライザー上下端の前面 (的側) のブッシングと、リムの腹 (射手側) に当てるリムダンパー
const LIMB_ROOT_MOUNT_Y = 0.255;
const LIMB_ROOT_MOUNT_Z = 0.036;
const LIMB_DAMPER_G = 12;
const LIMB_DAMPER_AT = [0, 0.345, -0.03];   // 上側 (下側は y を反転)。リムの付け根の少し先の腹に当たる
export const LIMB_ROOT_POSITIONS = { none: [], top: [1], bottom: [-1], both: [1, -1] };
const RISER_MOUNT = [0, -0.085, 0.045];   // ライザー前面のスタビライザー取付穴

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
  parts.push({ name, kind: 'rod', from: origin, to: tip, tipOz: rodCfg.tipOz, damper: rodCfg.damper });
}

// センターロッドの取付方向 (下向きに angleDeg)
function centerDirection(c) {
  const a = deg(c.angleDeg);
  return [0, -Math.sin(a), Math.cos(a)];
}

// Vバーの位置: ライザーからエクステンダー分だけ前に出た所 (一般的には 10cm 前後)
export function vbarPosition(stab) {
  return add(RISER_MOUNT, scale(centerDirection(stab.center), (stab.extenderIn ?? 0) * INCH));
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

  // ライザー → エクステンダー → Vバー → センターロッド / サイドロッド
  const c = stab.center;
  const hasCenter = c.lengthIn > 0, hasSide = stab.side.count > 0;
  const vbar = vbarPosition(stab);
  const extIn = hasCenter || hasSide ? (stab.extenderIn ?? 0) : 0;
  if (extIn > 0) {
    segment(points, RISER_MOUNT, vbar, (stab.rodGPerIn * extIn) / 1000, 3);
    parts.push({ name: 'extender', kind: 'extender', from: RISER_MOUNT, to: vbar, tipOz: 0, damper: false });
  }
  if (hasCenter) rod(points, parts, 'center', vbar, centerDirection(c), c, stab);
  if (hasSide) {
    points.push({ m: stab.vbarMassG / 1000, r: vbar });
    parts.push({ name: 'vbar', kind: 'vbar', from: vbar, to: vbar, tipOz: 0, damper: false });
    const signs = stab.side.count >= 2 ? [-1, 1] : [1];
    for (const sgn of signs) {
      rod(points, parts, sgn < 0 ? 'sideL' : 'sideR', vbar, sideRodDirection(stab.side, sgn), stab.side, stab);
    }
  }

  // リム付け根のスタビ: 前 (的方向) へ出し、angleDeg だけ外側 (上は上向き、下は下向き) へ振る
  const lr = stab.limbRoot;
  if (lr && lr.lengthIn > 0) {
    for (const sgn of LIMB_ROOT_POSITIONS[lr.position] ?? []) {
      const a = deg(lr.angleDeg);
      const origin = [0, sgn * LIMB_ROOT_MOUNT_Y, LIMB_ROOT_MOUNT_Z];
      rod(points, parts, sgn > 0 ? 'limbTop' : 'limbBottom', origin, [0, sgn * Math.sin(a), Math.cos(a)], { ...lr, spacerIn: 0 }, stab);
    }
  }
  if (stab.limbDampers) {
    for (const sgn of [1, -1]) {
      const at = [LIMB_DAMPER_AT[0], sgn * LIMB_DAMPER_AT[1], LIMB_DAMPER_AT[2]];
      points.push({ m: LIMB_DAMPER_G / 1000, r: at });
      parts.push({ name: sgn > 0 ? 'limbDamperTop' : 'limbDamperBottom', kind: 'limbDamper', from: [0, sgn * 0.27, -0.016], to: at, tipOz: 0, damper: true });
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
  // リム付け根は回転軸 (グリップ) に近いので、ダンパー 1 個あたりの効きはロッドの半分程度
  const lr = stab.limbRoot;
  if (lr && lr.lengthIn > 0 && lr.damper) c += 0.4 * (LIMB_ROOT_POSITIONS[lr.position] ?? []).length;
  // リムダンパーはリムの振動を吸収し、その分ハンドルへ伝わる揺れが早く収まる
  if (stab.limbDampers) c += 0.3;
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
 * @param {(t:number) => number[]} [opts.extraTorque] 追加のトルク (ボディ座標)。リムの振動がハンドルを揺する分など
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
    if (opts.extraTorque) tau = add(tau, opts.extraTorque(tt));
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
