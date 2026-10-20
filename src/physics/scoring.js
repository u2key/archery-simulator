// 6章 得点計算: WA 10リング標的, 1エンド6本, 12エンド72本 (720点満点)
import { TARGET_FACES } from './config.js';

export const TARGET_CENTER_HEIGHT = 1.3;   // 的中心の地上高 [m] (WA 規定)
export const ENDS = 12;
export const ARROWS_PER_END = 6;

export function faceDiameterCm(distance) {
  return TARGET_FACES[distance] ?? 122;
}

/**
 * 的中心からの距離 rM と矢の半径からスコアを返す。
 * 矢がリングの線に触れていれば高い方の点 (ラインカッター)。X は 10 点の内側 (直径 = リング幅)。
 * @returns {{ value:number, label:string, x:boolean }}
 */
export function scoreArrow(rM, faceCm, arrowRadiusM = 0) {
  const ring = faceCm / 100 / 20;            // リング幅 [m] (10点リングの半径に等しい)
  const edge = rM - arrowRadiusM;            // 矢の外縁と中心の距離
  if (edge <= ring / 2) return { value: 10, label: 'X', x: true };
  if (edge > 10 * ring) return { value: 0, label: 'M', x: false };
  const v = Math.max(1, 11 - Math.ceil(edge / ring));
  return { value: v, label: String(v), x: false };
}

export function createScoreCard() {
  return { ends: [[]] };
}

export function addArrow(card, score) {
  let cur = card.ends[card.ends.length - 1];
  if (cur.length >= ARROWS_PER_END) {
    if (card.ends.length >= ENDS) return false;
    cur = [];
    card.ends.push(cur);
  }
  cur.push(score);
  return true;
}

export function isComplete(card) {
  return card.ends.length === ENDS && card.ends[ENDS - 1].length === ARROWS_PER_END;
}

export function endSubtotal(end) {
  return end.reduce((s, a) => s + a.value, 0);
}

export function summary(card) {
  const all = card.ends.flat();
  let running = 0;
  const rows = card.ends.map((end, i) => {
    const sub = endSubtotal(end);
    running += sub;
    // スコアシートには高い順に記入する (WA の慣習)
    const sorted = [...end].sort((a, b) => b.value - a.value || Number(b.x) - Number(a.x));
    return { index: i + 1, arrows: sorted, subtotal: sub, running };
  });
  return {
    rows,
    total: running,
    arrows: all.length,
    xs: all.filter((a) => a.x).length,
    tens: all.filter((a) => a.value === 10).length,
    hits: all.filter((a) => a.value > 0).length,
    average: all.length ? running / all.length : 0,
  };
}
