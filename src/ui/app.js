import { createApp, reactive, ref, computed, watch, onMounted, nextTick, toRaw } from 'vue';
import { RangeScene } from './scene.js';
import { drawPip, SHOT_COLORS } from './targetFace.js';
import { defaultSetup, ARROW_MATERIALS, VANE_SHAPES, VANE_MATERIALS, TARGET_FACES, REST_FRICTION } from '../physics/config.js';
import { prepare, shoot, autoSight, aimSway } from '../physics/shot.js';
import { createWindField } from '../physics/wind.js';
import { createRng } from '../physics/random.js';
import { createScoreCard, addArrow, summary, isComplete, ENDS, ARROWS_PER_END } from '../physics/scoring.js';
import { applyCorrection, correctionMm, groupCenter } from '../physics/sight.js';
import { toDeg, MRAD } from '../physics/units.js';
import { createAimInput } from './input.js';
import { connectMatchServer } from './net.js';
import { WEATHER, WeatherTimeline, phaseAt } from '../physics/weather.js';

const DRAW_TIME = 0.9;
// サイトの映り込み: ハウジング内径とピン先の実寸 [m]
const SIGHT_RING_M = 0.011;
const SIGHT_PIN_M = 0.0012;

// ---- 効果音 (WebAudio)。音が出せない環境では何もしない ----
function noiseBurst(ctx, seconds) {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  return src;
}

/** 雷鳴。near なら大きく鋭く、遠ければ小さく低い */
function thunderSound(near) {
  try {
    audioCtx ??= new AudioContext();
    const t = audioCtx.currentTime + (near ? 0.15 + Math.random() * 0.6 : 0.8 + Math.random() * 1.5);
    const src = noiseBurst(audioCtx, 3.5);
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = near ? 420 : 160;
    const g = audioCtx.createGain();
    const peak = near ? 0.9 : 0.25;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (near ? 0.04 : 0.5));
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
    src.connect(lp).connect(g).connect(audioCtx.destination);
    src.start(t);
    src.stop(t + 3.5);
  } catch { /* 音が出せない環境では無視 */ }
}

/** 避難のサイレン (2 音を交互に) */
function sirenSound() {
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    const t = audioCtx.currentTime;
    o.type = 'sawtooth';
    for (let i = 0; i < 6; i++) o.frequency.setValueAtTime(i % 2 ? 660 : 880, t + i * 0.45);
    g.gain.setValueAtTime(0.12, t);
    g.gain.setValueAtTime(0.12, t + 2.6);
    g.gain.exponentialRampToValueAtTime(0.001, t + 2.8);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + 2.8);
  } catch { /* 音が出せない環境では無視 */ }
}

function loadShowSight() {
  try { return localStorage.getItem('archery.showSight') !== '0'; } catch { return true; }
}
const BOW_ANIM_TIME = 1.6;

const NumField = {
  props: { modelValue: Number, label: String, unit: String, step: { type: Number, default: 1 }, min: Number, max: Number, hint: String },
  emits: ['update:modelValue'],
  template: '#num-field',
  methods: {
    onInput(e) {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v)) this.$emit('update:modelValue', v);
    },
  },
};

let audioCtx = null;
function clickSound() {
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square';
    o.frequency.value = 2400;
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.03);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.04);
  } catch { /* 音が出せない環境では無視 */ }
}

function loadName() {
  try { return localStorage.getItem('archery.name') || ''; } catch { return ''; }
}

// スコアカードの矢 (表示用) とサーバーの記録 ({value,label,x,dx,dy}) の相互変換
const cardArrow = (a) => ({ value: a.value, label: a.label, x: a.x });

const App = {
  components: { NumField },
  setup() {
    const setup = reactive(defaultSetup());
    const ui = reactive({
      mode: 'third', phase: 'idle', autoEnd: false, slow: 1, exaggerate: 1, tab: 'bow',
      clicker: 0, clicked: false, wind: { speed: 0, dir: 0 }, message: '', settingsOpen: true, autoCorrect: true,
      showSight: loadShowSight(),
      // 天候: 表示用。phase は null | 'approach' (遠雷) | 'storm' (雷雲到来・射撃中止)
      weather: { kind: 'clear', look: 'clear', label: '晴れ', icon: '☀', rain: 0, visibility: 1, phase: null, countdown: 0, endIn: 0 },
      practiceSheltered: false,
      // 手動エイム: マウス感度 [mrad/px]、スティック・矢印キーの最大速度 [mrad/s]
      mouseSens: 0.04, padSens: 10, pad: '',
    });
    const card = ref(createScoreCard());
    const impacts = ref([]);
    const last = ref(null);
    const info = ref(null);
    const view = ref(null);
    const pip = ref(null);

    let scene, prep, wind, rng = createRng(12345);
    let predicted = null;   // 今のサイト設定で無風・理想射したときの着弾 [m]
    let simTime = 0, tPhase = 0, tClick = 2, pendingResult = null;
    let currentSway = { elev: 0, azim: 0 };
    let currentAim = { elev: 0, azim: 0 };   // 照準 (自分で合わせた位置 + 手ブレ・心拍)
    let input = null;

    const sheet = computed(() => summary(card.value));
    const shotsInEnd = computed(() => {
      const ends = card.value.ends;
      const e = ends[ends.length - 1];
      return e.length >= ARROWS_PER_END ? 0 : e.length;
    });

    // ---- オンライン試合 ----
    // 試合をしていない間 (ロビー) は従来どおりのプラクティス。試合が始まると出場者のスコアカードを試合用に切り替える。
    const online = reactive({ status: 'connecting', state: null, name: loadName(), arrows: 36, error: '' });
    const localMatchId = ref(null);      // このクライアントが出場中 (または結果表示中) の試合
    let net = null, practiceSaved = null, skipNewRound = false;
    const match = computed(() => online.state?.match ?? null);
    const myId = computed(() => online.state?.you ?? null);
    const matchView = computed(() => !!match.value && match.value.id === localMatchId.value);
    const inMatch = computed(() => matchView.value && match.value.status === 'running');
    const connectedCount = computed(() => (online.state?.players ?? []).filter((p) => p.connected).length);
    // 自分は今のエンドを射ち終えて、他の選手を待っている
    const waitingOthers = computed(() => inMatch.value && sheet.value.arrows >= match.value.currentEnd * ARROWS_PER_END);
    const roundDone = computed(() => isComplete(card.value) || (matchView.value && match.value.status !== 'running'));
    // 雷: 試合ではサーバーの記録、プラクティスでは自分の状態
    const sheltered = computed(() => (inMatch.value ? !!match.value.sheltered?.includes(myId.value) : ui.practiceSheltered));
    const eliminated = computed(() => matchView.value && !!match.value.eliminated?.includes(myId.value));
    const shootBlocked = computed(() => roundDone.value || waitingOthers.value || ui.weather.phase === 'storm' || sheltered.value || eliminated.value);
    const arrowsShown = computed(() => card.value.ends[card.value.ends.length - 1].length);

    let messageTimer = null;
    watch(() => ui.message, (m) => {
      clearTimeout(messageTimer);
      if (m) messageTimer = setTimeout(() => (ui.message = ''), 6000);
    });

    // 直近の (完了済みまたは進行中の) エンドのグループ中心からのサイト補正案
    const suggestion = computed(() => {
      const ends = card.value.ends.length;
      let pts = impacts.value.filter((p) => p.end === ends && p.reached);
      if (pts.length < 3 && ends > 1) pts = impacts.value.filter((p) => p.end === ends - 1 && p.reached);
      if (pts.length < 3) return null;
      const g = groupCenter(pts);
      const c = correctionMm(g.dx, g.dy, setup.environment.distance, setup.sight.radiusM);
      return { ...g, ...c, n: pts.length };
    });

    function rebuild(full) {
      const s = toRaw(setup);
      prep = prepare(s);
      const a = prep.arrow;
      info.value = {
        drawIn: prep.drawIn, lbs: prep.lbs, energy: prep.energy, v0: prep.v0, tExit: prep.stroke.tExit,
        efficiency: (0.5 * prep.arrow.mass * prep.v0 ** 2) / prep.energy, tension: prep.bowTension,
        arrowG: a.mass * 1000, foc: a.foc * 100, f: a.fSpine, EI: a.EI, req: a.requiredSpine, dyn: a.dynamicSpine,
        mismatch: a.mismatch, cd: a.cd, gamma: a.paradox.gamma,
        I: prep.I, cDamp: prep.cDamp, bowMass: prep.model.mass, cg: prep.model.cg, warnings: a.warnings, stable: a.stable,
        face: prep.face, vib: prep.vib, air: prep.flightEnv.air, g: prep.flightEnv.g,
        cdLam: a.cdLaminar, cdTurb: a.cdTurbulent,
      };
      const ideal = shoot(s, prep, { noise: false });
      predicted = ideal.flight.reached ? { x: ideal.dx, y: ideal.dy } : null;
      info.value.fe = {
        azim: ideal.parts.paradox.azim * 1000, angle: (ideal.paradoxAngle - ideal.parts.paradox.azim) * 1000,
        A0: ideal.paradox.A0 * 1000, plunger: ideal.plungerForceMax,
      };
      if (scene) {
        // 的の z はライン位置 (=引き尺) にも依存するので、D が変わったら射場を作り直す
        if (full || scene.distance !== prep.D) scene.setRange(prep);
        scene.setBow(prep, s);
      }
    }

    // 雨は乱流を強め、雷雨は平均風も強める (試合では全員が同じ天候なので同じ風になる)
    function rebuildWind() {
      const e = toRaw(setup).environment;
      const look = ui.weather.look;
      const rain = WEATHER[look].rain;
      wind = createWindField({
        speed: e.windSpeed + (look === 'storm' ? 2 : 0), directionDeg: e.windDirDeg, refHeight: e.refHeight, shearExp: e.shearExp,
        turbulence: e.turbulence * (1 + 0.6 * rain), lengthScale: e.lengthScale, timeScale: e.timeScale, seed: e.seed,
      });
    }

    // ---- 天候 ----
    let practiceWeather = new WeatherTimeline(Date.now() & 0x7fffffff, setup.environment.weather, Date.now());
    let serverOffset = 0;            // サーバー時計 − 自分の時計 [ms]
    let practiceWarned = false;
    let nextLightning = 0;

    /** 今見えている天候: 試合中 (結果表示中も含む) はサーバーの天候、それ以外はプラクティスの天候 */
    function updateWeather(dt) {
      const nowLocal = Date.now();
      let snap, now;
      if (matchView.value && match.value.weather && match.value.status === 'running') {
        snap = match.value.weather;
        now = nowLocal + serverOffset;
      } else {
        practiceWeather.tick(nowLocal);
        snap = practiceWeather.snapshot(nowLocal);
        now = nowLocal;
      }
      const phase = phaseAt(snap, now);
      const look = phase === 'approach' ? 'rain' : phase === null && snap.kind === 'storm' ? 'rain' : snap.kind;
      const prev = ui.weather;
      const def = WEATHER[look];
      ui.weather = {
        kind: snap.kind, look, label: phase === 'approach' ? '雷雲接近' : def.label, icon: phase === 'approach' ? '🌩' : def.icon,
        rain: def.rain, visibility: def.visibility, phase,
        countdown: snap.storm ? Math.max(0, ((phase === 'approach' ? snap.storm.arriveAt : snap.storm.deadline) - now) / 1000) : 0,
        endIn: snap.storm ? Math.max(0, (snap.storm.endAt - now) / 1000) : 0,
      };
      if (look !== prev.look) {
        scene?.setWeather(look);
        rebuildWind();
      }
      if (phase !== prev.phase) onStormPhase(phase, prev.phase);
      // プラクティスで避難しなかった場合は警告だけ
      if (!inMatch.value && phase === 'storm' && !ui.practiceSheltered && !practiceWarned && now >= snap.storm.deadline) {
        practiceWarned = true;
        ui.message = '避難しませんでした。試合なら失格です';
      }
      // 稲妻: 雷雲の到来後は近くに、接近中は遠くでときどき光る
      if (phase && nowLocal >= nextLightning) {
        const near = phase === 'storm';
        scene?.lightning(near);
        thunderSound(near);
        nextLightning = nowLocal + (near ? 2500 + Math.random() * 5000 : 3500 + Math.random() * 5000);
      }
      scene?.setArcherPresent(!sheltered.value && !eliminated.value);
    }

    function onStormPhase(phase, prev) {
      if (phase === 'approach') {
        ui.message = '遠くで雷鳴… 雷雲が近づいています';
        nextLightning = Date.now() + 800;
      } else if (phase === 'storm') {
        // 雷雲到来: 射撃中止。引いている矢は戻す
        sirenSound();
        cancelDraw();
        ui.autoEnd = false;
        nextLightning = Date.now() + 300;
      } else if (prev) {
        ui.practiceSheltered = false;
        practiceWarned = false;
        ui.message = '雷雲が通過しました。射撃を再開してください';
      }
    }

    /** 引いている矢を戻す (放さずに引き戻す) */
    function cancelDraw() {
      if (ui.phase === 'drawing' || ui.phase === 'aiming') {
        ui.phase = 'idle';
        scene?.setDraw(0);
      }
      input?.unlock();
    }

    function evacuate() {
      if (!ui.weather.phase || sheltered.value || eliminated.value) return;
      cancelDraw();
      ui.autoEnd = false;
      if (inMatch.value) net?.send({ type: 'evacuate' });
      else ui.practiceSheltered = true;
    }

    // プラクティスの天候モード (ランダム / 晴れ固定) を変えたら作り直す
    watch(() => setup.environment.weather, (mode) => {
      if (!matchView.value) practiceWeather = new WeatherTimeline(Date.now() & 0x7fffffff, mode, Date.now());
    });

    function startMatch() {
      if (!online.state?.canStart) return;
      const env = toRaw(setup).environment;
      net?.send({ type: 'start', arrows: online.arrows, distance: env.distance, environment: env });
    }

    function saveName() {
      online.name = online.name.trim().slice(0, 20);
      try { localStorage.setItem('archery.name', online.name); } catch { /* 保存できなくても続行 */ }
      if (online.name) net?.send({ type: 'rename', name: online.name });
    }

    /** サーバーの自分の記録からスコアカードと着弾点を作り直す (再接続・切断中に M で埋められた場合) */
    function loadMine(m) {
      const c = createScoreCard(m.ends);
      if (m.mine?.length) c.ends = m.mine.map((e) => e.map(cardArrow));
      card.value = c;
      impacts.value = (m.mine ?? []).flatMap((e, i) => e.map((a, j) => (
        { dx: a.dx ?? 0, dy: a.dy ?? 0, end: i + 1, shot: j + 1, label: a.label, reached: a.dx !== null })));
    }

    function enterMatch(m) {
      if (!localMatchId.value) {
        practiceSaved = { card: card.value, impacts: impacts.value, last: last.value, environment: { ...toRaw(setup.environment) } };
      }
      localMatchId.value = m.id;
      ui.autoEnd = false;
      // 引いている途中・飛んでいる矢はプラクティスの矢として捨てる
      if (ui.phase === 'drawing' || ui.phase === 'aiming') {
        ui.phase = 'idle';
        scene?.setDraw(0);
      }
      if (pendingResult) pendingResult.recorded = true;
      loadMine(m);
      last.value = null;
      scene?.clearStuck();
      // 全員が同じ距離・風で射つ
      Object.assign(setup.environment, m.environment);
      ui.message = `試合開始: ${m.arrows} 射 (${m.ends} エンド) / ${m.distance} m`;
    }

    /** 試合の記録とクライアントの記録を突き合わせる */
    function syncMatch(m) {
      const serverN = (m.mine ?? []).flat().length;
      const local = card.value.ends.flat();
      if (serverN > local.length) {
        loadMine(m);          // 切断中にエンドが進み、残りが M になった
      } else if (serverN < local.length) {
        // 送れなかった矢を再送する (サーバーは通算本数 n で重複を弾く)
        const flatImpacts = impacts.value;
        for (let n = serverN; n < local.length; n++) {
          const end = Math.floor(n / ARROWS_PER_END) + 1;
          const imp = flatImpacts[n];
          net?.send({ type: 'arrow', matchId: m.id, n, end, ...local[n], dx: imp?.reached ? imp.dx : null, dy: imp?.reached ? imp.dy : null });
        }
      }
    }

    function onServerState(state) {
      online.state = state;
      if (state.serverNow) serverOffset = state.serverNow - Date.now();
      const m = state.match;
      const participant = m && m.participants.includes(state.you);
      if (m && m.status === 'running' && participant && localMatchId.value !== m.id) enterMatch(m);
      else if (m && m.id === localMatchId.value && m.status === 'running') syncMatch(m);
      else if (localMatchId.value && (!m || m.id !== localMatchId.value)) leaveMatch('試合が打ち切られました');
    }

    /** 試合を抜けてプラクティスに戻る (結果を閉じる・打ち切り) */
    function leaveMatch(note) {
      localMatchId.value = null;
      ui.autoEnd = false;
      if (practiceSaved) {
        card.value = practiceSaved.card;
        impacts.value = practiceSaved.impacts;
        last.value = practiceSaved.last;
        if (practiceSaved.environment.distance !== setup.environment.distance) skipNewRound = true;
        Object.assign(setup.environment, practiceSaved.environment);
        practiceSaved = null;
      } else {
        newRound();
      }
      scene?.clearStuck();
      ui.message = note ?? 'プラクティスに戻りました';
    }

    function newRound() {
      card.value = createScoreCard();
      impacts.value = [];
      last.value = null;
      ui.autoEnd = false;
      scene?.clearStuck();
    }

    let rebuildTimer = null;
    watch(() => JSON.stringify(setup), (now, before) => {
      const a = JSON.parse(now), b = JSON.parse(before);
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => {
        const distChanged = a.environment.distance !== b.environment.distance;
        if (JSON.stringify(a.environment) !== JSON.stringify(b.environment)) rebuildWind();
        rebuild(distChanged);
        if (distChanged) {
          // 試合の開始・終了で距離が変わったときは、スコアカードはそちらで用意済み
          if (localMatchId.value || skipNewRound) scene?.clearStuck();
          else newRound();
          skipNewRound = false;
          doAutoSight();
        }
      }, 120);
    });

    function doAutoSight() {
      const s = autoSight(toRaw(setup), prep);
      setup.sight.xMm = Math.round(s.xMm * 10) / 10;
      setup.sight.yMm = Math.round(s.yMm * 10) / 10;
      ui.message = `サイトを理想射 (無風) に合わせました: 上下 ${setup.sight.yMm.toFixed(1)} mm / 左右 ${setup.sight.xMm.toFixed(1)} mm`;
    }

    function applySuggestion() {
      const g = suggestion.value;
      if (!g) return;
      const s = applyCorrection(setup.sight, g.dx, g.dy, setup.environment.distance);
      setup.sight.xMm = Math.round(s.xMm * 10) / 10;
      setup.sight.yMm = Math.round(s.yMm * 10) / 10;
      ui.message = `グループ中心 (${(g.dx * 100).toFixed(1)}, ${(g.dy * 100).toFixed(1)}) cm に合わせてピンを動かしました`;
    }

    function toggleSight() {
      ui.showSight = !ui.showSight;
      try { localStorage.setItem('archery.showSight', ui.showSight ? '1' : '0'); } catch { /* 保存できなくても続行 */ }
      paintPip();
    }

    function nudge(axis, mm) {
      setup.sight[axis] = Math.round((setup.sight[axis] + mm) * 10) / 10;
    }

    // ---- 射撃の流れ: idle → drawing → aiming (クリッカー) → flight → idle ----
    function startDraw() {
      if (ui.phase !== 'idle' || shootBlocked.value) return;
      if (shotsInEnd.value === 0) scene.clearStuck();
      // 手動エイム: 弓を上から下ろしてくるので、照準は的の少し上・左右どちらかから始まる
      if (ui.autoEnd) input?.reset(0, 0);
      else {
        input?.reset((4 + 4 * Math.random()) * MRAD, (Math.random() * 2 - 1) * 3 * MRAD);
        input?.lock();
      }
      ui.phase = 'drawing';
      tPhase = 0;
      ui.clicked = false;
      ui.clicker = 0;
    }

    function swayFactor() {
      if (ui.phase === 'aiming') {
        // 引き終わり直後は揺れが大きく、保持が長すぎると疲労で再び大きくなる
        return 1 + 2.5 * Math.exp(-tPhase / 0.5) + Math.max(0, tPhase - 5) * 0.25;
      }
      return ui.phase === 'drawing' ? 4 : 2.5;
    }

    function release() {
      if (ui.phase !== 'aiming') return;
      input?.unlock();
      const late = tPhase - tClick;
      let drawDeltaIn = 0, note = 'クリッカーで発射';
      if (!ui.clicked) {
        drawDeltaIn = -(1 - tPhase / tClick) * 3 / 25.4;
        note = 'クリッカー前に離した (引き不足)';
      } else if (late > 1.0) {
        drawDeltaIn = -Math.min(0.12, (late - 1.0) * 0.04);
        note = 'クリッカー後に保持しすぎ (戻り)';
      }
      // 発射方向のずれ = 自分で合わせた照準 + その瞬間の手ブレ
      const result = shoot(toRaw(setup), prep, { rng, wind, time: simTime, bowMotion: true, sway: { ...currentAim }, drawDeltaIn, rain: ui.weather.rain });
      result.note = note;
      pendingResult = result;
      scene.launch(result, shotsInEnd.value);
      scene.setDraw(0);
      ui.phase = 'flight';
      tPhase = 0;
    }

    function recordShot(result) {
      const endBefore = card.value.ends.length;
      const wasFull = card.value.ends[endBefore - 1].length >= ARROWS_PER_END;
      addArrow(card.value, result.score);
      const end = wasFull ? endBefore + 1 : endBefore;
      const shot = card.value.ends[card.value.ends.length - 1].length;
      impacts.value.push({ dx: result.dx, dy: result.dy, end, shot, label: result.score.label, reached: result.flight.reached });
      card.value = { ...card.value };
      if (inMatch.value) {
        const n = card.value.ends.flat().length - 1;
        net?.send({
          type: 'arrow', matchId: match.value.id, n, end, ...cardArrow(result.score),
          dx: result.flight.reached ? result.dx : null, dy: result.flight.reached ? result.dy : null,
        });
      }
      // 自動射撃・一括計算では、射手と同じくエンドが終わるたびにグループ中心へサイトを動かす
      if (ui.autoCorrect && (ui.autoEnd || result.note === '一括シミュレーション') && shot === ARROWS_PER_END) {
        const pts = impacts.value.filter((p) => p.end === end && p.reached);
        if (pts.length >= 3) {
          const g = groupCenter(pts);
          const sNew = applyCorrection(setup.sight, g.dx, g.dy, setup.environment.distance);
          setup.sight.xMm = Math.round(sNew.xMm * 10) / 10;
          setup.sight.yMm = Math.round(sNew.yMm * 10) / 10;
        }
      }
      last.value = {
        score: result.score.label, dx: result.dx * 100, dy: result.dy * 100, v0: result.v0, tof: result.flightTime,
        vImp: result.impactSpeed, elev: toDeg(result.elev), azim: toDeg(result.azim), note: result.note,
        drawIn: result.drawIn, end, shot,
        parts: Object.fromEntries(Object.entries(result.parts).map(([k, v]) => [k, { elev: v.elev * 1000, azim: v.azim * 1000 }])),
      };
    }

    // 残り全射を一括で計算する (アニメーションなし)
    function simulateRest() {
      if (ui.phase !== 'idle' || matchView.value) return;
      let n = 0;
      while (!isComplete(card.value) && n < 72) {
        simTime += 25 + rng.uniform() * 15;
        const sway = aimSway(toRaw(setup), prep, simTime);
        const r = shoot(toRaw(setup), prep, { rng, wind, time: simTime, sway, rain: ui.weather.rain });
        r.note = '一括シミュレーション';
        recordShot(r);
        n++;
      }
      scene.clearStuck();
      ui.message = `${n} 本を一括シミュレーションしました`;
    }

    function shootEnd() {
      if (matchView.value) return;
      ui.autoEnd = true;
      if (ui.phase === 'idle') startDraw();
    }

    function onKey(e) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.code === 'KeyE') {
        evacuate();
        return;
      }
      if (e.code !== 'Space') return;
      e.preventDefault();
      if (e.repeat) return;
      if (ui.phase === 'idle') startDraw();
      else if (ui.phase === 'aiming') release();
    }

    function setMode(m) {
      ui.mode = m;
      scene.setMode(m);
    }

    let lastFrame = performance.now(), lastUi = 0;
    function frame(now) {
      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;
      simTime += dt;
      tPhase += dt;
      input?.update(dt);
      scene.updateWind(wind, simTime, dt);

      if (ui.phase === 'drawing') {
        scene.setDraw(Math.min(1, tPhase / DRAW_TIME));
        if (tPhase >= DRAW_TIME) {
          ui.phase = 'aiming';
          tPhase = 0;
          tClick = (1.2 + rng.uniform() * 1.4) * (1 + 0.08 * Math.abs(setup.bow.clickerOffsetMm));
        }
      } else if (ui.phase === 'aiming') {
        ui.clicker = Math.min(1, tPhase / tClick);
        if (!ui.clicked && tPhase >= tClick) {
          ui.clicked = true;
          clickSound();
        }
        if ((ui.autoEnd && tPhase >= tClick + 0.12) || tPhase > 9) release();
      } else if (ui.phase === 'flight') {
        const t = tPhase * ui.slow;
        const r = pendingResult;
        const landed = scene.placeArrow(t, ui.exaggerate);
        if (r.bowMotion) {
          const idx = Math.min(r.bowMotion.length - 1, Math.floor(t * 60));
          scene.setBowAttitude(r.bowMotion[idx].q);
        }
        scene.setLimbVibration(t - r.tExit, r.limbVib, ui.exaggerate);
        if (landed && !r.recorded) {
          r.recorded = true;
          recordShot(r);
        }
        if (landed && t >= Math.max(BOW_ANIM_TIME, r.flightTime + 0.6)) {
          scene.resetBow();
          ui.phase = 'idle';
          pendingResult = null;
          if (ui.autoEnd) {
            if (shotsInEnd.value === 0 || roundDone.value) ui.autoEnd = false;
            else setTimeout(startDraw, 400);
          }
        }
      }

      const base = aimSway(toRaw(setup), prep, simTime);
      const k = swayFactor();
      currentSway = { elev: base.elev * k, azim: base.azim * k };
      const holding = ui.phase === 'drawing' || ui.phase === 'aiming';
      currentAim = holding && input
        ? { elev: input.aim.elev + currentSway.elev, azim: input.aim.azim + currentSway.azim }
        : currentSway;
      scene.render(currentAim);

      if (now - lastUi > 100) {
        lastUi = now;
        updateWeather();
        ui.pad = input?.state.padName ?? '';
        const w = wind.at(0, 2, 0, simTime);
        ui.wind = { speed: Math.hypot(w[0], w[2]), dir: (toDeg(Math.atan2(w[0], w[2])) + 360) % 360, x: w[0], z: w[2] };
        paintPip();
      }
      requestAnimationFrame(frame);
    }

    function paintPip() {
      if (!pip.value || !prep) return;
      const D = prep.D - prep.eye[2];   // 目から的までの距離
      const aim = ui.phase === 'aiming' || ui.phase === 'drawing' ? { x: Math.tan(currentAim.azim) * D, y: Math.tan(currentAim.elev) * D } : null;
      // サイトの映り込み: 引いていない間はピンを的の中心に置いた状態で見せる
      const r = setup.sight.radiusM;
      const sight = ui.showSight ? {
        aim: aim ?? { x: 0, y: 0 }, ringM: (SIGHT_RING_M * D) / r, pinM: (SIGHT_PIN_M * D) / r,
        xMm: setup.sight.xMm, yMm: setup.sight.yMm, predicted,
      } : null;
      drawPip(pip.value, prep.face, impacts.value, card.value.ends.length, aim, prep.arrow.d, sight, 1 - ui.weather.visibility);
    }

    onMounted(async () => {
      await nextTick();
      scene = new RangeScene(view.value);
      rebuildWind();
      rebuild(true);
      doAutoSight();
      rebuild(false);
      scene.setMode(ui.mode);
      window.addEventListener('keydown', onKey);
      input = createAimInput({
        element: scene.renderer.domElement,
        canAim: () => (ui.phase === 'drawing' || ui.phase === 'aiming') && !ui.autoEnd,
        onPress: () => { if (ui.phase === 'idle') startDraw(); },
        onRelease: () => {
          if (ui.phase === 'aiming') release();
          else if (ui.phase === 'drawing' && !ui.autoEnd) cancelDraw();
        },
        onEvacuate: evacuate,
        onNudge: (axis, mm) => { if (ui.phase === 'idle') nudge(axis, mm); },
        settings: ui,
      });
      net = connectMatchServer({
        onStatus: (st) => { online.status = st; },
        onState: onServerState,
        onError: (e) => { ui.message = e; },
        getName: () => online.name,
      });
      window.__sim = {
        setup, ui, card, impacts, release, startDraw, simulateRest, online, startMatch, evacuate, scene: () => scene,
        practiceStorm: () => practiceWeather.startStorm(Date.now()),
        serverStorm: () => net?.send({ type: 'debugStorm' }),
        aim: () => ({ ...input?.aim }),
      };
      requestAnimationFrame(frame);
    });

    const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');
    const mismatchLabel = (m) => (m > 0.12 ? '柔らかい' : m < -0.12 ? '硬い' : '適正');

    return {
      setup, ui, card, impacts, last, info, view, pip, sheet, arrowsShown, roundDone, suggestion,
      online, match, myId, matchView, inMatch, connectedCount, waitingOthers, shootBlocked,
      startMatch, saveName, leaveMatch, toggleSight, evacuate, sheltered, eliminated,
      startDraw, release, shootEnd, simulateRest, newRound, doAutoSight, applySuggestion, nudge, setMode,
      fmt, mismatchLabel, SHOT_COLORS, ENDS, ARROWS_PER_END,
      materials: ARROW_MATERIALS, vaneShapes: VANE_SHAPES, vaneMaterials: VANE_MATERIALS,
      distances: Object.keys(TARGET_FACES).map(Number), restFriction: REST_FRICTION,
      onKeyRelease: () => (ui.phase === 'aiming' ? release() : startDraw()),
      setMaterial(m) {
        setup.arrow.material = m;
        setup.arrow.diameterMm = ARROW_MATERIALS[m].diameterMm;
      },
    };
  },
};

createApp(App).mount('#app');
