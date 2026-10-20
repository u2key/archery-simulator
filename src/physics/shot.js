// 1本の射撃を、照準 → クリッカー → リリース反動 → パラドックス → 飛翔 → 採点 の順に計算する。
import { LBF, INCH, MRAD } from './units.js';
import { createRng } from './random.js';
import { createNoise4D } from './simplex.js';
import { REST_FRICTION } from './config.js';
import {
  drawLengthIn, effectiveLbs, launchSpeed, bowMassModel, inertiaTensor, dampingCoefficient, simulateBowRelease, HAND_INERTIA,
} from './bow.js';
import { arrowProperties } from './arrow.js';
import { simulateFlight } from './ballistics.js';
import { calmWind } from './wind.js';
import { aimAngles, applyCorrection, EYE_ABOVE_ARROW } from './sight.js';
import { scoreArrow, faceDiameterCm, TARGET_CENTER_HEIGHT } from './scoring.js';

// 揺れの基準とする慣性モーメント (既定セットアップの値) [kg·m²]
const I_REF = { pitch: 0.286, yaw: 0.125 };
const SWAY_MRAD = 0.85;          // skill=1, I=I_REF での照準揺れ (各軸の標準偏差)
const HEARTBEAT_MRAD = 0.12;     // 心拍による揺れの振幅 (72 bpm 時)
const RELEASE_TORQUE_SIGMA = 3.0;  // リリース時の手のトルクのばらつき [N·m] (skill=1)
const BOW_TO_ARROW = 0.6;        // 矢が離れる瞬間のボウの傾きのうち矢の向きに伝わる割合
const SPINE_YAW_MRAD = 4;        // スパイン不一致 100% あたりの左右偏差
const NOCK_OPT_MM = 10, TILLER_OPT_MM = 4;
const NOISE_STD = 0.28 * Math.hypot(1, 0.5);

export function prepare(setup) {
  const drawIn = drawLengthIn(setup.player);
  const lbs = effectiveLbs(setup.bow, drawIn);
  const arrow = arrowProperties(setup.arrow, lbs, setup.bow.plungerK);
  const model = bowMassModel(setup.bow, setup.stabilizer);
  const I = inertiaTensor(model.points);
  const cDamp = dampingCoefficient(setup.stabilizer);
  const v0 = launchSpeed(setup.bow, drawIn, arrow.mass, REST_FRICTION[setup.bow.rest] * 0.06);
  const hArrow = setup.player.heightCm * 0.0083;
  const eye = [0, hArrow + EYE_ABOVE_ARROW, -drawIn * INCH];
  const D = setup.environment.distance;
  const eyeElev = Math.atan2(TARGET_CENTER_HEIGHT - eye[1], D - eye[2]);
  const skill = setup.player.skill;
  const swaySigma = {
    // 腕ごと揺れるので、腕の慣性を足した実効慣性モーメントの平方根に反比例させる
    elev: skill * SWAY_MRAD * MRAD * Math.sqrt((I_REF.pitch + HAND_INERTIA[0]) / (I[0][0] + HAND_INERTIA[0])),
    azim: skill * SWAY_MRAD * MRAD * Math.sqrt((I_REF.yaw + HAND_INERTIA[1]) / (I[1][1] + HAND_INERTIA[1])),
  };
  return {
    drawIn, lbs, arrow, model, I, cDamp, v0, hArrow, eye, eyeElev, swaySigma, D,
    face: faceDiameterCm(D),
    swayNoise: createNoise4D(setup.environment.seed + 101),
  };
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
  const v0 = launchSpeed(bow, drawIn, arrow.mass, mu * 0.06);
  const stroke = (drawIn - bow.braceIn) * INCH;
  const tExit = (2 * stroke) / v0;

  // 4.2: リリース瞬間のトルク。ティラーずれ・センターずれで系統的な成分が、手の力みでランダム成分が加わる。
  const F = effectiveLbs(bow, drawIn) * LBF;
  const tuneSpread = 1 + 1.5 * Math.abs(arrow.effMismatch) + 0.1 * Math.abs(bow.tillerMm - TILLER_OPT_MM);
  const ts = RELEASE_TORQUE_SIGMA * player.skill * tuneSpread;
  const torque0 = [
    F * (0.02 + 0.0006 * (bow.tillerMm - TILLER_OPT_MM)) + N(ts),
    F * bow.plungerOffsetMm * 3e-4 + N(ts),
    N(0.3 * ts),
  ];
  const motion = simulateBowRelease(prep.model, prep.I, {
    torque0, cDamp: prep.cDamp, duration: o.bowMotion ? 1.6 : tExit + 0.001, probeTime: tExit, sampleEvery: 1 / 60,
  });
  const rv = motion.probe.rv;

  const sway = !noise ? { elev: 0, azim: 0 } : (o.sway ?? aimSway(setup, prep, time));
  const aim = aimAngles(setup.sight, prep.eyeElev);
  const parts = {
    sway,
    bowKick: { elev: -BOW_TO_ARROW * rv[0], azim: BOW_TO_ARROW * rv[1] },
    tuning: {
      elev: -0.4 * MRAD * (bow.tillerMm - TILLER_OPT_MM) - 0.2 * MRAD * (bow.nockingMm - NOCK_OPT_MM),
      azim: SPINE_YAW_MRAD * MRAD * arrow.effMismatch - (bow.plungerOffsetMm / 1000) / 1.2,
    },
    rest: { elev: N(1.2 * mu * MRAD), azim: N(2.5 * mu * MRAD) },
  };
  let elev = aim.elev, azim = aim.azim;
  for (const k of Object.keys(parts)) {
    elev += parts[k].elev;
    azim += parts[k].azim;
  }
  const dir = dirFromAngles(elev, azim);
  // ノッキングポイントのずれは矢の姿勢 (機首の上下) のずれとして発射時に残る
  const attitudePitch = -((bow.nockingMm - NOCK_OPT_MM) / 1000) / (0.5 * arrow.L);
  const axis = dirFromAngles(elev + attitudePitch, azim);

  const flight = simulateFlight({ r: [0, prep.hArrow, 0], v: dir.map((c) => c * v0), d: axis }, arrow, wind, {
    targetZ: prep.D, t0: time, recordEvery: o.recordEvery ?? 0.004,
  });
  const dx = flight.impact.r[0];
  const dy = flight.impact.r[1] - TARGET_CENTER_HEIGHT;
  const score = flight.reached ? scoreArrow(Math.hypot(dx, dy), prep.face, arrow.r) : { value: 0, label: 'M', x: false };

  return {
    v0, drawIn, tExit, elev, azim, parts, torque0,
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
