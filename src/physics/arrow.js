// 3.4 矢のパラメータ → 質量分布・FOC・曲げ剛性・空力係数、4.3 アーチャーズ・パラドックス。
import { INCH, GRAIN, LBF } from './units.js';
import { ARROW_MATERIALS, VANE_SHAPES, VANE_MATERIALS } from './config.js';

// 抗力: 先端・ノックの圧力抗力 + シャフト表面の摩擦抗力 C_D = C_D0 + 4 C_f L/d (断面積基準)。
// 摩擦係数 C_f は境界層が層流か乱流かで約 2 倍違い、直径基準のレイノルズ数 Re ≈ 1.2〜1.8×10⁴ で遷移する。
// 係数は Miyazaki ら (Sports Engineering 16, 2013; JAXA 磁力支持天秤) の、一般的な矢 (L/d ≈ 130) で
// 層流 C_D ≈ 1.6、乱流 C_D ≈ 2.6 という計測値に合わせている。ベインの抗力は別に足す。
const CD_BASE = 0.6;             // 先端・ノックの圧力抗力
const CF_LAMINAR = 0.0019;       // 層流境界層の実効摩擦係数
const CF_TURBULENT = 0.0038;     // 乱流境界層の実効摩擦係数
const RE_TRANSITION = 1.5e4;     // 遷移レイノルズ数 (中心)
const RE_WIDTH = 1.5e3;          // 遷移の幅

/** 境界層が乱流である割合 (0〜1)。遷移域をなめらかにつなぐ */
export function turbulentFraction(Re) {
  return 1 / (1 + Math.exp(-(Re - RE_TRANSITION) / RE_WIDTH));
}

/** シャフトの抗力係数 (断面積基準) */
export function shaftDragCoefficient(Re, slenderness) {
  const cf = CF_LAMINAR + (CF_TURBULENT - CF_LAMINAR) * turbulentFraction(Re);
  return CD_BASE + 4 * cf * slenderness;
}
const CROSSFLOW_CD = 1.2;        // シャフトの横流れの抗力係数 (円柱。迎角の 2 乗で効く)
const VANE_COUNT = 3;
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

export function arrowProperties(a, effLbs) {
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
  // しなりの振幅・発射方向は有限要素の計算 (paradox.js) で求める
  const aero = vaneAerodynamics(vane, vmat, r);
  // 抗力: シャフト (Re で層流 ↔ 乱流) + ベイン (ベインの長さ基準の Re で摩擦係数が変わる)
  const dragAreaAt = (Re) => shaftDragCoefficient(Re, L / d) * area + aero.dragAreaAt((Re * aero.length) / d);
  const dragArea = dragAreaAt(2e4);   // 表示用 (発射直後のおよその Re)
  // 法線力 (迎角 1 rad あたりの C_N·A) と重心まわりの腕:
  //   ベイン = 後ろ (安定)、シャフトの細長体の揚力 = 先端に集中 (不安定)、横流れ = シャフト全体 (2 乗で効く)
  const xVane = VANE_X;
  const leverVane = xCg - xVane;
  const leverNose = xCg - L;            // 負 (重心より前)
  const vaneN = aero.normalArea;
  const noseN = 2 * area;               // 細長体理論: C_Nα = 2 (断面積基準)
  const crossArea = CROSSFLOW_CD * d * L;
  const leverCross = xCg - L / 2;
  // 自転: ベインのカント角で迎角がつり合う回転数 p r_v = V tan δ → 1 回転で進む距離。ロール減衰と慣性で時定数
  const rollInertia = 0.5 * mass * r * r + aero.rollInertiaVanes;
  const linearMoment = vaneN * leverVane + noseN * leverNose;

  return {
    L, mass, d, r, area, xCg, foc, inertiaT, EI, fSpine,
    requiredSpine: req, dynamicSpine: dynSpine, mismatch,
    paradox: { A0: 0, gamma: mat.gamma, f: fSpine },
    cd: dragArea / area, dragArea, dragAreaAt,
    cdLaminar: dragAreaAt(5e3) / area, cdTurbulent: dragAreaAt(4e4) / area,
    normalArea: vaneN + noseN,                                    // 線形の法線力 C_Nα · A
    momentArea: linearMoment,                                     // 復元モーメント (正 = 風見安定)
    crossArea, crossMomentArea: crossArea * leverCross,           // 横流れ (迎角の 2 乗)
    dampArea: vaneN * leverVane * leverVane + noseN * leverNose * leverNose,   // 首振り減衰
    spinPitch: aero.spinPitch, rollInertia, rollDampArea: aero.rollDampArea,
    vane: aero,
    cm: 1.0,
    stable: linearMoment > 0,
    staticMargin: linearMoment / ((vaneN + noseN) * L),           // 重心と風圧中心の距離 / 全長
    warnings,
  };
}

/**
 * ベインの空力 (1 枚の寸法から)。
 * ・法線力: 低アスペクト比翼の揚力傾斜 (Helmbold の式。細長翼では C_Lα → π AR / 2)。シャフトを鏡面とみなして
 *   AR = 2 h² / S。胴体との干渉で (1 + r/(r+h)) 倍。3 枚が 120° おきにあると、どの向きの迎角にも 1.5 枚分が効く。
 * ・抗力: 両面の摩擦 (平板。ベインの長さ基準の Re で層流 1.328/√Re ↔ 乱流 0.074/Re^0.2) + 前縁の圧力抗力。
 * ・自転: カント角 δ のベインは p r_v = V tan δ で迎角が 0 になり、そこで回転数が釣り合う。
 */
export function vaneAerodynamics(vane, vmat, r) {
  const l = vane.lengthMm / 1000, h = vane.heightMm / 1000, t = vane.thicknessMm / 1000;
  const S = vane.fill * l * h;
  const AR = (2 * h * h) / S;
  const clAlpha = (2 * Math.PI * AR) / (2 + Math.sqrt(4 + AR * AR));
  const interference = 1 + r / (r + h);
  const normalArea = 0.5 * VANE_COUNT * interference * clAlpha * S * vmat.cnMul;
  const rv = r + 0.42 * h;                       // ベインの面積の中心の半径
  const tanCant = Math.tan((vane.cantDeg * Math.PI) / 180);
  const spinPitch = tanCant > 1e-6 ? (2 * Math.PI * rv) / tanCant : 1e6;
  const dragAreaAt = (ReL) => {
    const lam = 1.328 / Math.sqrt(Math.max(ReL, 1e3));
    const turb = 0.074 / Math.pow(Math.max(ReL, 1e3), 0.2);
    const cf = ReL < 5e5 ? lam : turb;
    return VANE_COUNT * (2 * S * cf * vmat.dragMul + 1.0 * t * h);
  };
  // ロール減衰: 自転で各ベインに迎角 p r_v / V が付く → モーメント = ½ρV² · C_Lα S · (p r_v / V) · r_v (3 枚分)
  const rollDampArea = VANE_COUNT * interference * clAlpha * S * vmat.cnMul * rv * rv;
  const vaneMass = Math.max(0, (vmat.rearGrain - 8) * 6.479891e-5);   // ノック (約 8gr) を除いたベインの質量
  return { length: l, height: h, area: S, AR, clAlpha, normalArea, spinPitch, dragAreaAt, rollDampArea, rv,
    rollInertiaVanes: vaneMass * rv * rv };
}

// 4.3: y_s(t) = A0 e^{−γt} sin(2π f t + φ)。A0 と位相 φ は有限要素の計算 (paradox.js) から
export function paradoxDeflection(p, t) {
  return p.A0 * Math.exp(-p.gamma * t) * Math.sin(2 * Math.PI * p.f * t + (p.phase ?? 0));
}

