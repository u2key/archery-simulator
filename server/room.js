// オンライン試合のルーム。通信 (WebSocket) から切り離した純粋なロジックなので、テストから直接使える。
//
// 流れ: ロビー (各自プラクティス) → 試合開始 (2人以上の接続が必要。射数は 6 の倍数で 72 本まで)
//       → 全員が同じエンドを射ち終えたら次のエンドへ → 最終エンドで終了・順位確定。
// 得点の計算は各クライアントの物理シミュレーションが行い、サーバーは記録・進行・順位付けだけを担う。
import { TARGET_FACES, defaultSetup } from '../src/physics/config.js';
import { ARROWS_PER_END, compareStanding } from '../src/physics/scoring.js';

export const MIN_PLAYERS = 2;
export const MAX_ARROWS = 72;
export const ARROW_CHOICES = Array.from({ length: MAX_ARROWS / ARROWS_PER_END }, (_, i) => (i + 1) * ARROWS_PER_END);
const NAME_MAX = 20;

// 試合中は全員が同じ距離・同じ風 (乱流のシードも共通) で射つ。値はここで範囲に収める。
const ENV_LIMITS = {
  windSpeed: [0, 15], windDirDeg: [-360, 720], turbulence: [0, 5], refHeight: [0.5, 20],
  shearExp: [0, 1], lengthScale: [1, 500], timeScale: [0.1, 60], seed: [-1e9, 1e9],
};

function cleanName(name, fallback) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return s || fallback;
}

function cleanEnvironment(env = {}, distance) {
  const out = { ...defaultSetup().environment, distance };
  for (const [k, [lo, hi]] of Object.entries(ENV_LIMITS)) {
    const v = Number(env[k]);
    if (Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, v));
  }
  return out;
}

const MISS = { value: 0, label: 'M', x: false, dx: null, dy: null };

export class Room {
  constructor(name = 'main') {
    this.name = name;
    this.players = new Map();   // id → { id, name, connected }
    this.match = null;
    this.matchSeq = 0;
  }

  join(id, name) {
    const p = this.players.get(id) ?? { id, name: '' };
    p.name = cleanName(name, p.name || `射手${this.players.size + 1}`);
    p.connected = true;
    this.players.set(id, p);
    return p;
  }

  /** 切断。試合に出ていない選手は名簿から外す。試合中なら、その選手を待たずに進行できるか確かめる */
  leave(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = false;
    const m = this.match;
    if (!m || !m.participants.includes(id)) this.players.delete(id);
    if (m && m.status === 'running') {
      if (!m.participants.some((pid) => this.players.get(pid)?.connected)) {
        // 出場者が全員いなくなった試合は打ち切る
        this.match = null;
        for (const pid of m.participants) if (!this.players.get(pid)?.connected) this.players.delete(pid);
      } else {
        this.advance();
      }
    }
  }

  rename(id, name) {
    const p = this.players.get(id);
    if (p) p.name = cleanName(name, p.name);
  }

  connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  canStart() {
    return this.match?.status !== 'running' && this.connectedPlayers().length >= MIN_PLAYERS;
  }

  /** 試合開始。接続中の全員が出場する。距離・風は開始した人の設定を全員に適用する */
  start(byId, { arrows, distance, environment } = {}) {
    if (!this.players.get(byId)?.connected) return { ok: false, error: '接続していません' };
    if (this.match?.status === 'running') return { ok: false, error: '試合はすでに進行中です' };
    if (this.connectedPlayers().length < MIN_PLAYERS) return { ok: false, error: `${MIN_PLAYERS}人以上の接続が必要です` };
    arrows = Number(arrows);
    if (!ARROW_CHOICES.includes(arrows)) return { ok: false, error: `射数は ${ARROWS_PER_END} の倍数で ${MAX_ARROWS} 本までです` };
    distance = Number(distance);
    if (!(distance in TARGET_FACES)) return { ok: false, error: '距離が不正です' };
    // 前の試合で切断したまま戻らなかった選手は名簿から外す
    for (const p of [...this.players.values()]) if (!p.connected) this.players.delete(p.id);
    const participants = this.connectedPlayers().map((p) => p.id);
    this.match = {
      id: `m${++this.matchSeq}-${Date.now().toString(36)}`,
      status: 'running',
      arrows,
      ends: arrows / ARROWS_PER_END,
      currentEnd: 1,
      distance,
      environment: cleanEnvironment(environment, distance),
      startedBy: byId,
      startedAt: Date.now(),
      participants,
      scores: Object.fromEntries(participants.map((pid) => [pid, [[]]])),
    };
    return { ok: true };
  }

  /** 1本の記録。現在のエンドで、まだ 6 本射っていない出場者のみ受け付ける */
  recordArrow(id, a = {}) {
    const m = this.match;
    if (!m || m.status !== 'running' || a.matchId !== m.id) return { ok: false, error: '進行中の試合がありません' };
    if (!m.participants.includes(id)) return { ok: false, error: 'この試合の出場者ではありません' };
    // n = その選手の通算何本目か (0 始まり)。再接続時の再送で同じ矢が二重に記録されないようにする
    const count = m.scores[id].flat().length;
    if (a.n !== count) return { ok: false, silent: true, error: '記録済みの矢です' };
    if (a.end !== m.currentEnd) return { ok: false, error: `現在はエンド ${m.currentEnd} です` };
    const end = m.scores[id][m.currentEnd - 1];
    if (end.length >= ARROWS_PER_END) return { ok: false, error: 'このエンドは射ち終わっています。他の選手を待ってください' };
    const value = Number(a.value);
    if (!Number.isInteger(value) || value < 0 || value > 10) return { ok: false, error: '得点が不正です' };
    const x = value === 10 && a.x === true;
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    end.push({ value, label: value === 0 ? 'M' : x ? 'X' : String(value), x, dx: num(a.dx), dy: num(a.dy) });
    this.advance();
    return { ok: true };
  }

  /** 接続中の出場者が全員現在のエンドを射ち終えたら次のエンドへ。切断中の選手の残りは M とする */
  advance() {
    const m = this.match;
    if (!m || m.status !== 'running') return;
    const idx = m.currentEnd - 1;
    const active = m.participants.filter((pid) => this.players.get(pid)?.connected);
    if (!active.every((pid) => m.scores[pid][idx].length >= ARROWS_PER_END)) return;
    for (const pid of m.participants) {
      const end = m.scores[pid][idx];
      while (end.length < ARROWS_PER_END) end.push({ ...MISS });
    }
    if (m.currentEnd >= m.ends) {
      m.status = 'finished';
      m.finishedAt = Date.now();
      // 試合が終わったら、切断したままの選手は名簿から外す (結果には残る)
      for (const pid of m.participants) if (!this.players.get(pid)?.connected) this.players.delete(pid);
      return;
    }
    m.currentEnd++;
    for (const pid of m.participants) m.scores[pid].push([]);
  }

  /** 順位表。同点 (合計・10・X がすべて同じ) は同順位 */
  standings() {
    const m = this.match;
    if (!m) return [];
    const rows = m.participants.map((pid) => {
      const ends = m.scores[pid];
      const all = ends.flat();
      return {
        id: pid,
        name: m.names?.[pid] ?? this.players.get(pid)?.name ?? '(退出)',
        connected: !!this.players.get(pid)?.connected,
        total: all.reduce((s, a) => s + a.value, 0),
        tens: all.filter((a) => a.value === 10).length,
        xs: all.filter((a) => a.x).length,
        arrows: all.length,
        endTotals: ends.map((e) => e.reduce((s, a) => s + a.value, 0)),
        currentEndArrows: ends[m.currentEnd - 1]?.length ?? 0,
      };
    });
    rows.sort(compareStanding);
    rows.forEach((r, i) => {
      r.rank = i > 0 && compareStanding(rows[i - 1], r) === 0 ? rows[i - 1].rank : i + 1;
    });
    return rows;
  }

  /** クライアントへ送る状態。自分の記録 (全矢) だけは詳しく返す (再接続時にスコアシートを復元するため) */
  snapshot(forId) {
    const m = this.match;
    if (m) {
      // 退出した選手の名前も結果に残す
      m.names ??= {};
      for (const pid of m.participants) {
        const p = this.players.get(pid);
        if (p) m.names[pid] = p.name;
      }
    }
    return {
      room: this.name,
      you: forId,
      minPlayers: MIN_PLAYERS,
      arrowChoices: ARROW_CHOICES,
      canStart: this.canStart(),
      players: [...this.players.values()].map(({ id, name, connected }) => ({ id, name, connected })),
      match: m && {
        id: m.id, status: m.status, arrows: m.arrows, ends: m.ends, currentEnd: m.currentEnd,
        distance: m.distance, environment: m.environment, participants: m.participants,
        startedBy: m.startedBy, standings: this.standings(),
        mine: m.scores[forId] ?? null,
      },
    };
  }
}
