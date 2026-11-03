// 1本の射撃を、照準 → クリッカー → リリース反動 → パラドックス → 飛翔 → 採点 の順に計算する。
import { LBF, INCH, MRAD } from './units.js';
import { createRng } from './random.js';
import { createNoise4D } from './simplex.js';
import { REST_FRICTION } from './config.js';
import {
  drawLengthIn, effectiveLbs, launchSpeed, nockDistanceM, strokeIn, bowMassModel, inertiaTensor, dampingCoefficient, simulateBowRelease, HAND_INERTIA,
  rotationVector,
} from './bow.js';
import { arrowProperties } from './arrow.js';
import { limbVibration, vibrationTorque } from './limb.js';
import { airProperties, gravityAt, coriolis } from './atmosphere.js';
import { buildBowModel, powerStroke, potential, stringTension } from './bowdynamics.js';
import { buildArrowBeam, simulateParadox } from './paradox.js';
import { VANE_MATERIALS } from './config.js';
import { GRAIN } from './units.js';
import { simulateFlight } from './ballistics.js';
import { calmWind } from './wind.js';
import { aimAngles, applyCorrection, EYE_ABOVE_ARROW } from './sight.js';
import { scoreArrow, faceDiameterCm, TARGET_CENTER_HEIGHT } from './scoring.js';

// 揺れの基準とする慣性モーメント (既定セットアップの値) [kg·m²]
const I_REF = { pitch: 0.308, yaw: 0.145 };
const SWAY_MRAD = 0.85;          // skill=1, I=I_REF での照準揺れ (各軸の標準偏差)
const HEARTBEAT_MRAD = 0.12;     // 心拍による揺れの振幅 (72 bpm 時)
const RELEASE_TORQUE_SIGMA = 3.0;  // リリース時の手のトルクのばらつき [N·m] (skill=1)
const BOW_TO_ARROW = 0.6;        // 矢が離れる瞬間のボウの傾きのうち矢の向きに伝わる割合
// 指離れ (右利き): 弦は指先から外れるとき左 (−x) へ弾かれる。平均と、上手さ (skill) に比例するばらつき [m/s]
const RELEASE_KICK = -1.2;
const RELEASE_KICK_SIGMA = 0.25;
// センターショット: 矢の先端を弦より少し外 (左) に出すのが基準。plungerOffsetMm はそこからのずれ
const CENTERSHOT_MM = 2;
const NOCK_OPT_MM = 10, TILLER_OPT_MM = 4;
const RAIN_MRAD = 0.7;           // 雨 (強さ 1) による発射方向のばらつき (各軸の標準偏差)
const NOISE_STD = 0.28 * Math.hypot(1, 0.5);
// 射手はシューティングラインをまたいで立つ。体の中心 (=ライン) はアンカー位置よりこれだけ後ろ [m]
export const STANCE_BEHIND_ANCHOR = 0.16;

/** 弾道計算の環境: 空気 (気温・標高・湿度)、緯度・標高による重力、地球の自転 (緯度と的の方位) */
export function flightEnvironment(env) {
  const air = airProperties(env);
  const lat = env.latitudeDeg ?? 35.7;
  return {
    rho: air.rho, nu: air.nu, air,
    g: gravityAt(lat, env.altitudeM ?? 0),
    coriolis: env.coriolis === false ? null : coriolis(lat, env.rangeAzimuthDeg ?? 0),
  };
}

export function prepare(setup) {
  const drawIn = drawLengthIn(setup.player);
  const lbs = effectiveLbs(setup.bow, drawIn);
  const arrow = arrowProperties(setup.arrow, lbs, setup.bow.plungerK);
  const model = bowMassModel(setup.bow, setup.stabilizer);
  const I = inertiaTensor(model.points);
  const cDamp = dampingCoefficient(setup.stabilizer);
  // 発射: ボウの集中定数モデルでパワーストロークを解く (初速・矢が離れるまでの時間・加速度の時間変化)
  const bowModel = buildBowModel(setup.bow);
  const stroke = powerStroke(bowModel, drawIn, arrow.mass, setup.bow.eta, REST_FRICTION[setup.bow.rest] * 0.06);
  const v0 = stroke.v0;
  const hArrow = setup.player.heightCm * 0.0083;
  const eye = [0, hArrow + EYE_ABOVE_ARROW, -nockDistanceM(drawIn)];
  // 射距離はシューティングラインから的面まで (WA 規則)。ボウ (z=0) はラインより前に出ているので、
  // ボウから的までの距離 D は射距離より短い。
  const lineZ = eye[2] - STANCE_BEHIND_ANCHOR;
  const D = setup.environment.distance + lineZ;
  const eyeElev = Math.atan2(TARGET_CENTER_HEIGHT - eye[1], D - eye[2]);
  const skill = setup.player.skill;
  const swaySigma = {
    // 腕ごと揺れるので、腕の慣性を足した実効慣性モーメントの平方根に反比例させる
    elev: skill * SWAY_MRAD * MRAD * Math.sqrt((I_REF.pitch + HAND_INERTIA[0]) / (I[0][0] + HAND_INERTIA[0])),
    azim: skill * SWAY_MRAD * MRAD * Math.sqrt((I_REF.yaw + HAND_INERTIA[1]) / (I[1][1] + HAND_INERTIA[1])),
  };
  return {
    drawIn, lbs, arrow, model, I, cDamp, v0, hArrow, eye, eyeElev, swaySigma, D, lineZ,
    bowModel, stroke, energy: potential(bowModel, nockDistanceM(drawIn)),
    beam: buildArrowBeam(arrow, setup.arrow.pointGrain * GRAIN, VANE_MATERIALS[setup.arrow.vaneMaterial].rearGrain * GRAIN),
    bowTension: { brace: stringTension(bowModel, bowModel.g.sB), full: stringTension(bowModel, nockDistanceM(drawIn)) },
    vib: limbVibration(setup.bow, setup.stabilizer, drawIn, arrow.mass, model.mass, bowModel, v0),
    flightEnv: flightEnvironment(setup.environment),
    face: faceDiameterCm(setup.environment.distance),
    swayNoise: createNoise4D(setup.environment.seed + 101),
  };
}

/**
 * パラドックスの有限要素計算 (水平面) を、セットアップとパワーストロークから組み立てて解く
 * @param {object} ps  powerStroke の結果
 * @param {{ releaseVel?: number, yaw?: (t:number) => number }} o  指離れの横速度 (既定は平均)、ボウのヨー
 */
export function paradoxLaunch(setup, prep, ps, o = {}) {
  const { bow } = setup;
  const arrow = prep.arrow;
  return simulateParadox(prep.beam, {
    stroke: ps.samples, tExit: ps.tExit, v0: ps.v0, sBrace: prep.bowModel.g.sB,
    tension: (x) => stringTension(prep.bowModel, x), ell: prep.bowModel.g.ell, stringLatMass: (bow.stringMassG ?? 8) / 3000,
    releaseVel: o.releaseVel ?? RELEASE_KICK, yaw: o.yaw ?? (() => 0),
    plungerK: bow.plungerK, plungerPreload: bow.plungerPreloadN ?? 2,
    plungerX: -(CENTERSHOT_MM + bow.plungerOffsetMm) / 1000, gamma: arrow.paradox.gamma, fSpine: arrow.fSpine,
  });
}

/** 時刻 t における照準の揺れ [rad]。3D ビューの照準表示と射撃結果の両方がこの関数を使う。 */
export function aimSway(setup, prep, t) {
  const n = prep.swayNoise;
  const slow = (k) => (n(t * 0.55, k, 0, 0) + 0.5 * n(t * 1.7, k + 10, 0, 0)) / NOISE_STD;
  const hb = HEARTBEAT_MRAD * MRAD * setup.player.skill * (setup.player.heartRate / 72);
  const beat = Math.sin(2 * Math.PI * (setup.player.heartRate / 60) * t);
  return {
    elev: prep.swaySigma.elev * slow(1) + hb * beat,
    azim: prep.swaySigma.azim * slow(2) + 0.3 * hb * beat,
  };
}

const dirFromAngles = (elev, azim) => [Math.sin(azim) * Math.cos(elev), Math.sin(elev), Math.cos(azim) * Math.cos(elev)];

/**
 * @param {object} setup  config.defaultSetup() 形式
 * @param {object} prep   prepare(setup)
 * @param {object} o
 * @param {boolean} [o.noise=true]  false なら手ブレ等のばらつきを除いた理想射 (サイト合わせ用)
 * @param {object}  [o.rng]         createRng() の戻り値
 * @param {object}  [o.wind]        createWindField() の戻り値
 * @param {number}  [o.time=0]      射撃時刻 [s] (風・照準揺れの時刻)
 * @param {boolean} [o.bowMotion=false] フォロースルーの姿勢列を返すか
 * @param {object}  [o.sway]        照準の揺れを外から与える (UI で表示していた揺れをそのまま使う)
 * @param {number}  [o.drawDeltaIn=0] クリッカー前リリースなどによる引き尺の増減 [inch]
 * @param {number}  [o.rain=0]   雨の強さ (0=なし, 1=雨, 1.4=雷雨)。濡れた手・グリップと雨粒で発射方向がばらつく
 */
export function shoot(setup, prep, o = {}) {
  const noise = o.noise ?? true;
  const rng = o.rng ?? createRng(1);
  const N = (s) => (noise ? rng.normal(0, s) : 0);
  const wind = o.wind ?? calmWind;
  const time = o.time ?? 0;
  const { bow, player } = setup;
  const arrow = prep.arrow;
  const mu = REST_FRICTION[bow.rest];

  // クリッカー: 自然な引き尺からずれた位置に設定すると、切るまでの引き量がばらつく
  const drawSigma = player.skill * (0.03 + 0.008 * Math.abs(bow.clickerOffsetMm));
  const drawIn = prep.drawIn + bow.clickerOffsetMm / 25.4 + (o.drawDeltaIn ?? 0) + N(drawSigma);
  const ps = powerStroke(prep.bowModel, drawIn, arrow.mass, bow.eta, mu * 0.06);
  const v0 = ps.v0;
  const tExit = ps.tExit;

  // 4.2: リリース瞬間のトルク。ティラーずれ・センターずれで系統的な成分が、手の力みでランダム成分が加わる。
  const F = effectiveLbs(bow, drawIn) * LBF;
  const tuneSpread = 1 + 0.1 * Math.abs(bow.tillerMm - TILLER_OPT_MM);
  const ts = RELEASE_TORQUE_SIGMA * player.skill * tuneSpread;
  const torque0 = [
    F * (0.02 + 0.0006 * (bow.tillerMm - TILLER_OPT_MM)) + N(ts),
    F * bow.plungerOffsetMm * 3e-4 + N(ts),
    N(0.3 * ts),
  ];
  // リムの振動: 矢が離れた瞬間 (tExit) から始まり、上下の振幅差がハンドルを揺する
  const limbVib = limbVibration(bow, setup.stabilizer, drawIn, arrow.mass, prep.model.mass, prep.bowModel, v0);
  const motion = simulateBowRelease(prep.model, prep.I, {
    torque0, cDamp: prep.cDamp, duration: o.bowMotion ? 1.6 : tExit + 0.001, probeTime: tExit, sampleEvery: 1 / 60,
    extraTorque: (t) => [vibrationTorque(limbVib, t - tExit), 0, 0],
  });
  const rv = motion.probe.rv;

  // 4.3 アーチャーズ・パラドックス (水平面): 指離れ・弦・プランジャー・ボウのヨーと矢のしなりを有限要素で解く
  const fine = simulateBowRelease(prep.model, prep.I, {
    torque0, cDamp: prep.cDamp, duration: tExit + 0.012, sampleEvery: 0.0005,
    extraTorque: (t) => [vibrationTorque(limbVib, t - tExit), 0, 0],
  }).samples.map((x) => ({ t: x.t, yaw: rotationVector(x.q)[1] }));
  const yawAt = (t) => {
    let i = 0;
    while (i < fine.length - 2 && fine[i + 1].t < t) i++;
    const A = fine[i], B = fine[Math.min(i + 1, fine.length - 1)];
    return B.t > A.t ? A.yaw + ((B.yaw - A.yaw) * (t - A.t)) / (B.t - A.t) : A.yaw;
  };
  const releaseVel = RELEASE_KICK + N(RELEASE_KICK_SIGMA * player.skill);
  const fe = paradoxLaunch(setup, prep, ps, { releaseVel, yaw: yawAt });
  const paradox = { A0: fe.flex.A0, gamma: arrow.paradox.gamma, f: arrow.fSpine, phase: fe.flex.phase };

  const sway = !noise ? { elev: 0, azim: 0 } : (o.sway ?? aimSway(setup, prep, time));
  const aim = aimAngles(setup.sight, prep.eyeElev);
  const parts = {
    sway,
    // 上下はボウのピッチの一部が矢に伝わる。左右 (ヨー) の影響はパラドックスの計算に含まれる
    bowKick: { elev: -BOW_TO_ARROW * rv[0], azim: 0 },
    tuning: {
      elev: -0.4 * MRAD * (bow.tillerMm - TILLER_OPT_MM) - 0.2 * MRAD * (bow.nockingMm - NOCK_OPT_MM),
      azim: 0,
    },
    paradox: { elev: 0, azim: fe.vCg / v0 },
    rest: { elev: N(1.2 * mu * MRAD), azim: N(2.5 * mu * MRAD) },
  };
  const rain = o.rain ?? 0;
  if (rain > 0) parts.rain = { elev: N(RAIN_MRAD * MRAD * rain), azim: N(RAIN_MRAD * MRAD * rain) };
  let elev = aim.elev, azim = aim.azim;
  for (const k of Object.keys(parts)) {
    elev += parts[k].elev;
    azim += parts[k].azim;
  }
  const dir = dirFromAngles(elev, azim);
  // ノッキングポイントのずれは矢の姿勢 (機首の上下) のずれとして発射時に残る
  const attitudePitch = -((bow.nockingMm - NOCK_OPT_MM) / 1000) / (0.5 * arrow.L);
  // 矢の軸の向きは飛ぶ向きと少しずれて出る (パラドックスの剛体回転)。首振りの角速度も引き継ぐ
  const axis = dirFromAngles(elev + attitudePitch, azim + (fe.angle - fe.vCg / v0));
  const flightArrow = { ...arrow, paradox };

  const flight = simulateFlight({ r: [0, prep.hArrow, 0], v: dir.map((c) => c * v0), d: axis, w: [0, fe.omega, 0] }, flightArrow, wind, {
    targetZ: prep.D, t0: time, recordEvery: o.recordEvery ?? 0.004, env: prep.flightEnv,
  });
  const dx = flight.impact.r[0];
  const dy = flight.impact.r[1] - TARGET_CENTER_HEIGHT;
  const score = flight.reached ? scoreArrow(Math.hypot(dx, dy), prep.face, arrow.r) : { value: 0, label: 'M', x: false };

  return {
    v0, drawIn, tExit, elev, azim, parts, torque0, limbVib, paradox,
    plungerForceMax: fe.plungerForceMax, releaseVel, paradoxAngle: fe.angle,
    flight, dx, dy, score,
    bowMotion: o.bowMotion ? motion.samples : null,
    impactSpeed: flight.reached ? Math.hypot(...flight.impact.v) : 0,
    flightTime: flight.impact.t,
  };
}

/** 理想射 (ばらつきなし・無風) が的中心に当たるようにサイトを合わせる */
export function autoSight(setup, prep, iterations = 8) {
  let sight = { ...setup.sight };
  for (let i = 0; i < iterations; i++) {
    const r = shoot({ ...setup, sight }, prep, { noise: false });
    if (!r.flight.reached) {
      sight = { ...sight, yMm: sight.yMm - 20 };
      continue;
    }
    sight = applyCorrection(sight, r.dx, r.dy, prep.D);
    if (Math.hypot(r.dx, r.dy) < 1e-4) break;
  }
  return sight;
}
