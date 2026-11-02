// 天候のタイムライン: 晴れ → くもり → 雨 → (雷雨) … をシード付き乱数でランダムに遷移させる。
// 試合ではサーバーが 1 本のタイムラインを進めて全員に配り、プラクティスでは各クライアントが自分で進める。
//
// 雷雨の流れ: 接近 (遠雷。まだ射てる) → 到来 (射撃中止。EVACUATE_S 秒以内に避難しないと失格) → 通過 → 雨に戻る
import { createRng } from './random.js';

export const WEATHER = {
  clear: { label: '晴れ', icon: '☀', rain: 0, light: 1, visibility: 1 },
  cloudy: { label: 'くもり', icon: '☁', rain: 0, light: 0.72, visibility: 0.85 },
  rain: { label: '雨', icon: '🌧', rain: 1, light: 0.5, visibility: 0.45 },
  storm: { label: '雷雨', icon: '⛈', rain: 1.4, light: 0.3, visibility: 0.3 },
};

export const STORM_APPROACH_S = 12;   // 遠雷が聞こえてから雷雲が来るまで
export const EVACUATE_S = 10;         // 雷雲が来てから避難しなければならない猶予
export const STORM_DURATION_S = 40;   // 雷雲の到来から通過まで

const SEGMENT_S = [45, 110];          // 1 つの天候が続く時間の範囲
// 次の天候の確率 (random モード)
const TRANSITIONS = {
  clear: [['clear', 0.35], ['cloudy', 0.65]],
  cloudy: [['clear', 0.3], ['cloudy', 0.2], ['rain', 0.5]],
  rain: [['cloudy', 0.35], ['rain', 0.25], ['storm', 0.4]],
};

export class WeatherTimeline {
  /**
   * @param {number} seed
   * @param {'random'|'clear'} mode  clear なら晴れのまま
   * @param {number} nowMs
   */
  constructor(seed, mode = 'random', nowMs = Date.now()) {
    this.rng = createRng((seed >>> 0) || 1);
    this.mode = mode === 'clear' ? 'clear' : 'random';
    this.kind = this.mode === 'clear' || this.rng.uniform() < 0.6 ? 'clear' : 'cloudy';
    this.storm = null;
    this.since = nowMs;
    this.until = nowMs + this.segmentMs();
  }

  segmentMs() {
    return (SEGMENT_S[0] + this.rng.uniform() * (SEGMENT_S[1] - SEGMENT_S[0])) * 1000;
  }

  /** 雷雨を始める (遷移で選ばれたとき。テストからも呼べる) */
  startStorm(nowMs) {
    const arriveAt = nowMs + STORM_APPROACH_S * 1000;
    this.kind = 'storm';
    this.since = nowMs;
    this.storm = { approachAt: nowMs, arriveAt, deadline: arriveAt + EVACUATE_S * 1000, endAt: arriveAt + STORM_DURATION_S * 1000 };
    this.until = this.storm.endAt;
  }

  /** null | 'approach' (遠雷・射撃可) | 'storm' (雷雲到来・射撃中止) */
  phase(nowMs) {
    if (!this.storm) return null;
    return nowMs < this.storm.arriveAt ? 'approach' : 'storm';
  }

  /** 時刻を進める。天候が変わったら true */
  tick(nowMs) {
    if (this.storm) {
      if (nowMs < this.storm.endAt) return false;
      // 雷雲が通過したら雨に戻る
      this.storm = null;
      this.kind = 'rain';
      this.since = nowMs;
      this.until = nowMs + this.segmentMs();
      return true;
    }
    if (this.mode === 'clear' || nowMs < this.until) return false;
    let u = this.rng.uniform();
    let next = this.kind;
    for (const [k, p] of TRANSITIONS[this.kind]) {
      if ((u -= p) < 0) { next = k; break; }
    }
    if (next === 'storm') {
      this.startStorm(nowMs);
      return true;
    }
    const changed = next !== this.kind;
    this.kind = next;
    this.since = nowMs;
    this.until = nowMs + this.segmentMs();
    return changed;
  }

  /** 通信・描画用の状態。phase は呼び出し時刻で決まる */
  snapshot(nowMs) {
    // 接近中はまだ雨の見た目 (雷雲は遠い)
    const look = this.phase(nowMs) === 'approach' ? 'rain' : this.kind;
    return { kind: this.kind, look, mode: this.mode, since: this.since, until: this.until, storm: this.storm && { ...this.storm }, phase: this.phase(nowMs) };
  }
}

/** snapshot と現在時刻から、その時点の phase を求める (クライアント側で時計を進めるため) */
export function phaseAt(snap, nowMs) {
  if (!snap?.storm) return null;
  if (nowMs >= snap.storm.endAt) return null;
  return nowMs < snap.storm.arriveAt ? 'approach' : 'storm';
}
