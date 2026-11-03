// アーチャーズ・パラドックス (水平面): 矢を有限要素の梁で解き、指離れ・弦・プランジャーとの相互作用から
// 発射方向の左右のずれと、離れた後のしなり (振幅・位相) を求める。
//
// ・矢: オイラー・ベルヌーイ梁 (エルミート 3 次要素、節点ごとに横変位 w と傾き θ)。シャフトの分布質量
//   + ポイント (先端) + ノック・ベイン (後端)。曲げ剛性 EI はスパインから。
// ・軸圧縮: 弦がノックを押して矢を加速するので、断面 ξ には「そこより前の質量 × 加速度」の圧縮力が働く。
//   幾何剛性 K_G として曲げ剛性を下げる (柔らかい矢ほど大きくしなる理由の一つ)。
// ・弦: ノックを横方向に引き戻すバネ (k = 2T/ℓ、T は弦の張力)。弦の中心面はボウのヨー回転と一緒に動く。
//   指離れで弦は左 (−x、右利き) へ弾かれる: ノックの初速として与える。弦が離れた後はノックは自由。
// ・プランジャー: ハンドル側 (+x) から矢を支える。矢がハンドル側へ押すと、予圧を超えるまでは動かず、
//   超えるとバネ (k_p) で縮み、ストロークを使い切るとハンドルに当たる。触れる位置は矢の前進とともに後ろへ移る。
// ・減衰: 質量比例 (すべてのモードが材質ごとの減衰率 γ で減衰する)。
// 積分は速度ベルレ法 (陽解法)。ノックがプランジャーを通過したら終わり、剛体運動 (重心の横速度・軸の向き・
// 首振り角速度) と残ったしなりを返す。
import { spineToEI } from './arrow.js';

const ELEMENTS = 12;      // 要素数 (16 との差は 0.2 mrad 程度)。増やすときは陽解法の安定のため DT も小さくする
const DT = 5e-6;
const K_HARD = 3e5;               // プランジャーの予圧以下・ストロークの終わり (ハンドル) の接触剛性 [N/m]
const PLUNGER_TRAVEL = 0.003;     // プランジャーのストローク [m]
const PLUNGER_Z = 0.0;            // プランジャーの前後位置 (ピボットから的方向) [m]

function elementMatrices(EI, mu, h) {
  const k = EI / h ** 3;
  const K = [
    [12 * k, 6 * h * k, -12 * k, 6 * h * k],
    [6 * h * k, 4 * h * h * k, -6 * h * k, 2 * h * h * k],
    [-12 * k, -6 * h * k, 12 * k, -6 * h * k],
    [6 * h * k, 2 * h * h * k, -6 * h * k, 4 * h * h * k],
  ];
  const m = (mu * h) / 420;
  const M = [
    [156 * m, 22 * h * m, 54 * m, -13 * h * m],
    [22 * h * m, 4 * h * h * m, 13 * h * m, -3 * h * h * m],
    [54 * m, 13 * h * m, 156 * m, -22 * h * m],
    [-13 * h * m, -3 * h * h * m, -22 * h * m, 4 * h * h * m],
  ];
  // 幾何剛性 (圧縮力 1 N あたり)
  const g = 1 / (30 * h);
  const KG = [
    [36 * g, 3 * h * g, -36 * g, 3 * h * g],
    [3 * h * g, 4 * h * h * g, -3 * h * g, -h * h * g],
    [-36 * g, -3 * h * g, 36 * g, -3 * h * g],
    [3 * h * g, -h * h * g, -3 * h * g, 4 * h * h * g],
  ];
  return { K, M, KG };
}

function invert(A) {
  const n = A.length;
  const M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f !== 0) for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((r) => Float64Array.from(r.slice(n)));
}

const matVec = (A, x, out) => {
  for (let i = 0; i < A.length; i++) {
    let s = 0;
    const r = A[i];
    for (let j = 0; j < x.length; j++) s += r[j] * x[j];
    out[i] = s;
  }
  return out;
};

/** エルミート形状関数 (要素内の位置 x、要素長 h) */
function shape(x, h) {
  const u = x / h;
  return [1 - 3 * u * u + 2 * u ** 3, h * (u - 2 * u * u + u ** 3), 3 * u * u - 2 * u ** 3, h * (u ** 3 - u * u)];
}

/**
 * 矢の有限要素モデル (発射ごとに変わらない部分)
 * @param {object} a  arrowProperties の結果
 */
export function buildArrowBeam(a, mPoint, mRear) {
  const n = ELEMENTS, L = a.L, h = L / n, dof = 2 * (n + 1);
  const EI = a.EI;
  const mu = Math.max(1e-4, (a.mass - mPoint - mRear) / L);
  const K = Array.from({ length: dof }, () => new Float64Array(dof));
  const M = Array.from({ length: dof }, () => new Float64Array(dof));
  const KG1 = Array.from({ length: dof }, () => new Float64Array(dof));   // 加速度 1 m/s² あたりの幾何剛性
  const em = elementMatrices(EI, mu, h);
  for (let e = 0; e < n; e++) {
    // 要素中央より前 (先端側) の質量 = 圧縮力 / 加速度
    const xi = (e + 0.5) * h;
    const ahead = mu * (L - xi) + mPoint;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const I = 2 * e + i, J = 2 * e + j;
      K[I][J] += em.K[i][j];
      M[I][J] += em.M[i][j];
      KG1[I][J] += ahead * em.KG[i][j];
    }
  }
  M[0][0] += mRear;              // ノック・ベイン (後端)
  M[dof - 2][dof - 2] += mPoint; // ポイント (先端)
  // 剛体モード (並進・重心まわりの回転) の取り出し用
  const trans = new Float64Array(dof), rot = new Float64Array(dof);
  for (let i = 0; i <= n; i++) trans[2 * i] = 1;
  const Mt = matVec(M, trans, new Float64Array(dof));
  const mass = trans.reduce((s, v, i) => s + v * Mt[i], 0);
  const first = Array.from({ length: n + 1 }, (_, i) => i * h).reduce((s, x, i) => s + x * Mt[2 * i], 0) / mass;
  for (let i = 0; i <= n; i++) { rot[2 * i] = i * h - first; rot[2 * i + 1] = 1; }
  const Mr = matVec(M, rot, new Float64Array(dof));
  const Irot = rot.reduce((s, v, i) => s + v * Mr[i], 0);
  return { n, L, h, dof, K, M, KG1, trans, rot, Mt, Mr, mass, Irot, xCg: first, EI, mu, mPoint, mRear };
}

/**
 * @param {object} beam   buildArrowBeam の結果
 * @param {object} o
 * @param {{t,s,v,a}[]} o.stroke   パワーストロークのサンプル (s: ピボットからノックまで [m])
 * @param {number} o.tExit, o.v0, o.sBrace
 * @param {(s:number) => number} o.tension  弦の張力 [N]
 * @param {number} o.ell        弦の半分の長さ [m]
 * @param {number} o.stringLatMass 弦の横方向の等価質量 [kg]
 * @param {number} o.releaseVel 指離れで弦が弾かれる横速度 [m/s] (左 = 負)
 * @param {(t:number) => number} o.yaw ボウのヨー角 [rad] (右 = 正)
 * @param {number} o.plungerK, o.plungerPreload [N/m, N]
 * @param {number} o.plungerX   プランジャー先端の位置 (センターショットからの横ずれ, 右 = 正) [m]
 * @param {number} o.gamma      しなりの減衰率 [1/s]
 */
export function simulateParadox(beam, o) {
  const { n, h, dof, K, KG1, L } = beam;
  // 弦が付いている間は弦の横方向の質量がノックに乗る
  const Mattached = beam.M.map((r) => Float64Array.from(r));
  Mattached[0][0] += o.stringLatMass;
  const MinvA = invert(Mattached.map((r) => [...r]));
  const MinvF = invert(beam.M.map((r) => [...r]));

  // 弦の横剛性 2T/ℓ はストロークのサンプルごとに前もって求めておく (毎ステップ張力を解かない)
  const S = o.stroke;
  const kLatTable = S.map((x) => (2 * o.tension(x.s)) / o.ell);
  let si = 0;   // 時刻は単調に進むので、サンプルの位置を覚えておく
  const st = { s: 0, a: 0, kLat: 0, attached: true };
  const strokeAt = (t) => {
    if (t >= o.tExit) {
      st.s = o.sBrace - o.v0 * (t - o.tExit); st.a = 0; st.kLat = 0; st.attached = false;
      return st;
    }
    while (si < S.length - 2 && S[si + 1].t < t) si++;
    const A = S[si], B = S[si + 1];
    const u = B.t > A.t ? Math.min(1, Math.max(0, (t - A.t) / (B.t - A.t))) : 0;
    st.s = A.s + (B.s - A.s) * u;
    st.a = A.a + (B.a - A.a) * u;
    st.kLat = kLatTable[si] + (kLatTable[si + 1] - kLatTable[si]) * u;
    st.attached = true;
    return st;
  };

  // 初期状態: まっすぐ・静止 (フルドローでノックは弦の中心面、矢はプランジャーに触れている)
  const q = new Float64Array(dof), v = new Float64Array(dof), f = new Float64Array(dof);
  const tmp = new Float64Array(dof), tmp2 = new Float64Array(dof), acc = new Float64Array(dof);
  // フルドロー: ノックは弦の中心面 (x=0)、矢はプランジャー先端 (x = plungerX) に触れている直線
  const xi0 = PLUNGER_Z + o.stroke[0].s;
  for (let i = 0; i <= n; i++) {
    q[2 * i] = (o.plungerX * (i * h)) / xi0;
    q[2 * i + 1] = o.plungerX / xi0;
  }
  v[0] = o.releaseVel;                                  // 指離れで後端が横に弾かれる
  let plungerForceMax = 0, contactEnded = false;
  const dotM = (modeM, x) => { let s = 0; for (let i = 0; i < x.length; i++) s += modeM[i] * x[i]; return s; };

  const plungerForce = (g) => {
    if (g <= 0) return 0;
    const gPre = o.plungerPreload / K_HARD;
    if (g <= gPre) return K_HARD * g;
    const travel = g - gPre;
    if (travel <= PLUNGER_TRAVEL) return o.plungerPreload + o.plungerK * travel;
    return o.plungerPreload + o.plungerK * PLUNGER_TRAVEL + K_HARD * (travel - PLUNGER_TRAVEL);
  };

  const accel = (t, out) => {
    const st = strokeAt(t);
    matVec(K, q, tmp);
    if (st.a !== 0) {
      matVec(KG1, q, tmp2);
      for (let i = 0; i < dof; i++) tmp[i] -= st.a * tmp2[i];   // 圧縮で剛性が下がる
    }
    for (let i = 0; i < dof; i++) f[i] = -tmp[i];
    if (st.attached) {
      // 弦の横バネ: 中心面はボウのヨーで動く (ノックはピボットの s 後ろ)
      const xc = -st.s * o.yaw(t);
      f[0] += -st.kLat * (q[0] - xc);
    }
    // プランジャー: 矢の上でいまプランジャーの位置にある点
    const xiC = PLUNGER_Z + st.s;
    if (xiC > 0 && xiC < L) {
      const e = Math.min(n - 1, Math.floor(xiC / h));
      const N = shape(xiC - e * h, h);
      let w = 0;
      for (let i = 0; i < 4; i++) w += N[i] * q[2 * e + i];
      const xp = o.plungerX + PLUNGER_Z * o.yaw(t);
      const F = plungerForce(w - xp);
      if (F > plungerForceMax) plungerForceMax = F;
      for (let i = 0; i < 4; i++) f[2 * e + i] -= F * N[i];
    } else if (xiC <= 0) {
      contactEnded = true;
    }
    matVec(st.attached ? MinvA : MinvF, f, out);
    // 質量比例減衰 (各モードが e^{−γt} で減衰)。剛体運動 (並進・回転) は減衰させないよう、しなりの成分だけに掛ける
    const vc = dotM(beam.Mt, v) / beam.mass, wc = dotM(beam.Mr, v) / beam.Irot;
    for (let i = 0; i < dof; i++) out[i] -= 2 * o.gamma * (v[i] - vc * beam.trans[i] - wc * beam.rot[i]);
    return out;
  };

  let t = 0;
  accel(0, acc);
  const tEnd = o.tExit + (o.sBrace + PLUNGER_Z) / Math.max(o.v0, 1) + 0.0005;
  const vh = new Float64Array(dof);
  while (t < tEnd) {
    for (let i = 0; i < dof; i++) {
      vh[i] = v[i] + 0.5 * DT * acc[i];
      q[i] += DT * vh[i];
    }
    t += DT;
    for (let i = 0; i < dof; i++) v[i] = vh[i];
    accel(t, acc);
    for (let i = 0; i < dof; i++) v[i] = vh[i] + 0.5 * DT * acc[i];
  }

  // 剛体成分: 重心の横変位・横速度、軸の角度・角速度
  const xCgPos = dotM(beam.Mt, q) / beam.mass;
  const vCg = dotM(beam.Mt, v) / beam.mass;
  const angle = dotM(beam.Mr, q) / beam.Irot;
  const omega = dotM(beam.Mr, v) / beam.Irot;
  // 残ったしなり (剛体成分を除く) の後端での振幅
  const flex = (x, a0, a1) => x.map((val, i) => val - a0 * beam.trans[i] - a1 * beam.rot[i]);
  const qf = flex(Array.from(q), xCgPos, angle);
  const vf = flex(Array.from(v), vCg, omega);
  const omega1 = 2 * Math.PI * o.fSpine;
  const tailDisp = qf[0], tailVel = vf[0];
  const amp = Math.hypot(tailDisp, tailVel / omega1);
  const phase = Math.atan2(tailDisp, tailVel / omega1);
  return {
    vCg, angle, omega, xCg: xCgPos, tEnd,
    flex: { A0: amp, phase },
    plungerForceMax,
    contactEnded,
    shape: Array.from({ length: n + 1 }, (_, i) => q[2 * i]),
  };
}

export { spineToEI };
