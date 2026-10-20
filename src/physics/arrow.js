// 3.4 矢のパラメータ → 質量分布・FOC・曲げ剛性・空力係数、4.3 アーチャーズ・パラドックス。
import { INCH, GRAIN, LBF } from './units.js';
import { ARROW_MATERIALS, VANE_SHAPES, VANE_MATERIALS } from './config.js';

const SKIN_FRICTION = 0.003;     // シャフト表面の摩擦抗力係数
const SHAFT_CN = 0.8;            // シャフト横流れの法線力係数 (投影面積あたり)
const VANE_X = 0.045;            // ノック端からベイン中心までの距離 [m]
const BEAM_MODE1 = 4.730 ** 2 / (2 * Math.PI);  // 自由-自由梁の1次モード係数 (βL)² / 2π

// 静的スパイン: 28" スパンの中央に 1.94 lb を吊るしたときのたわみ (1/1000 inch)。
// 単純支持梁のたわみ δ = W L³ / (48 EI) から EI を逆算する。
export function spineToEI(spine) {
  const W = 1.94 * LBF;
  const L = 28 * INCH;
  const delta = (spine / 1000) * INCH;
  return (W * L ** 3) / (48 * delta);
}

// 射手のポンドと矢の長さから必要な静的スパインの目安 (Easton 表の傾向を近似)。
export function requiredSpine(effLbs, lengthIn) {
  return (23000 / Math.max(effLbs, 5)) * (28.5 / lengthIn) ** 2;
}

export function arrowProperties(a, effLbs, plungerK) {
  const L = a.lengthIn * INCH;
  const mass = a.totalGrain * GRAIN;
  const mat = ARROW_MATERIALS[a.material];
  const vane = VANE_SHAPES[a.vane];
  const vmat = VANE_MATERIALS[a.vaneMaterial];
  const d = a.diameterMm / 1000;
  const r = d / 2;
  const area = Math.PI * r * r;

  // 質量分布: ポイント(先端) + シャフト(一様) + ノックとベイン(後端)
  const mPoint = a.pointGrain * GRAIN;
  const mRear = vmat.rearGrain * GRAIN;
  const mShaft = mass - mPoint - mRear;
  const warnings = [];
  if (mShaft <= mass * 0.15) warnings.push('全質量に対してポイント・ベインが重すぎます');
  const mS = Math.max(mShaft, mass * 0.15);
  const xPoint = L - 0.012;
  const xRear = 0.03;
  const xCg = (mPoint * xPoint + mS * (L / 2) + mRear * xRear) / (mPoint + mS + mRear);
  const foc = (xCg - L / 2) / L;
  const inertiaT = mS * (L * L / 12 + (L / 2 - xCg) ** 2) + mPoint * (xPoint - xCg) ** 2 + mRear * (xRear - xCg) ** 2;

  // 4.3: f_spine ∝ sqrt(EI / (m L³))。比例係数は自由-自由梁の1次モード。
  const EI = spineToEI(a.spine);
  const fSpine = BEAM_MODE1 * Math.sqrt(EI / (mass * L ** 3));

  // スパインマッチング: 正 = 柔らかすぎ (右利きでは右へ), 負 = 硬すぎ (左へ)
  const req = requiredSpine(effLbs, a.lengthIn);
  const dynSpine = a.spine * (1 + 0.0035 * (a.pointGrain - 100));
  const mismatch = (dynSpine - req) / req;
  // 固いプランジャーは柔らかい矢の横しなりを押し返す
  const plungerComp = 0.25 * (plungerK - 800) / 800;

  // 4.3: プランジャー反力 F_p = −k_p x_p が初期振幅 A0 を抑える
  const A0 = (0.008 * (1 + 1.5 * Math.abs(mismatch))) / (1 + plungerK / 800);

  const cdShaft = 1.0 + (4 * SKIN_FRICTION * L) / d;
  const dragArea = cdShaft * area + vane.dragArea * vmat.dragMul;
  const leverVane = xCg - VANE_X;
  const leverShaft = xCg - L / 2;
  const vaneN = vane.cnAlpha * vmat.cnMul * vane.area;
  const shaftN = SHAFT_CN * d * L;

  return {
    L, mass, d, r, area, xCg, foc, inertiaT, EI, fSpine,
    requiredSpine: req, dynamicSpine: dynSpine, mismatch, effMismatch: mismatch - plungerComp,
    paradox: { A0, gamma: mat.gamma, f: fSpine },
    cd: dragArea / area, dragArea,
    normalArea: vaneN + shaftN,                                   // C_L · A
    momentArea: vaneN * leverVane + shaftN * leverShaft,          // 復元モーメント係数 × 面積 × 腕
    dampArea: vaneN * leverVane * leverVane,                      // 首振り減衰
    spinPitch: vane.spinPitch,
    cm: 1.0,
    stable: vaneN * leverVane + shaftN * leverShaft > 0,
    warnings,
  };
}

// 4.3: y_s(t) = A0 e^{−γt} sin(2π f t)
export function paradoxDeflection(p, t) {
  return p.A0 * Math.exp(-p.gamma * t) * Math.sin(2 * Math.PI * p.f * t);
}

