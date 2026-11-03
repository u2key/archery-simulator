// 発射の動力学 (パワーストローク): リムを付け根のねじりバネで支えた剛体の棒、弦を伸びない糸とする
// 集中定数モデル (Hickman / Klopsteg 型)。上下対称として半分だけ考える。
//
//   座標: x = 射手方向 (ピボットから), y = ボウの上方向
//   リムの付け根 (ヒンジ) は (x_h, R)、リムは長さ L_l の棒で、射手側への角度 φ。先端 = (x_h + L_l sin φ, R + L_l cos φ)
//   弦の半分の長さ ℓ。ノック位置 s (ピボットから射手側) は  (s − x_tip)² + y_tip² = ℓ²
//   ねじりバネ M = k (φ − φ0)、2 本分の位置エネルギー U = k (φ − φ0)²
//
// ブレース位置では弦がまっすぐ (s = x_tip) なので φ_b と ℓ は幾何学だけで決まる。
// 残る k と φ0 (弦を張る前の角度 = プレストレス) は、AMO 28" での表示ポンドと、引き重量曲線の形
// (蓄積エネルギー / (F·s) = 1/(1+p)) に合うように決める。
//
// 運動: ノック位置 s を一般化座標にすると  T = ½ M(s) ṡ²,  M(s) = m_arrow + m_nock + 2 I_l φ'(s)²
//   M ṡ̇ + ½ M'(s) ṡ² + η U'(s) = 0     (η: 戻るときに返ってくるエネルギーの割合 = ヒステリシス)
// ブレース位置では φ'(s) = 0 (弦がまっすぐになる瞬間リムは止まる) ので、リムの運動エネルギーはすべて
// 矢と弦に渡る。矢の効率 = η · m_arrow / (m_arrow + m_nock) となり、m_nock は弦の質量の 1/3 + ノッキングポイント等。
import { LBF, INCH } from './units.js';
import { AMO_OFFSET_IN } from './bow.js';

const HINGE_X = -0.03;           // リムポケットはピボットより的側 [m]
const LIMB_INERTIA_RATIO = 0.22; // I_l = c · m_limb · L_l² (根元が太く重いテーパーリム)

function geometry(bow) {
  const R = ((bow.riserLengthIn ?? 25) / 2) * INCH;
  const half = ((bow.bowLengthIn ?? 68) / 2) * INCH;
  const Ll = (half - R) * 0.92;                    // 曲がったリムの弦長 (直線距離)
  const sB = bow.braceIn * INCH;
  const phiB = Math.asin(Math.min(0.99, (sB - HINGE_X) / Ll));
  const ell = R + Ll * Math.cos(phiB);            // ブレースで弦はまっすぐ
  return { R, Ll, sB, phiB, ell };
}

// s(φ) とその導関数
function sOf(g, phi) {
  const xt = HINGE_X + g.Ll * Math.sin(phi);
  const Y = g.R + g.Ll * Math.cos(phi);
  const Q = Math.sqrt(Math.max(0, g.ell * g.ell - Y * Y));
  return xt + Q;
}

/** s → φ (ブレース側の分岐。s(φ) は φ_b 以上で単調増加) */
function phiOf(g, s) {
  if (s <= g.sB) return g.phiB;
  let lo = g.phiB, hi = Math.PI / 2;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (sOf(g, mid) < s) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** dφ/ds (数値微分。ブレース付近では 0 に近づく) */
function dphiDs(g, s) {
  const h = 1e-5;
  if (s - h <= g.sB) return (phiOf(g, s + h) - phiOf(g, s)) / h;
  return (phiOf(g, s + h) - phiOf(g, s - h)) / (2 * h);
}

const strokeEndS = (drawIn) => (drawIn - AMO_OFFSET_IN) * INCH;   // フルドローのノック位置

/**
 * ボウの集中定数モデルを作る (表示ポンドと引き重量曲線の形に合わせて k, φ0 を決める)
 * @returns {{ g, k, phi0, I, mNock, energyRatio }}
 */
export function buildBowModel(bow) {
  const g = geometry(bow);
  const s28 = strokeEndS(28);
  const F28 = bow.markedLbs * LBF;
  const phi28 = phiOf(g, s28);
  const d28 = dphiDs(g, s28);
  const targetRatio = 1 / (1 + (bow.curveExp ?? 0.75));
  // φ0 を与えると、F(s28) = 2k(φ28 − φ0) φ'(s28) = F28 から k が決まる。
  // 蓄積エネルギー比 E/(F·s) は φ0 が小さい (プレストレスが大きい) ほど大きくなるので二分法で合わせる
  const ratioFor = (phi0) => {
    const k = F28 / (2 * (phi28 - phi0) * d28);
    const E = k * ((phi28 - phi0) ** 2 - (g.phiB - phi0) ** 2);
    return { k, ratio: E / (F28 * (s28 - g.sB)) };
  };
  let lo = g.phiB - 3, hi = g.phiB - 1e-4;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (ratioFor(mid).ratio > targetRatio) lo = mid; else hi = mid;
  }
  const phi0 = 0.5 * (lo + hi);
  const { k, ratio } = ratioFor(phi0);
  const I = LIMB_INERTIA_RATIO * (bow.limbMassG / 1000) * g.Ll * g.Ll + ((bow.stringMassG ?? 8) / 6000) * g.Ll * g.Ll;
  const mNock = (bow.stringMassG ?? 8) / 3000 + (bow.effMassG ?? 1) / 1000;
  return { g, k, phi0, I, mNock, energyRatio: ratio };
}

/** 静的な引き重量 [N] (ノック位置 s で) */
export function drawForce(model, s) {
  const phi = phiOf(model.g, s);
  return 2 * model.k * (phi - model.phi0) * dphiDs(model.g, s);
}

/** 位置エネルギー [J] (ブレース位置を 0 とする) */
export function potential(model, s) {
  const phi = phiOf(model.g, s);
  return model.k * ((phi - model.phi0) ** 2 - (model.g.phiB - model.phi0) ** 2);
}

/** 弦の張力 [N] (静的・ノック位置 s で)。リム付け根まわりのモーメントのつり合い T · 腕 = k (φ − φ0) から */
export function stringTension(model, s) {
  const g = model.g;
  const phi = phiOf(g, s);
  const xt = HINGE_X + g.Ll * Math.sin(phi), yt = g.R + g.Ll * Math.cos(phi);
  const ux = (Math.max(s, g.sB) - xt) / g.ell, uy = -yt / g.ell;   // 先端からノックへの弦の向き
  const arm = Math.abs((xt - HINGE_X) * uy - (yt - g.R) * ux);
  return (model.k * (phi - model.phi0)) / Math.max(arm, 1e-6);
}

/**
 * パワーストローク: フルドロー (静止) からブレース位置まで。矢が弦から離れるのはブレース位置。
 * @param {object} model   buildBowModel の結果
 * @param {number} drawIn  引き尺 [inch] (AMO)
 * @param {number} arrowMassKg
 * @param {number} eta     ヒステリシスによる効率
 * @param {number} [restLoss] レスト摩擦の損失率
 * @returns {{ v0, tExit, samples: {t, s, v, a}[] }}  a は矢の加速度 (前向き正) [m/s²]
 */
export function powerStroke(model, drawIn, arrowMassKg, eta, restLoss = 0) {
  const g = model.g;
  const s0 = strokeEndS(drawIn);
  const eff = eta * (1 - restLoss);
  if (s0 <= g.sB) return { v0: 0, tExit: 0, samples: [] };
  const mass = (s) => {
    const dp = dphiDs(g, s);
    return arrowMassKg + model.mNock + 2 * model.I * dp * dp;
  };
  // 速さはエネルギー保存から厳密に決まる: ½ M(s) ṡ² = η (U(s0) − U(s))
  const U0 = potential(model, s0);
  const speed = (s) => Math.sqrt(Math.max(0, (2 * eff * (U0 - potential(model, s))) / mass(s)));
  // 時刻は t = ∫ ds / ṡ。引き始め (ṡ = 0) の特異点を避けるため s = s0 − u² と置き換えて積分する
  const N = 400;
  const uMax = Math.sqrt(s0 - g.sB);
  const samples = [{ t: 0, s: s0, v: 0, a: (eff * drawForce(model, s0)) / mass(s0) }];
  let t = 0;
  const dtdu = (u) => {
    if (u < 1e-9) {
      // u → 0 で ṡ ≈ sqrt(2 η F(s0) u² / M) なので dt/du = 2u/ṡ → 2 sqrt(M / (2 η F))
      return 2 * Math.sqrt(mass(s0) / (2 * eff * drawForce(model, s0)));
    }
    return (2 * u) / speed(s0 - u * u);
  };
  for (let i = 0; i < N; i++) {
    const u0 = (i / N) * uMax, u1 = ((i + 1) / N) * uMax;
    // シンプソン則
    t += ((u1 - u0) / 6) * (dtdu(u0) + 4 * dtdu(0.5 * (u0 + u1)) + dtdu(Math.max(u1, 1e-12)));
    const s = s0 - u1 * u1;
    const v = speed(s);
    // 矢の加速度 = (η F(s) − ½ M'(s) v²) / M(s)
    const h = 1e-5;
    const dM = (mass(Math.min(s0, s + h)) - mass(Math.max(g.sB, s - h))) / (Math.min(s0, s + h) - Math.max(g.sB, s - h));
    const a = (eff * drawForce(model, s) - 0.5 * dM * v * v) / mass(s);
    samples.push({ t, s, v, a });
  }
  return { v0: speed(g.sB), tExit: t, samples };
}
