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
 */
export function drawPip(canvas, faceCm, impacts, currentEnd, aim, arrowDiameterM) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
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
  if (aim) {
    const [x, y] = toPx({ dx: aim.x, dy: aim.y });
    ctx.strokeStyle = 'rgba(0,255,140,0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.stroke();
  }
}
