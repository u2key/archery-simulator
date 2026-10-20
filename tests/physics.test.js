import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LBF, INCH, GRAIN, G } from '../src/physics/units.js';
import { defaultSetup } from '../src/physics/config.js';
import {
  drawLengthFromHeight, effectiveLbs, storedEnergy, launchSpeed, bowMassModel, inertiaTensor,
  dampingCoefficient, simulateBowRelease, rotationVector,
} from '../src/physics/bow.js';
import { arrowProperties, spineToEI, paradoxDeflection } from '../src/physics/arrow.js';
import { simulateFlight } from '../src/physics/ballistics.js';
import { createWindField, calmWind } from '../src/physics/wind.js';
import { createNoise4D } from '../src/physics/simplex.js';
import { scoreArrow, createScoreCard, addArrow, summary, isComplete } from '../src/physics/scoring.js';
import { aimAngles, applyCorrection } from '../src/physics/sight.js';
import { prepare, shoot, autoSight } from '../src/physics/shot.js';
import { createRng } from '../src/physics/random.js';
import { qRotate, matVec } from '../src/physics/vec.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}±${tol}, got ${a}`);

// 揚力・抗力を持たない仮想の矢 (解析解との比較用)
const vacuumArrow = (mass = 0.02) => ({
  mass, d: 0.005, r: 0.0025, area: 2e-5, inertiaT: 1e-3, dragArea: 0, normalArea: 0, momentArea: 0,
  dampArea: 0, spinPitch: 1e9, cm: 0, paradox: { A0: 0, gamma: 1, f: 1 },
});

test('3.1 引き尺は身長 × 0.38 / 2.54', () => {
  close(drawLengthFromHeight(175), 26.181, 1e-3);
});

test('3.2 実効ポンドは28インチで表示ポンドに一致し、引き尺に比例して増える', () => {
  const bow = defaultSetup().bow;
  close(effectiveLbs(bow, 28), bow.markedLbs, 1e-9);
  assert.ok(effectiveLbs(bow, 27) < effectiveLbs(bow, 28));
  assert.equal(effectiveLbs(bow, bow.braceIn - 1), 0);
});

test('4.1 蓄積エネルギーと初速は spec の式どおり', () => {
  const bow = { ...defaultSetup().bow, markedLbs: 40, braceIn: 8, eta: 0.8, effMassG: 5 };
  const E = 0.5 * 40 * LBF * (28 - 8) * INCH;
  close(storedEnergy(bow, 28), E, 1e-9);
  const m = 350 * GRAIN;
  close(launchSpeed(bow, 28, m), Math.sqrt((2 * 0.8 * E) / (m + 0.005)), 1e-9);
  // 軽い矢・高ポンド・低いブレースほど速い
  assert.ok(launchSpeed(bow, 28, m * 0.8) > launchSpeed(bow, 28, m));
  assert.ok(launchSpeed({ ...bow, braceIn: 7.5 }, 28, m) > launchSpeed(bow, 28, m));
});

test('4.2 慣性テンソルは対称・正定値で、スタビが長く重いほど大きい', () => {
  const s = defaultSetup();
  const I = inertiaTensor(bowMassModel(s.bow, s.stabilizer).points);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) close(I[i][j], I[j][i], 1e-12);
  for (let i = 0; i < 3; i++) assert.ok(I[i][i] > 0);
  // 単一質点の解析値
  const Ip = inertiaTensor([{ m: 2, r: [1, 2, 3] }]);
  assert.deepEqual(Ip, [[26, -4, -6], [-4, 20, -12], [-6, -12, 10]]);

  const longer = defaultSetup();
  longer.stabilizer.center.lengthIn = 33;
  longer.stabilizer.center.tipOz = 6;
  const I2 = inertiaTensor(bowMassModel(longer.bow, longer.stabilizer).points);
  assert.ok(I2[0][0] > I[0][0] && I2[1][1] > I[1][1]);
});

test('4.2 リリース後の回転: 慣性が大きいほど跳ねが小さく、ダンパーがあるほど早く収まる', () => {
  const s = defaultSetup();
  const kick = (setup) => {
    const model = bowMassModel(setup.bow, setup.stabilizer);
    const I = inertiaTensor(model.points);
    return simulateBowRelease(model, I, { torque0: [3, 3, 0], cDamp: dampingCoefficient(setup.stabilizer), duration: 0.02, probeTime: 0.019 }).probe.rv;
  };
  const bare = defaultSetup();
  bare.stabilizer.center.lengthIn = 0;
  bare.stabilizer.side.count = 0;
  assert.ok(Math.abs(kick(s)[0]) < Math.abs(kick(bare)[0]));
  assert.ok(Math.abs(kick(s)[1]) < Math.abs(kick(bare)[1]));

  // 手が開いた後のフォースルー: センターロッドの重みで上部が前へ倒れる (ピッチ正)
  const fall = (damper) => {
    const st = defaultSetup();
    st.stabilizer.center.damper = damper;
    const model = bowMassModel(st.bow, st.stabilizer);
    const res = simulateBowRelease(model, inertiaTensor(model.points), { torque0: [0, 0, 0], cDamp: dampingCoefficient(st.stabilizer), duration: 0.8 });
    return rotationVector(res.final.q)[0];
  };
  assert.ok(fall(false) > 0.1);
  assert.ok(fall(true) < fall(false));
});

test('4.2 ジャイロ項 ω×(Iω): 自由剛体では角運動量と回転エネルギーが保存される', () => {
  const pts = [{ m: 1, r: [0.3, 0.05, 0] }, { m: 1, r: [-0.3, 0, 0.1] }, { m: 2, r: [0, 0.2, 0.1] }, { m: 2, r: [0.05, -0.2, -0.1] }];
  const I = inertiaTensor(pts);
  const w0 = [3, 1, -2];
  const res = simulateBowRelease({ points: pts, mass: 6, cg: [0, 0, 0] }, I, { torque0: [0, 0, 0], cDamp: 0, duration: 2, free: true, w0 });
  const Lw = (q, w) => qRotate(q, matVec(I, w));
  const E = (w) => 0.5 * (w[0] * matVec(I, w)[0] + w[1] * matVec(I, w)[1] + w[2] * matVec(I, w)[2]);
  const L0 = Lw([1, 0, 0, 0], w0), L1 = Lw(res.final.q, res.final.w);
  for (let i = 0; i < 3; i++) close(L1[i], L0[i], 1e-6, `L[${i}]`);
  close(E(res.final.w), E(w0), 1e-6, 'energy');
  // 主軸からずれた回転なので角速度ベクトル自体は変化している (ジャイロ項が効いている)
  assert.ok(Math.hypot(...res.final.w.map((c, i) => c - w0[i])) > 0.1);
});

test('4.3 スパイン → EI, 振動数, 減衰振動', () => {
  // スパインが小さい (硬い) ほど EI が大きい
  assert.ok(spineToEI(400) > spineToEI(700));
  close(spineToEI(500) / spineToEI(1000), 2, 1e-12);
  const s = defaultSetup();
  const stiff = arrowProperties({ ...s.arrow, spine: 400 }, 38, 800);
  const weak = arrowProperties({ ...s.arrow, spine: 900 }, 38, 800);
  assert.ok(stiff.fSpine > weak.fSpine);
  // f ∝ sqrt(EI)
  close(stiff.fSpine / weak.fSpine, Math.sqrt(spineToEI(400) / spineToEI(900)), 1e-9);
  assert.ok(stiff.mismatch < 0 && weak.mismatch > 0);
  // 固いプランジャーは振幅を減らす
  const soft = arrowProperties(s.arrow, 38, 400), hard = arrowProperties(s.arrow, 38, 1600);
  assert.ok(hard.paradox.A0 < soft.paradox.A0);
  // y_s(t) は t=0 で 0, 包絡線 A0 e^{-γt} を超えない
  const p = soft.paradox;
  assert.equal(paradoxDeflection(p, 0), 0);
  for (let t = 0; t < 0.2; t += 0.001) assert.ok(Math.abs(paradoxDeflection(p, t)) <= p.A0 * Math.exp(-p.gamma * t) + 1e-15);
});

test('FOC: ポイントを重くすると前重心になる', () => {
  const s = defaultSetup();
  const a = arrowProperties(s.arrow, 38, 800);
  const b = arrowProperties({ ...s.arrow, pointGrain: 120 }, 38, 800);
  assert.ok(a.foc > 0.05 && a.foc < 0.2, `FOC ${a.foc}`);
  assert.ok(b.foc > a.foc);
  assert.ok(a.stable);
});

test('4.4 RK4: 空気抵抗なしなら放物線の解析解と一致する', () => {
  const v0 = 50, th = 0.05;
  const res = simulateFlight({ r: [0, 1.5, 0], v: [0, v0 * Math.sin(th), v0 * Math.cos(th)] }, vacuumArrow(), calmWind, { targetZ: 30, dt: 0.001 });
  assert.ok(res.reached);
  const t = 30 / (v0 * Math.cos(th));
  close(res.impact.t, t, 1e-9, 'time');
  close(res.impact.r[1], 1.5 + v0 * Math.sin(th) * t - 0.5 * G * t * t, 1e-6, 'height');
});

test('4.4 抗力で減速し、無風なら左右にずれない', () => {
  const s = defaultSetup();
  const arrow = arrowProperties(s.arrow, 38, 800);
  const res = simulateFlight({ r: [0, 1.5, 0], v: [0, 8, 50], d: [0, 0.16, 1] }, arrow, calmWind, { targetZ: 70 });
  assert.ok(res.reached);
  const vImp = Math.hypot(...res.impact.v);
  assert.ok(vImp < 50 && vImp > 40, `impact speed ${vImp}`);
  // スピンベインのマグヌス力はごく小さい
  assert.ok(Math.abs(res.impact.r[0]) < 0.01, `x ${res.impact.r[0]}`);
});

test('4.4 横風で風下へ流され、向かい風では失速して落ちる', () => {
  const s = defaultSetup();
  const arrow = arrowProperties(s.arrow, 38, 800);
  const fly = (speed, dir) => simulateFlight({ r: [0, 1.5, 0], v: [0, 8, 50], d: [0, 0.16, 1] }, arrow,
    createWindField({ speed, directionDeg: dir, refHeight: 2, shearExp: 1 / 7, turbulence: 0, lengthScale: 25, timeScale: 4, seed: 1 }), { targetZ: 70 });
  const calm = fly(0, 0), right = fly(3, 90), left = fly(3, 270), head = fly(3, 180), tail = fly(3, 0);
  assert.ok(right.impact.r[0] > 0.1, `drift ${right.impact.r[0]}`);
  close(left.impact.r[0], -right.impact.r[0], 0.01);
  assert.ok(head.impact.r[1] < calm.impact.r[1] && tail.impact.r[1] > calm.impact.r[1]);
});

test('4.4 揚力の向き: 機首が上を向いていれば上向きの力が働き、矢は風見安定で速度方向へ向く', () => {
  const s = defaultSetup();
  const arrow = arrowProperties(s.arrow, 38, 800);
  const res = simulateFlight({ r: [0, 1.5, 0], v: [0, 3, 50], d: [0, 0.11, 1] }, arrow, calmWind, { targetZ: 30 });
  const ref = simulateFlight({ r: [0, 1.5, 0], v: [0, 3, 50], d: [0, 0.06, 1] }, arrow, calmWind, { targetZ: 30 });
  assert.ok(res.impact.r[1] > ref.impact.r[1]);
  const last = res.impact;
  const vh = last.v.map((c) => c / Math.hypot(...last.v));
  const ang = Math.acos(last.d[0] * vh[0] + last.d[1] * vh[1] + last.d[2] * vh[2]);
  assert.ok(ang < 0.01, `attitude error ${ang}`);
});

test('4.5 Simplex 4D は連続で [-1,1] に収まり、風は高さのべき乗則に従う', () => {
  const n = createNoise4D(3);
  let max = 0;
  for (let i = 0; i < 2000; i++) {
    const v = n(i * 0.37, i * 0.11, -i * 0.05, i * 0.013);
    max = Math.max(max, Math.abs(v));
    close(n(i * 0.37 + 1e-4, i * 0.11, -i * 0.05, i * 0.013), v, 0.01, 'continuity');
  }
  assert.ok(max <= 1.0 && max > 0.5);
  const w = createWindField({ speed: 4, directionDeg: 90, refHeight: 2, shearExp: 1 / 7, turbulence: 0, lengthScale: 25, timeScale: 4, seed: 1 });
  close(w.at(0, 2, 0, 0)[0], 4, 1e-12);
  close(w.at(0, 8, 0, 0)[0], 4 * Math.pow(4, 1 / 7), 1e-12);
  const turb = createWindField({ speed: 2, directionDeg: 0, refHeight: 2, shearExp: 1 / 7, turbulence: 1, lengthScale: 25, timeScale: 4, seed: 1 });
  let sum = 0, sq = 0;
  for (let i = 0; i < 4000; i++) {
    const x = turb.turbulence(i * 3.1, 1.5, i * 1.7, i * 2.3)[0];
    sum += x;
    sq += x * x;
  }
  const sd = Math.sqrt(sq / 4000 - (sum / 4000) ** 2);
  assert.ok(sd > 0.6 && sd < 1.4, `turbulence sd ${sd}`);
});

test('5 サイト調整: 当たった方向へピンを動かすと着弾がそちらと逆へ戻る', () => {
  const sight = { radiusM: 0.85, xMm: 0, yMm: 50 };
  const a = aimAngles(sight, 0);
  const up = aimAngles({ ...sight, yMm: 55 }, 0), right = aimAngles({ ...sight, xMm: 5 }, 0);
  assert.ok(up.elev < a.elev, '上着弾 → ピンを上 → 狙いが下がる');
  assert.ok(right.azim < a.azim, '右着弾 → ピンを右 → 狙いが左へ');
  const c = applyCorrection(sight, 0.1, 0.2, 18);
  assert.ok(c.xMm > 0 && c.yMm > sight.yMm);
});

test('5 自動サイト合わせ後の理想射は的中心に当たる (18m / 70m)', () => {
  for (const D of [18, 70]) {
    const s = defaultSetup();
    s.environment.distance = D;
    const p = prepare(s);
    s.sight = autoSight(s, p);
    const r = shoot(s, p, { noise: false });
    assert.ok(Math.hypot(r.dx, r.dy) < 0.002, `${D}m: ${r.dx}, ${r.dy}`);
    assert.equal(r.score.label, 'X');
  }
});

test('6 WA 採点: リング境界・ラインカッター・X・M', () => {
  // 122cm 的: リング幅 6.1cm
  assert.equal(scoreArrow(0, 122).label, 'X');
  assert.equal(scoreArrow(0.03, 122).value, 10);
  assert.equal(scoreArrow(0.061, 122).value, 10);
  assert.equal(scoreArrow(0.0611, 122).value, 9);
  assert.equal(scoreArrow(0.0611, 122, 0.0026).value, 10, 'ラインカッターは高い方');
  assert.equal(scoreArrow(0.6, 122).value, 1);
  assert.equal(scoreArrow(0.62, 122).label, 'M');
  // 40cm 的: リング幅 2cm
  assert.equal(scoreArrow(0.025, 40).value, 9);
  assert.equal(scoreArrow(0.19, 40).value, 1);
});

test('6 スコアシート: 6本ごとの小計と12エンド720点満点', () => {
  const card = createScoreCard();
  for (let i = 0; i < 72; i++) assert.ok(addArrow(card, { value: 10, label: 'X', x: true }));
  assert.ok(isComplete(card));
  assert.equal(addArrow(card, { value: 10, label: '10', x: false }), false);
  const sm = summary(card);
  assert.equal(sm.total, 720);
  assert.equal(sm.rows.length, 12);
  assert.equal(sm.rows[0].subtotal, 60);
  assert.equal(sm.rows[11].running, 720);

  const c2 = createScoreCard();
  [7, 10, 9, 0, 8, 10].forEach((v) => addArrow(c2, { value: v, label: String(v), x: false }));
  const s2 = summary(c2);
  assert.equal(s2.rows[0].subtotal, 44);
  assert.deepEqual(s2.rows[0].arrows.map((a) => a.value), [10, 10, 9, 8, 7, 0], '高い順に記入');
});

test('統合: 同じシードなら同じ結果、ギア設定がグルーピングに効く', () => {
  const spread = (mod) => {
    const s = defaultSetup();
    s.environment.distance = 70;
    mod(s);
    const p = prepare(s);
    s.sight = autoSight(s, p);
    const rng = createRng(11);
    let sq = 0;
    for (let i = 0; i < 150; i++) {
      const r = shoot(s, p, { rng, time: i * 20 });
      sq += r.dx * r.dx + r.dy * r.dy;
    }
    return Math.sqrt(sq / 150);
  };
  const base = spread(() => {});
  assert.equal(spread(() => {}), base, '再現性');
  assert.ok(spread((s) => { s.stabilizer.center.lengthIn = 0; s.stabilizer.side.count = 0; }) > base * 1.15, 'スタビなし');
  assert.ok(spread((s) => { s.bow.rest = 'Plastic'; }) > base, 'プラスチックレスト');
  assert.ok(spread((s) => { s.bow.clickerOffsetMm = 8; }) > base * 1.1, 'クリッカー位置ずれ');
  assert.ok(spread((s) => { s.player.skill = 2.5; }) > base * 2, '初心者');
});

test('統合: 既定設定の中級者は 18m で平均 8.5〜9.6 点程度', () => {
  const s = defaultSetup();
  s.environment.distance = 18;
  const p = prepare(s);
  s.sight = autoSight(s, p);
  const rng = createRng(2);
  let total = 0;
  for (let i = 0; i < 120; i++) total += shoot(s, p, { rng, time: i * 20 }).score.value;
  const avg = total / 120;
  assert.ok(avg > 8.5 && avg < 9.6, `avg ${avg}`);
});
