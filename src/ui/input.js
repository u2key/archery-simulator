// 手動エイムの入力: マウス・ゲームパッド・矢印キー。
//   引く/放す: マウス左ボタン (3D ビュー上) / パッド RT・A を押している間引き、離すと放つ
//   狙う    : マウス移動 (ポインタロック) / 左スティック (右スティックは微調整) / 矢印キー
//   その他  : パッド B = 避難、十字キー = サイトピン 0.5mm
// 照準はラジアンで持ち、+elev が上、+azim が右 (的中心からのずれ)。
import { MRAD } from '../physics/units.js';

const AIM_LIMIT = 45 * MRAD;     // 照準を動かせる範囲 (的の外まで少し)
const DEADZONE = 0.12;

const pad = () => [...(navigator.getGamepads?.() ?? [])].find((g) => g && g.connected) ?? null;

/**
 * @param {object} o
 * @param {HTMLElement} o.element      3D ビューの canvas (クリックで引く・ポインタロックの対象)
 * @param {() => boolean} o.canAim     今、照準を動かせるか (引いている最中)
 * @param {() => void} o.onPress       引き始め
 * @param {() => void} o.onRelease     放す (引き途中なら戻す)
 * @param {() => void} o.onEvacuate
 * @param {(axis:'xMm'|'yMm', mm:number) => void} o.onNudge
 * @param {{ mouseSens:number, padSens:number }} o.settings  mrad/px, mrad/s
 */
export function createAimInput(o) {
  const aim = { elev: 0, azim: 0 };
  const keys = new Set();
  let mouseHeld = false;
  let padPrev = [];
  const state = { padName: '' };

  const move = (dAzim, dElev) => {
    aim.azim = Math.max(-AIM_LIMIT, Math.min(AIM_LIMIT, aim.azim + dAzim));
    aim.elev = Math.max(-AIM_LIMIT, Math.min(AIM_LIMIT, aim.elev + dElev));
  };

  // ---- マウス ----
  o.element.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    mouseHeld = true;
    o.onPress();
  });
  window.addEventListener('pointerup', (e) => {
    if (e.button !== 0 || !mouseHeld) return;
    mouseHeld = false;
    o.onRelease();
  });
  window.addEventListener('mousemove', (e) => {
    if (!o.canAim()) return;
    // ポインタロック中は移動量だけが届く。ロックできない環境でも 3D ビュー上なら動かす
    if (document.pointerLockElement !== o.element && e.target !== o.element) return;
    const k = o.settings.mouseSens * MRAD;
    move(e.movementX * k, -e.movementY * k);
  });

  // ---- 矢印キー (押している間、一定速度で動く) ----
  const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  window.addEventListener('keydown', (e) => {
    if (!ARROWS.includes(e.code)) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (o.canAim()) e.preventDefault();
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  /** 毎フレーム呼ぶ: ゲームパッドの読み取りとキー入力の反映 */
  function update(dt) {
    const rate = o.settings.padSens * MRAD;
    if (o.canAim()) {
      const kx = (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0);
      const ky = (keys.has('ArrowUp') ? 1 : 0) - (keys.has('ArrowDown') ? 1 : 0);
      move(kx * rate * 0.6 * dt, ky * rate * 0.6 * dt);
    }
    const g = pad();
    state.padName = g ? g.id : '';
    if (!g) return;
    const axis = (i) => {
      const v = g.axes[i] ?? 0;
      if (Math.abs(v) < DEADZONE) return 0;
      // デッドゾーンの外を 0〜1 に直して 2 乗 (小さく倒すほど細かく動く)
      const n = (Math.abs(v) - DEADZONE) / (1 - DEADZONE);
      return Math.sign(v) * n * n;
    };
    if (o.canAim()) {
      move((axis(0) + 0.3 * axis(2)) * rate * dt, -(axis(1) + 0.3 * axis(3)) * rate * dt);
    }
    const pressed = g.buttons.map((b) => b.pressed || b.value > 0.5);
    const edge = (i) => pressed[i] && !padPrev[i];
    const drawNow = pressed[0] || pressed[7];
    const drawBefore = padPrev[0] || padPrev[7];
    if (drawNow && !drawBefore) o.onPress();
    if (!drawNow && drawBefore) o.onRelease();
    if (edge(1)) o.onEvacuate();
    if (edge(12)) o.onNudge('yMm', 0.5);
    if (edge(13)) o.onNudge('yMm', -0.5);
    if (edge(14)) o.onNudge('xMm', -0.5);
    if (edge(15)) o.onNudge('xMm', 0.5);
    padPrev = pressed;
  }

  return {
    aim,
    state,
    update,
    /** 引き始めの照準 (弓を上から下ろしてくるので、的の少し上・左右どちらかから始まる) */
    reset(elev, azim) {
      aim.elev = elev;
      aim.azim = azim;
    },
    lock() {
      try {
        const p = o.element.requestPointerLock?.();
        p?.catch?.(() => {});
      } catch { /* ロックできなくても 3D ビュー上のマウス移動で狙える */ }
    },
    unlock() {
      if (document.pointerLockElement === o.element) document.exitPointerLock();
    },
  };
}
