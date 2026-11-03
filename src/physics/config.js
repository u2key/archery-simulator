// 既定のセットアップ (spec 3章のパラメータ)。UI はこのオブジェクトを丸ごと編集する。
// 単位は spec の表記に合わせ、計算時に SI へ変換する。

export const REST_FRICTION = { Plastic: 0.25, Metal: 0.08 };

// 材質ごとのシャフト外径 [mm] とパラドックス振動の減衰率 γ [1/s]
export const ARROW_MATERIALS = {
  Carbon: { diameterMm: 5.2, gamma: 28, label: 'カーボン' },
  'Aluminum-Carbon': { diameterMm: 5.8, gamma: 20, label: 'アルミカーボン' },
  Aluminum: { diameterMm: 7.1, gamma: 12, label: 'アルミ' },
};

// ベイン形状 (1 枚の寸法)。空力係数はここから翼理論で計算する (arrow.js)。
//   lengthMm: 長さ, heightMm: 高さ, thicknessMm: 厚さ, fill: 長方形に対する面積の割合 (シールド形 ≈ 0.6),
//   cantDeg: 軸に対する取付角 (ヘリカル・カール)。自転の速さを決める。
export const VANE_SHAPES = {
  Spin: { lengthMm: 44, heightMm: 10, thicknessMm: 0.15, fill: 0.62, cantDeg: 1.5, label: 'スピンベイン' },
  Straight: { lengthMm: 45, heightMm: 11, thicknessMm: 0.4, fill: 0.6, cantDeg: 0.25, label: 'ストレートベイン' },
};

// ベイン材質: 3枚+ノックの質量 [grain], 表面の粗さによる摩擦抗力の倍率, 法線力の倍率 (羽は柔らかく反りがある)
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
      plungerPreloadN: 2,  // プランジャーの予圧 (テンション) [N]: これを超えるまでプランジャーは引っ込まない
      rest: 'Metal',
      clickerOffsetMm: 0,  // クリッカー位置 (自然な引き尺からのズレ。+ で引き過ぎ側)
      nockingMm: 10,       // ノッキングポイント高さ (直角位置から上へ)
      // 発射はリム・弦の集中定数モデルで解く (bowdynamics.js)。効率 = η · m / (m + 弦の質量/3 + 付加質量)
      eta: 0.9,            // ヒステリシス (リム材の内部損失) による効率 η
      effMassG: 1,         // 弦の付加質量 (ノッキングポイント・サービング) [g]
      stringMassG: 8,      // 弦の質量 [g]
      bowLengthIn: 68,     // ボウの長さ (AMO)
      riserLengthIn: 25,   // ハンドルの長さ
      curveExp: 0.75,      // 引き重量曲線の形 F ∝ s^p (1 = 直線。リカーブは 0.7〜0.8 程度)
      riserMassG: 1250,
      limbMassG: 160,      // 片側
      sightMassG: 120,
    },
    stabilizer: {
      center: { lengthIn: 30, angleDeg: 5, tipOz: 3, spacerIn: 0, damper: true },
      side: { count: 2, lengthIn: 12, spreadDeg: 40, dropDeg: 25, tipOz: 6, spacerIn: 0, damper: false },
      extenderIn: 4,       // ライザー〜Vバー間のエクステンダー長 (4" ≈ 10cm)
      // リム付け根のスタビ: ライザー上下端 (リムポケット近く) のブッシングに付ける短いロッド
      limbRoot: { position: 'none', lengthIn: 4, angleDeg: 0, tipOz: 1, damper: true },   // position: none | top | bottom | both
      limbDampers: false,  // リムダンパー (リムの付け根の腹に当てるゴム): 上下 1 個ずつ
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
      // 大気と地球 (弾道の精度に効く): 気温・標高・湿度 → 空気密度と粘性、緯度・標高 → 重力、緯度・的の方位 → コリオリ
      temperatureC: 20,
      altitudeM: 40,
      humidity: 0.6,       // 相対湿度 (0〜1)
      latitudeDeg: 35.7,   // 東京
      rangeAzimuthDeg: 0,  // 的の方位 (北 = 0、東 = 90)
      weather: 'random',   // random: 晴れ・くもり・雨・雷雨が移り変わる / clear: 晴れ固定
    },
    sight: {
      radiusM: 0.85,       // 目からサイトピンまでの距離
      xMm: 0,              // サイトピン左右 (+右)
      yMm: 80,             // サイトピン上下 (+上)
    },
  };
}
