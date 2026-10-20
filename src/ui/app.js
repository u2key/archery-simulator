import { createApp, reactive, ref, computed, watch, onMounted, nextTick, toRaw } from 'vue';
import { RangeScene } from './scene.js';
import { drawPip, SHOT_COLORS } from './targetFace.js';
import { defaultSetup, ARROW_MATERIALS, VANE_SHAPES, VANE_MATERIALS, TARGET_FACES, REST_FRICTION } from '../physics/config.js';
import { prepare, shoot, autoSight, aimSway } from '../physics/shot.js';
import { createWindField } from '../physics/wind.js';
import { createRng } from '../physics/random.js';
import { storedEnergy } from '../physics/bow.js';
import { createScoreCard, addArrow, summary, isComplete, ENDS, ARROWS_PER_END } from '../physics/scoring.js';
import { applyCorrection, correctionMm, groupCenter } from '../physics/sight.js';
import { toDeg } from '../physics/units.js';

const DRAW_TIME = 0.9;
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

const App = {
  components: { NumField },
  setup() {
    const setup = reactive(defaultSetup());
    const ui = reactive({
      mode: 'third', phase: 'idle', autoEnd: false, slow: 1, exaggerate: 1, tab: 'bow',
      clicker: 0, clicked: false, wind: { speed: 0, dir: 0 }, message: '', settingsOpen: true, autoCorrect: true,
    });
    const card = ref(createScoreCard());
    const impacts = ref([]);
    const last = ref(null);
    const info = ref(null);
    const view = ref(null);
    const pip = ref(null);

    let scene, prep, wind, rng = createRng(12345);
    let simTime = 0, tPhase = 0, tClick = 2, pendingResult = null;
    let currentSway = { elev: 0, azim: 0 };

    const sheet = computed(() => summary(card.value));
    const shotsInEnd = computed(() => {
      const ends = card.value.ends;
      const e = ends[ends.length - 1];
      return e.length >= ARROWS_PER_END ? 0 : e.length;
    });
    const roundDone = computed(() => isComplete(card.value));
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
        drawIn: prep.drawIn, lbs: prep.lbs, energy: storedEnergy(s.bow, prep.drawIn), v0: prep.v0,
        arrowG: a.mass * 1000, foc: a.foc * 100, f: a.fSpine, EI: a.EI, req: a.requiredSpine, dyn: a.dynamicSpine,
        mismatch: a.mismatch, eff: a.effMismatch, cd: a.cd, A0: a.paradox.A0 * 1000, gamma: a.paradox.gamma,
        I: prep.I, cDamp: prep.cDamp, bowMass: prep.model.mass, cg: prep.model.cg, warnings: a.warnings, stable: a.stable,
        face: prep.face,
      };
      if (scene) {
        if (full) scene.setRange(s.environment.distance, prep.face);
        scene.setBow(prep, s);
      }
    }

    function rebuildWind() {
      const e = toRaw(setup).environment;
      wind = createWindField({
        speed: e.windSpeed, directionDeg: e.windDirDeg, refHeight: e.refHeight, shearExp: e.shearExp,
        turbulence: e.turbulence, lengthScale: e.lengthScale, timeScale: e.timeScale, seed: e.seed,
      });
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
          newRound();
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

    function nudge(axis, mm) {
      setup.sight[axis] = Math.round((setup.sight[axis] + mm) * 10) / 10;
    }

    // ---- 射撃の流れ: idle → drawing → aiming (クリッカー) → flight → idle ----
    function startDraw() {
      if (ui.phase !== 'idle' || roundDone.value) return;
      if (shotsInEnd.value === 0) scene.clearStuck();
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
      const late = tPhase - tClick;
      let drawDeltaIn = 0, note = 'クリッカーで発射';
      if (!ui.clicked) {
        drawDeltaIn = -(1 - tPhase / tClick) * 3 / 25.4;
        note = 'クリッカー前に離した (引き不足)';
      } else if (late > 1.0) {
        drawDeltaIn = -Math.min(0.12, (late - 1.0) * 0.04);
        note = 'クリッカー後に保持しすぎ (戻り)';
      }
      const result = shoot(toRaw(setup), prep, { rng, wind, time: simTime, bowMotion: true, sway: { ...currentSway }, drawDeltaIn });
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
      if (ui.phase !== 'idle') return;
      let n = 0;
      while (!isComplete(card.value) && n < 72) {
        simTime += 25 + rng.uniform() * 15;
        const sway = aimSway(toRaw(setup), prep, simTime);
        const r = shoot(toRaw(setup), prep, { rng, wind, time: simTime, sway });
        r.note = '一括シミュレーション';
        recordShot(r);
        n++;
      }
      scene.clearStuck();
      ui.message = `${n} 本を一括シミュレーションしました`;
    }

    function shootEnd() {
      ui.autoEnd = true;
      if (ui.phase === 'idle') startDraw();
    }

    function onKey(e) {
      if (e.code !== 'Space') return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
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
      scene.render(currentSway);

      if (now - lastUi > 100) {
        lastUi = now;
        const w = wind.at(0, 2, 0, simTime);
        ui.wind = { speed: Math.hypot(w[0], w[2]), dir: (toDeg(Math.atan2(w[0], w[2])) + 360) % 360, x: w[0], z: w[2] };
        paintPip();
      }
      requestAnimationFrame(frame);
    }

    function paintPip() {
      if (!pip.value || !prep) return;
      const D = setup.environment.distance;
      const aim = ui.phase === 'aiming' || ui.phase === 'drawing' ? { x: Math.tan(currentSway.azim) * D, y: Math.tan(currentSway.elev) * D } : null;
      drawPip(pip.value, prep.face, impacts.value, card.value.ends.length, aim, prep.arrow.d);
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
      window.__sim = { setup, ui, card, impacts, release, startDraw, simulateRest, scene: () => scene };
      requestAnimationFrame(frame);
    });

    const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');
    const mismatchLabel = (m) => (m > 0.12 ? '柔らかい' : m < -0.12 ? '硬い' : '適正');

    return {
      setup, ui, card, impacts, last, info, view, pip, sheet, arrowsShown, roundDone, suggestion,
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
