// リムの振動: 矢が離れた後、矢に渡らなかったエネルギーでリムが 1 次の曲げモードで減衰振動する。
//
//   x(t) = A · e^(−ζωt) · sin(ω_d t)        (t は矢が離れた瞬間 = 弦がブレース位置に戻った瞬間から)
//
// ・エネルギー: v0 = sqrt(2ηE / (m_arrow + m_eff)) のとき、ブレース位置でリム・弦 (m_eff) が持つ運動エネルギー
//   ηE · m_eff / (m_arrow + m_eff) と、損失 (1−η)E の一部が振動になる。軽い矢ほど残りが大きい (空打ちが最悪)。
// ・先端の剛性: 各リムの蓄積エネルギー E/2 = ½ k_tip d_tip² (d_tip = 引いたときの先端の移動量)。
// ・減衰: リム自体 + リムダンパー + スタビライザーのダンパー (ハンドルに伝わった振動を吸う)。
// ・上下のリムの振幅差 (ティラー差) はハンドルを上下に揺するピッチトルクになる (フォロースルーに影響)。
// 矢が離れた後に始まるので、その矢の飛び方には影響しない。
import { storedEnergy, effectiveLbs, strokeIn } from './bow.js';
import { INCH, LBF, G } from './units.js';

export const TIP_TRAVEL_RATIO = 0.25;   // 先端の移動量 / 引き尺のストローク
const TIP_MASS_RATIO = 0.25;            // リムの等価質量 (先端換算) / リム質量
const LOSS_TO_VIBRATION = 0.3;          // 損失 (1−η)E のうち振動になる割合
const LIMB_SHARE = 0.12;                // 残ったエネルギーのうちリムの 1 次モードに入る割合 (残りは弦の振動・音・熱)
const POCKET_LEVER = 0.3;               // リムポケット (力の作用点) のグリップからの高さ [m]
const TRANSMISSION = 0.3;               // 先端の復元力のうちハンドルへ前後に伝わる割合
const ZETA_LIMB = 0.035;                // リム自体の減衰比
const ZETA_LIMB_DAMPER = 0.06;          // リムダンパー (上下) による追加
const ZETA_STAB_DAMPER = 0.008;         // スタビライザーのダンパー 1 個あたり
const STRING_FREQ_RATIO = 2.6;          // 弦の振動数 / リムの振動数 (見た目用)

/**
 * @param {object} bow     setup.bow
 * @param {object} stab    setup.stabilizer
 * @param {number} drawIn  引き尺 [inch]
 * @param {number} arrowMassKg
 * @param {number} bowMassKg  ボウ全体の質量 (ハンドルの加速度の計算用)
 */
export function limbVibration(bow, stab, drawIn, arrowMassKg, bowMassKg) {
  const E = storedEnergy(bow, drawIn);
  const stroke = strokeIn(bow, drawIn) * INCH;
  const mEff = bow.effMassG / 1000;
  const kinetic = (bow.eta * E * mEff) / (arrowMassKg + mEff);
  const residual = kinetic + LOSS_TO_VIBRATION * (1 - bow.eta) * E;
  const energy = LIMB_SHARE * residual;          // 上下 2 本のリムの振動エネルギーの合計 [J]

  const dTip = TIP_TRAVEL_RATIO * stroke;
  const kTip = dTip > 0 ? E / 2 / (dTip * dTip) : 0;   // 各リム先端の剛性 [N/m]
  const mTip = TIP_MASS_RATIO * (bow.limbMassG / 1000) + mEff / 2;
  const omega = kTip > 0 ? Math.sqrt(kTip / mTip) : 0;

  let dampers = 0;
  if (stab.center.lengthIn > 0 && stab.center.damper) dampers++;
  if (stab.side.damper) dampers += stab.side.count;
  const lr = stab.limbRoot;
  if (lr && lr.lengthIn > 0 && lr.damper && lr.position !== 'none') dampers += lr.position === 'both' ? 2 : 1;
  const zeta = ZETA_LIMB + (stab.limbDampers ? ZETA_LIMB_DAMPER : 0) + ZETA_STAB_DAMPER * dampers;

  const amp = kTip > 0 ? Math.sqrt(energy / kTip) : 0;   // 各リムに半分ずつ: ½ k A² = energy/2
  // ティラー差: 上のリムが下より弱い (+) と上の振幅が大きくなる
  const skew = 0.012 * bow.tillerMm;
  const ampTop = amp * (1 + skew / 2), ampBottom = amp * (1 - skew / 2);
  const torqueAmp = POCKET_LEVER * TRANSMISSION * kTip * (ampTop - ampBottom);
  const forcePeak = TRANSMISSION * kTip * (ampTop + ampBottom);

  return {
    energy, residual, kinetic,
    freq: omega / (2 * Math.PI), omega, zeta,
    omegaD: omega * Math.sqrt(Math.max(0, 1 - zeta * zeta)),
    ampTop, ampBottom, kTip, mTip, tipTravel: dTip,
    decayTime: zeta * omega > 0 ? Math.log(20) / (zeta * omega) : Infinity,   // 振幅が 1/20 になるまで [s]
    torqueAmp,
    handPeakG: bowMassKg > 0 ? forcePeak / bowMassKg / G : 0,
    string: { amp: 0.4 * amp, omega: STRING_FREQ_RATIO * omega, zeta: 2.5 * zeta },
    drawForceN: effectiveLbs(bow, drawIn) * LBF,
  };
}

/** 矢が離れてから t 秒後の先端の変位 [m] (前 = +) */
export function limbDisplacement(v, t, amp) {
  if (t <= 0) return 0;
  return amp * Math.exp(-v.zeta * v.omega * t) * Math.sin(v.omegaD * t);
}

/** 振動がハンドルに与えるピッチトルク [N·m] (t は矢が離れてから) */
export function vibrationTorque(v, t) {
  if (t <= 0 || !v.torqueAmp) return 0;
  return v.torqueAmp * Math.exp(-v.zeta * v.omega * t) * Math.sin(v.omegaD * t);
}
