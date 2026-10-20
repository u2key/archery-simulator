// 既定のセットアップ (spec 3章のパラメータ)。UI はこのオブジェクトを丸ごと編集する。
// 単位は spec の表記に合わせ、計算時に SI へ変換する。

export const REST_FRICTION = { Plastic: 0.25, Metal: 0.08 };

// 材質ごとのシャフト外径 [mm] とパラドックス振動の減衰率 γ [1/s]
export const ARROW_MATERIALS = {
  Carbon: { diameterMm: 5.2, gamma: 28, label: 'カーボン' },
  'Aluminum-Carbon': { diameterMm: 5.8, gamma: 20, label: 'アルミカーボン' },
  Aluminum: { diameterMm: 7.1, gamma: 12, label: 'アルミ' },
};

// ベイン形状: 面積 S_v [m^2] (3枚合計), 法線力係数傾斜 C_Nα [1/rad], 抗力面積 C_D·A [m^2], 1回転する飛行距離 [m]
export const VANE_SHAPES = {
  Spin: { area: 13e-4, cnAlpha: 2.2, dragArea: 1.6e-5, spinPitch: 1.6, label: 'スピンベイン' },
  Straight: { area: 10e-4, cnAlpha: 2.2, dragArea: 1.0e-5, spinPitch: 15, label: 'ストレートベイン' },
};

// ベイン材質: 3枚+ノックの質量 [grain], 抗力倍率, 法線力倍率
export const VANE_MATERIALS = {
  Film: { rearGrain: 18, dragMul: 1.0, cnMul: 1.0, label: 'フィルム' },
  Rubber: { rearGrain: 30, dragMul: 1.25, cnMul: 1.0, label: 'ゴム' },
  Feather: { rearGrain: 14, dragMul: 1.6, cnMul: 1.25, label: '羽' },
};

export const TARGET_FACES = {
  18: 40, 25: 60, 30: 80, 50: 122, 60: 122, 70: 122, 90: 122,
};

export function defaultSetup() {
  return {
    player: {
      heightCm: 175,
      drawLengthIn: null,  // null なら身長から自動算出
      skill: 1.0,          // 射手の安定度 (小さいほど上手い。0.5=トップ選手, 1=中級, 2.5=初心者)
      heartRate: 72,       // 心拍数 [bpm]: 照準の揺れに重畳
    },
    bow: {
      markedLbs: 38,       // リム表示ポンド (28インチ時)
      braceIn: 8.75,       // ブレースハイト
      tillerMm: 4,         // ティラー差 (上 − 下)
      plungerOffsetMm: 0,  // プランジャー突き出し量 (センターショット基準からのズレ)
      plungerK: 800,       // プランジャーバネ定数 [N/m]
      rest: 'Metal',
      clickerOffsetMm: 0,  // クリッカー位置 (自然な引き尺からのズレ。+ で引き過ぎ側)
      nockingMm: 10,       // ノッキングポイント高さ (直角位置から上へ)
      eta: 0.82,           // 効率係数 η (spec: 0.75〜0.85)
      effMassG: 4,         // リム・弦の等価運動質量 m_eff [g]
      riserMassG: 1250,
      limbMassG: 160,      // 片側
      sightMassG: 120,
    },
    stabilizer: {
      center: { lengthIn: 30, angleDeg: 5, tipOz: 3, spacerIn: 0, damper: true },
      side: { count: 2, lengthIn: 12, spreadDeg: 40, dropDeg: 25, tipOz: 6, spacerIn: 0, damper: false },
      vbarMassG: 70,
      rodGPerIn: 3.5,      // ロッド自体の線密度 [g/inch]
    },
    arrow: {
      lengthIn: 28.5,
      totalGrain: 330,
      spine: 600,          // 1/1000 inch 単位のたわみ (大きいほど柔らかい)
      material: 'Carbon',
      diameterMm: 5.2,
      pointGrain: 100,
      vane: 'Spin',
      vaneMaterial: 'Film',
    },
    environment: {
      distance: 70,
      windSpeed: 1.5,
      windDirDeg: 90,
      turbulence: 0.5,
      refHeight: 2.0,
      shearExp: 1 / 7,
      lengthScale: 25,
      timeScale: 4,
      seed: 7,
    },
    sight: {
      radiusM: 0.85,       // 目からサイトピンまでの距離
      xMm: 0,              // サイトピン左右 (+右)
      yMm: 80,             // サイトピン上下 (+上)
    },
  };
}
