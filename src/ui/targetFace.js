// WA 10リング標的の描画 (3D テクスチャとターゲット拡大 PIP で共用)

const ZONES = [
  { fill: '#f4f4f0', line: '#222' },   // 1, 2
  { fill: '#1d1d1f', line: '#e8e8e8' }, // 3, 4
  { fill: '#2f8fd8', line: '#1d1d1f' }, // 5, 6
  { fill: '#e2363a', line: '#1d1d1f' }, // 7, 8
  { fill: '#f7d23a', line: '#1d1d1f' }, // 9, 10
];

// 1〜6本目の色 (グループ識別用)
export const SHOT_COLORS = ['#ff4d6d', '#ff9f1c', '#2ec4b6', '#4cc9f0', '#9b5de5', '#f15bb5'];

export function drawFace(ctx, cx, cy, R) {
  for (let n = 1; n <= 10; n++) {
    const r = ((11 - n) / 10) * R;
    const z = ZONES[Math.floor((n - 1) / 2)];
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = z.fill;
    ctx.fill();
    ctx.lineWidth = Math.max(0.6, R / 260);
    ctx.strokeStyle = z.line;
    ctx.stroke();
  }
  // X リング
  ctx.beginPath();
  ctx.arc(cx, cy, R / 20, 0, Math.PI * 2);
  ctx.strokeStyle = '#1d1d1f';
  ctx.stroke();
  // 中心のクロス
  const c = R / 60;
  ctx.beginPath();
  ctx.moveTo(cx - c, cy);
  ctx.lineTo(cx + c, cy);
  ctx.moveTo(cx, cy - c);
  ctx.lineTo(cx, cy + c);
  ctx.stroke();
}

export function faceCanvas(size = 1024) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  drawFace(cv.getContext('2d'), size / 2, size / 2, size / 2 - 2);
  return cv;
}

/**
 * PIP 描画: 現在エンドの着弾を本数ごとの色で、過去エンドを薄く表示する。
 * @param {HTMLCanvasElement} canvas
 * @param {number} faceCm
 * @param {Array<{dx:number, dy:number, end:number, shot:number, label:string}>} impacts
 * @param {number} currentEnd
 * @param {{x:number,y:number}|null} aim 照準点 (m, 的中心基準)
 * @param {number} arrowDiameterM
 * @param {object|null} sight  サイトの映り込み (drawSightPicture の引数)。null なら照準点の丸だけ描く
 */
export function drawPip(canvas, faceCm, impacts, currentEnd, aim, arrowDiameterM, sight = null) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w < 40 || h < 40) return;   // 非表示・レイアウト前
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#c9b48a';
  ctx.fillRect(0, 0, w, h);
  const R = Math.min(w, h) / 2 - 8;
  const cx = w / 2, cy = h / 2;
  drawFace(ctx, cx, cy, R);
  const pxPerM = R / (faceCm / 200);
  const toPx = (p) => [cx + p.dx * pxPerM, cy - p.dy * pxPerM];
  const dotR = Math.max(3.2, (arrowDiameterM / 2) * pxPerM);

  for (const p of impacts) {
    if (p.end === currentEnd) continue;
    const [x, y] = toPx(p);
    ctx.beginPath();
    ctx.arc(x, y, dotR * 0.8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(90,90,90,0.55)';
    ctx.fill();
  }
  const cur = impacts.filter((p) => p.end === currentEnd);
  for (const p of cur) {
    const [x, y] = toPx(p);
    ctx.beginPath();
    ctx.arc(x, y, dotR, 0, Math.PI * 2);
    ctx.fillStyle = SHOT_COLORS[(p.shot - 1) % 6];
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillText(String(p.shot), x + dotR + 2, y - dotR - 1);
  }
  if (cur.length >= 2) {
    const gx = cur.reduce((s, p) => s + p.dx, 0) / cur.length;
    const gy = cur.reduce((s, p) => s + p.dy, 0) / cur.length;
    const [x, y] = toPx({ dx: gx, dy: gy });
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 7, y); ctx.lineTo(x + 7, y);
    ctx.moveTo(x, y - 7); ctx.lineTo(x, y + 7);
    ctx.stroke();
  }
  if (sight) {
    drawSightPicture(ctx, w, h, toPx, pxPerM, sight);
  } else if (aim) {
    const [x, y] = toPx({ dx: aim.x, dy: aim.y });
    ctx.strokeStyle = 'rgba(0,255,140,0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/**
 * 目から見たサイトの映り込み。照準器 (ハウジングのリングとピン) は実寸を的の距離に投影した大きさで描く
 * (例: 内径 11mm・目から 85cm のハウジングは 70m 先では直径約 90cm に見える)。
 * 右端は上下目盛り (サイトブロックの位置)、下端は左右目盛り。照準を合わせるとピンが照準点に重なる。
 * @param {object} s
 * @param {{x:number,y:number}} s.aim    ピンが重なっている的上の点 [m]
 * @param {number} s.ringM  ハウジング内径の投影 [m]
 * @param {number} s.pinM   ピン先の投影 [m]
 * @param {number} s.xMm    ピンの左右位置 [mm]
 * @param {number} s.yMm    ピンの上下位置 [mm]
 * @param {{x:number,y:number}|null} s.predicted 無風・理想射での着弾予想 [m]
 */
export function drawSightPicture(ctx, w, h, toPx, pxPerM, s) {
  const [px, py] = toPx({ dx: s.aim.x, dy: s.aim.y });
  const rIn = Math.max(10, (s.ringM / 2) * pxPerM);
  const rOut = rIn * 1.28;

  // 無風・理想射の着弾予想 (ピンを動かすと逆向きに動く)
  if (s.predicted) {
    const [x, y] = toPx({ dx: s.predicted.x, dy: s.predicted.y });
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#ff7a00';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x - 11, y); ctx.lineTo(x - 4, y); ctx.moveTo(x + 4, y); ctx.lineTo(x + 11, y);
    ctx.moveTo(x, y - 11); ctx.lineTo(x, y - 4); ctx.moveTo(x, y + 4); ctx.lineTo(x, y + 11);
    ctx.stroke();
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillStyle = '#ff7a00';
    ctx.fillText('予想', x + 9, y + 15);
    ctx.restore();
  }

  ctx.save();
  // エクステンションバー: ハウジングから右 (ライザー側) へ。ピントが合っていないので半透明の太い帯
  ctx.fillStyle = 'rgba(25,28,34,0.55)';
  ctx.fillRect(px + rOut * 0.9, py - rIn * 0.22, w, rIn * 0.44);
  // ハウジング (リング)
  ctx.beginPath();
  ctx.arc(px, py, rOut, 0, Math.PI * 2);
  ctx.arc(px, py, rIn, 0, Math.PI * 2, true);
  ctx.fillStyle = 'rgba(22,24,30,0.62)';
  ctx.fill('evenodd');
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.beginPath();
  ctx.arc(px, py, rIn, 0, Math.PI * 2);
  ctx.stroke();
  // ピンの支柱 (下から)
  const rp = Math.max(2.2, (s.pinM / 2) * pxPerM);
  ctx.strokeStyle = 'rgba(22,24,30,0.9)';
  ctx.lineWidth = Math.max(1.5, rp * 0.6);
  ctx.beginPath();
  ctx.moveTo(px, py + rIn);
  ctx.lineTo(px, py + rp);
  ctx.stroke();
  // 水平器 (リングの下)
  const vw = rIn * 0.7, vh = Math.max(5, (rOut - rIn) * 0.55), vy = py + (rIn + rOut) / 2;
  ctx.fillStyle = 'rgba(120,200,120,0.85)';
  ctx.fillRect(px - vw / 2, vy - vh / 2, vw, vh);
  ctx.fillStyle = 'rgba(240,255,240,0.95)';
  ctx.beginPath();
  ctx.ellipse(px, vy, vh * 0.8, vh * 0.38, 0, 0, Math.PI * 2);
  ctx.fill();
  // ピン先のファイバーの光点
  ctx.beginPath();
  ctx.arc(px, py, rp, 0, Math.PI * 2);
  ctx.fillStyle = '#3dff8f';
  ctx.shadowColor = '#3dff8f';
  ctx.shadowBlur = 6;
  ctx.fill();
  ctx.restore();

  // 目盛り: 上下 (右端) と左右 (下端)。目盛りがサイトブロックと一緒に動き、指標の位置が現在値
  const MM = 3;   // 1mm あたりの px
  ctx.save();
  ctx.font = '10px system-ui, sans-serif';
  const sw = 34;
  ctx.fillStyle = 'rgba(15,23,42,0.78)';
  ctx.fillRect(w - sw, 0, sw, h);
  ctx.fillRect(0, h - 22, w - sw, 22);
  ctx.strokeStyle = '#cbd5e1';
  ctx.fillStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  // 上下: ピンを上げると目盛りの値が増える。指標は照準点の高さ
  for (let mm = Math.floor(s.yMm - py / MM) - 1; mm <= s.yMm + (h - py) / MM + 1; mm++) {
    const y = py - (mm - s.yMm) * MM;
    if (y < 0 || y > h - 22) continue;
    const major = mm % 10 === 0, mid = mm % 5 === 0;
    ctx.beginPath();
    ctx.moveTo(w - sw, y + 0.5);
    ctx.lineTo(w - sw + (major ? 12 : mid ? 8 : 4), y + 0.5);
    ctx.stroke();
    if (major) ctx.fillText(String(mm), w - sw + 14, y + 3.5);
  }
  // 左右
  for (let mm = Math.floor(s.xMm - px / MM) - 1; mm <= s.xMm + (w - px) / MM + 1; mm++) {
    const x = px + (mm - s.xMm) * MM;
    if (x < 0 || x > w - sw) continue;
    const major = mm % 10 === 0, mid = mm % 5 === 0;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, h);
    ctx.lineTo(x + 0.5, h - (major ? 10 : mid ? 7 : 4));
    ctx.stroke();
    if (major) ctx.fillText(String(mm), x - 5, h - 12);
  }
  // 指標
  ctx.fillStyle = '#3dff8f';
  const iy = Math.min(h - 26, Math.max(4, py));
  ctx.beginPath();
  ctx.moveTo(w - sw - 1, iy); ctx.lineTo(w - sw - 8, iy - 5); ctx.lineTo(w - sw - 8, iy + 5);
  ctx.fill();
  const ix = Math.min(w - sw - 4, Math.max(4, px));
  ctx.beginPath();
  ctx.moveTo(ix, h - 23); ctx.lineTo(ix - 5, h - 30); ctx.lineTo(ix + 5, h - 30);
  ctx.fill();
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.fillText(`${s.yMm.toFixed(1)}`, w - sw - 40, iy - 7);
  ctx.fillText(`${s.xMm.toFixed(1)}`, ix + 7, h - 26);
  ctx.restore();
}
