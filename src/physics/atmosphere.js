// 大気と地球: 空気の密度・動粘性係数 (気温・標高・湿度から)、緯度・標高による重力加速度、地球の自転によるコリオリ力。
//
// ・気圧: 国際標準大気 (ISA) の対流圏の式 p = p0 (1 − 2.25577e−5 h)^5.25588
// ・飽和水蒸気圧: Tetens の式。湿った空気は乾燥空気より軽い (水蒸気の分子量が小さい)
// ・粘性係数: Sutherland の式
// ・重力: 正規重力式 (GRS80, Somigliana の近似) + 高度補正
// ・コリオリ: a = −2 Ω × v を東・北・上 (右手系) で計算してから、射場の座標 (x=右, y=上, z=的方向) へ戻す。
//   北半球では進行方向の右へ曲がる。70m で数 mm。
const R_DRY = 287.058, R_VAPOR = 461.495;   // 気体定数 [J/(kg·K)]
const OMEGA_EARTH = 7.2921159e-5;          // 地球の自転角速度 [rad/s]

export const STANDARD_AIR = { rho: 1.225, nu: 1.4607e-5, mu: 1.7894e-5, tempC: 15, pressurePa: 101325 };

/**
 * @param {object} env  setup.environment (temperatureC, altitudeM, humidity [0〜1])
 */
export function airProperties(env = {}) {
  const tC = env.temperatureC ?? 15;
  const T = tC + 273.15;
  const h = env.altitudeM ?? 0;
  const p = 101325 * Math.pow(Math.max(0, 1 - 2.25577e-5 * h), 5.25588);
  const es = 610.78 * Math.pow(10, (7.5 * tC) / (tC + 237.3));
  const pv = Math.min(1, Math.max(0, env.humidity ?? 0)) * es;
  const rho = (p - pv) / (R_DRY * T) + pv / (R_VAPOR * T);
  const mu = (1.716e-5 * Math.pow(T / 273.15, 1.5) * (273.15 + 110.4)) / (T + 110.4);
  return { rho, mu, nu: mu / rho, tempC: tC, pressurePa: p };
}

/** 緯度 [deg]・標高 [m] での重力加速度 [m/s²] */
export function gravityAt(latitudeDeg = 45, altitudeM = 0) {
  const s = Math.sin((latitudeDeg * Math.PI) / 180);
  const s2 = Math.sin((2 * latitudeDeg * Math.PI) / 180);
  return 9.780327 * (1 + 0.0053024 * s * s - 0.0000058 * s2 * s2) - 3.086e-6 * altitudeM;
}

/**
 * コリオリ加速度を求める関数を返す。
 * @param {number} latitudeDeg  緯度 (北が正)
 * @param {number} azimuthDeg   的の方位 (北 = 0、東 = 90、時計回り)
 * @returns {(v:number[]) => number[]}  射場の座標での速度 → 加速度
 */
export function coriolis(latitudeDeg, azimuthDeg) {
  const phi = (latitudeDeg * Math.PI) / 180, A = (azimuthDeg * Math.PI) / 180;
  // 射場の軸を東・北・上で表す
  const right = [Math.cos(A), -Math.sin(A), 0];
  const down = [Math.sin(A), Math.cos(A), 0];
  const W = [0, OMEGA_EARTH * Math.cos(phi), OMEGA_EARTH * Math.sin(phi)];
  return (v) => {
    const e = [v[0] * right[0] + v[2] * down[0], v[0] * right[1] + v[2] * down[1], v[1]];
    const a = [-2 * (W[1] * e[2] - W[2] * e[1]), -2 * (W[2] * e[0] - W[0] * e[2]), -2 * (W[0] * e[1] - W[1] * e[0])];
    return [a[0] * right[0] + a[1] * right[1], a[2], a[0] * down[0] + a[1] * down[1]];
  };
}
