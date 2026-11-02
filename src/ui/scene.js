// Three.js による射場・ボウ・矢・風パーティクルの描画。物理は src/physics 側で計算済みの結果を再生するだけ。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { faceCanvas, SHOT_COLORS } from './targetFace.js';
import { paradoxDeflection } from '../physics/arrow.js';
import { TARGET_CENTER_HEIGHT } from '../physics/scoring.js';
import { INCH } from '../physics/units.js';

const PARTICLES = 1400;
const GRIP_BELOW_ARROW = 0.03;   // 矢はグリップのピボットより少し上を通る
const SHOULDER_YAW = (28 * Math.PI) / 180;   // 肩の線が矢のラインから背中側へ開く角度

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
// 物理は x=右 (射手から見て), y=上, z=的方向 の左手系。Three.js は右手系なので、ワールド全体を x 反転した
// グループに入れて描画する (そのままだと左右が鏡像になり、右利きの射手が左利きに見える)。
const toThree = (x, y, z) => new THREE.Vector3(-x, y, z);
const Y_UP = new THREE.Vector3(0, 1, 0);

function cylinderBetween(a, b, radius, material) {
  const A = v3(a), B = v3(b);
  const len = A.distanceTo(B);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 12), material);
  mesh.position.copy(A).add(B).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(Y_UP, B.clone().sub(A).normalize());
  mesh.castShadow = true;
  return mesh;
}

/** a → b をつなぐ先細りの円柱 (体の各部位)。update() で毎フレーム動かせる */
function makeBone(rA, rB, material) {
  const geo = new THREE.CylinderGeometry(rB, rA, 1, 14);
  geo.translate(0, 0.5, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.update = (a, b) => {
    const d = b.clone().sub(a);
    mesh.position.copy(a);
    mesh.scale.set(1, Math.max(d.length(), 1e-4), 1);
    mesh.quaternion.setFromUnitVectors(Y_UP, d.normalize());
  };
  return mesh;
}

/** 半径 1 の球を各軸 sx, sy, sz に伸ばした楕円体 */
function ellipsoid(sx, sy, sz, material, pos) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), material);
  m.scale.set(sx, sy, sz);
  if (pos) m.position.copy(pos);
  m.castShadow = true;
  return m;
}

/**
 * 2 リンクの逆運動学: 根元 root から先端 target へ、長さ l1, l2 の関節をつなぐ。
 * 関節 (肘・膝) は pole の向きへ曲げる。届かない場合は伸び切った姿勢で target 方向へ向ける。
 */
function solveTwoBone(root, target, l1, l2, pole) {
  const d = target.clone().sub(root);
  const dist = Math.min(Math.max(d.length(), Math.abs(l1 - l2) + 1e-4), l1 + l2 - 1e-4);
  const u = d.normalize();
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const side = pole.clone().sub(u.clone().multiplyScalar(pole.dot(u))).normalize();
  const joint = root.clone().add(u.clone().multiplyScalar(a)).add(side.multiplyScalar(h));
  const end = root.clone().add(u.clone().multiplyScalar(dist));
  return { joint, end };
}

export class RangeScene {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#9cc3e6');
    this.scene.fog = new THREE.Fog('#9cc3e6', 60, 220);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.03, 600);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 1.3, 2);
    this.mode = 'third';
    this.fovFirst = 10;

    this.scene.add(new THREE.HemisphereLight('#ffffff', '#4a6b2a', 1.4));
    const sun = new THREE.DirectionalLight('#fff6e0', 2.2);
    sun.position.set(-20, 40, -10);
    // 射手まわりだけ影を落とす (足元の接地感を出す)
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 20, far: 70 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun, sun.target);

    this.world = new THREE.Group();
    this.world.scale.x = -1;
    this.scene.add(this.world);

    this.buildGround();
    this.targetGroup = new THREE.Group();
    this.stuckGroup = new THREE.Group();
    this.bowGroup = new THREE.Group();
    this.archerGroup = new THREE.Group();
    this.world.add(this.targetGroup, this.stuckGroup, this.bowGroup, this.archerGroup);
    this.buildParticles();
    this.flying = null;

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  buildGround() {
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 512;
    const g = cv.getContext('2d');
    for (let i = 0; i < 16; i++) {
      g.fillStyle = i % 2 ? '#5f8f3c' : '#679a41';
      g.fillRect(0, i * 32, 64, 32);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(20, 8);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 320), new THREE.MeshLambertMaterial({ map: tex }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.z = 100;
    ground.receiveShadow = true;
    this.world.add(ground);
    this.lines = new THREE.Group();
    this.world.add(this.lines);
  }

  buildParticles() {
    const geo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(PARTICLES * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    const dot = document.createElement('canvas');
    dot.width = dot.height = 32;
    const g = dot.getContext('2d');
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    this.particles = new THREE.Points(geo, new THREE.PointsMaterial({
      color: '#ffffff', size: 0.035, map: new THREE.CanvasTexture(dot), transparent: true, opacity: 0.7, depthWrite: false,
    }));
    this.world.add(this.particles);
    this.bounds = { x: 8, y: 4, z0: -4, z1: 30 };
    for (let i = 0; i < PARTICLES; i++) this.respawn(i);
  }

  respawn(i) {
    const b = this.bounds;
    this.pPos[i * 3] = (Math.random() * 2 - 1) * b.x;
    this.pPos[i * 3 + 1] = 0.1 + Math.random() * b.y;
    this.pPos[i * 3 + 2] = b.z0 + Math.random() * (b.z1 - b.z0);
  }

  /** 射距離・的サイズが変わったら射場を作り直す。的は z = prep.D (ボウ基準)、シューティングラインは z = prep.lineZ */
  setRange(prep) {
    const distance = prep.D, faceCm = prep.face, lineZ = prep.lineZ;
    this.distance = distance;
    this.targetGroup.clear();
    this.lines.clear();
    const straw = new THREE.MeshLambertMaterial({ color: '#c9a86a' });
    const butt = new THREE.Mesh(new THREE.BoxGeometry(1.35, 1.35, 0.4), straw);
    butt.position.set(0, TARGET_CENTER_HEIGHT, distance + 0.2);
    const tex = new THREE.CanvasTexture(faceCanvas(1024));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const s = faceCm / 100;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.1 }));
    face.rotation.y = Math.PI;
    face.position.set(0, TARGET_CENTER_HEIGHT, distance - 0.002);
    const legMat = new THREE.MeshLambertMaterial({ color: '#6b4a2b' });
    for (const x of [-0.55, 0.55]) {
      this.targetGroup.add(cylinderBetween([x, 0, distance + 0.6], [x, TARGET_CENTER_HEIGHT + 0.6, distance + 0.15], 0.03, legMat));
    }
    this.targetGroup.add(butt, face);

    const lineMat = new THREE.MeshLambertMaterial({ color: '#f5f5f5' });
    const strip = (w, d, x, z) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), lineMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.004, z);
      m.receiveShadow = true;
      this.lines.add(m);
    };
    strip(20, 0.05, 0, lineZ);              // シューティングライン (射手がまたぐ)
    strip(20, 0.05, 0, lineZ - 3);          // ウェイティングライン (3m 後方)
    for (const x of [-1.25, 1.25]) strip(0.04, 3, x, lineZ - 1.5);   // 射座 (レーン) の区切り
    for (let d = 10; d < distance - lineZ; d += 10) strip(0.6, 0.04, -3, lineZ + d);   // ラインからの距離マーカー
    // 吹き流し (射場の中間・左側)
    this.sockPos = [-3.5, 3.2, distance * 0.5];
    const pole = cylinderBetween([-3.5, 0, distance * 0.5], [-3.5, 3.3, distance * 0.5], 0.03, new THREE.MeshLambertMaterial({ color: '#bbbbbb' }));
    this.sock = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.9, 16, 1, true), new THREE.MeshLambertMaterial({ color: '#ff6a00', side: THREE.DoubleSide }));
    cone.rotation.x = Math.PI / 2;    // 先端が +z を向く
    cone.position.z = 0.45;
    this.sock.add(cone);
    this.sock.position.set(...this.sockPos);
    this.targetGroup.add(pole, this.sock);

    this.bounds = { x: 8, y: 4, z0: lineZ - 3, z1: distance + 4 };
    for (let i = 0; i < PARTICLES; i++) this.respawn(i);
    this.clearStuck();
  }

  /** ボウと射手のモデルをセットアップから作り直す */
  setBow(prep, setup) {
    this.prep = prep;
    this.setup = setup;
    this.gripY = prep.hArrow - GRIP_BELOW_ARROW;
    const bowGroup = this.bowGroup;
    bowGroup.clear();
    bowGroup.position.set(0, this.gripY, 0);
    bowGroup.quaternion.identity();
    const riserMat = new THREE.MeshStandardMaterial({ color: '#2b3a55', metalness: 0.6, roughness: 0.35 });
    const limbMat = new THREE.MeshStandardMaterial({ color: '#111', metalness: 0.2, roughness: 0.5 });
    const rodMat = new THREE.MeshStandardMaterial({ color: '#202020', metalness: 0.3, roughness: 0.4 });
    const weightMat = new THREE.MeshStandardMaterial({ color: '#b8bcc4', metalness: 0.9, roughness: 0.25 });
    const damperMat = new THREE.MeshStandardMaterial({ color: '#d12f2f', roughness: 0.8 });

    const riser = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.6, 0.05), riserMat);
    riser.position.set(0, 0, 0.01);
    riser.castShadow = true;
    bowGroup.add(riser);
    const limbCurve = (sgn) => new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.3 * sgn, 0.01), new THREE.Vector3(0, 0.55 * sgn, -0.045),
      new THREE.Vector3(0, 0.78 * sgn, -0.07), new THREE.Vector3(0, 0.845 * sgn, -0.035),
    ]);
    for (const sgn of [1, -1]) {
      const limb = new THREE.Mesh(new THREE.TubeGeometry(limbCurve(sgn), 24, 0.012, 8), limbMat);
      limb.castShadow = true;
      bowGroup.add(limb);
    }
    this.tipTop = [0, 0.84, -0.04];
    this.tipBottom = [0, -0.84, -0.04];

    // サイト
    bowGroup.add(cylinderBetween([-0.015, 0.13, 0.02], [-0.035, 0.13, 0.25], 0.006, rodMat));
    const pin = new THREE.Mesh(new THREE.SphereGeometry(0.006, 10, 8), new THREE.MeshBasicMaterial({ color: '#00ff8c' }));
    pin.position.set(-0.035, 0.13 + setup.sight.yMm / 4000, 0.25);
    bowGroup.add(pin);

    const vbarMat = new THREE.MeshStandardMaterial({ color: '#3a3f47', metalness: 0.7, roughness: 0.3 });
    for (const part of prep.model.parts) {
      if (part.kind === 'vbar') {
        // Vバー本体: エクステンダー先端のブロックから、サイドロッドの取付ネジが左右後方に出ている
        const block = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.035), vbarMat);
        block.position.copy(v3(part.from));
        block.castShadow = true;
        bowGroup.add(block);
        continue;
      }
      if (part.kind === 'extender') {
        bowGroup.add(cylinderBetween(part.from, part.to, 0.0095, rodMat));
        continue;
      }
      const radius = part.name === 'center' ? 0.009 : 0.007;
      const dir = v3(part.to).sub(v3(part.from)).normalize();
      // サイドロッドは Vバーのブロック表面から出す
      const from = part.name === 'center' ? part.from : v3(part.from).add(dir.clone().multiplyScalar(0.025)).toArray();
      bowGroup.add(cylinderBetween(from, part.to, radius, rodMat));
      const wlen = Math.max(0.01, part.tipOz * 0.011);
      const end = v3(part.to).add(dir.clone().multiplyScalar(wlen));
      bowGroup.add(cylinderBetween(part.to, [end.x, end.y, end.z], 0.015, weightMat));
      if (part.damper) {
        const at = v3(part.from).lerp(v3(part.to), 0.92);
        const d2 = at.clone().add(dir.clone().multiplyScalar(0.03));
        bowGroup.add(cylinderBetween([at.x, at.y, at.z], [d2.x, d2.y, d2.z], 0.014, damperMat));
      }
    }

    // 弦
    const stringGeo = new THREE.BufferGeometry().setFromPoints([v3(this.tipTop), new THREE.Vector3(), v3(this.tipBottom)]);
    this.string = new THREE.Line(stringGeo, new THREE.LineBasicMaterial({ color: '#f2f2f2' }));
    bowGroup.add(this.string);
    this.setDraw(0);
    this.buildArcher(prep);
  }

  /** 弦の引き量 (0=ブレース, 1=フルドロー) */
  setDraw(f) {
    if (!this.string) return;
    const brace = this.setup.bow.braceIn * INCH;
    const draw = this.prep.drawIn * INCH;
    const z = -(brace + (draw - brace) * f);
    const p = this.string.geometry.attributes.position;
    p.setXYZ(1, 0, GRIP_BELOW_ARROW, z);
    p.needsUpdate = true;
    this.stringZ = z;
    this.poseArcher();
  }

  /**
   * 右利きの射手。シューティングライン (z = lineZ) をまたいで横向きに立ち、胸は +x (射手の右手側) を向く。
   * 弓手 (左) は的方向へ伸ばしてグリップを握り、右手は弦を引いてあご下にアンカーする。
   * 体は弦が胸をかすめる程度に矢のラインの左後ろへ置く。寸法は身長から決め、目とアンカーは物理モデルの値に合わせる。
   */
  buildArcher(prep) {
    const g = this.archerGroup;
    g.clear();
    const H = this.setup.player.heightCm / 100;
    const k = H / 1.75;
    const skin = new THREE.MeshLambertMaterial({ color: '#d7a98c' });
    const shirt = new THREE.MeshLambertMaterial({ color: '#2f5fa8' });
    const shirtDark = new THREE.MeshLambertMaterial({ color: '#244a85' });
    const pants = new THREE.MeshLambertMaterial({ color: '#2a2a33' });
    const shoe = new THREE.MeshLambertMaterial({ color: '#e8e8e8' });
    const sole = new THREE.MeshLambertMaterial({ color: '#444' });
    const hair = new THREE.MeshLambertMaterial({ color: '#2b1d14' });
    const gear = new THREE.MeshLambertMaterial({ color: '#1d1d1d' });
    const P = (x, y, z) => new THREE.Vector3(x, y, z);

    const yA = prep.hArrow;
    const eye = v3(prep.eye);
    const zLine = prep.lineZ;                 // 両足の中央 = シューティングライン
    const yShoulder = yA - 0.07;
    const torso = 0.29 * H;                   // 肩〜股関節
    const yHip = yShoulder - torso;
    // 肩の線: 弓手の肩はあごのすぐ横 (矢のラインの少し後ろ側)。そこから背中側へ SHOULDER_YAW だけ開いて
    // 引き手の肩がある。こうすると引き手の肘が矢の延長線上の後方に来る。
    const yaw = SHOULDER_YAW;
    const shoulderDir = P(-Math.sin(yaw), 0, -Math.cos(yaw));
    const bowSh = P(-0.07 * k, yShoulder, eye.z + 0.04 * k);
    const sh = { bow: bowSh, draw: bowSh.clone().add(shoulderDir.clone().multiplyScalar(0.34 * k)) };
    const chestC = sh.bow.clone().lerp(sh.draw, 0.5);
    const xSpine = chestC.x;
    this.body = { k, H, yA, sh, upper: 0.172 * H, fore: 0.152 * H };

    // ---- 脚: 肩幅に開き、ラインの前後に1本ずつ ----
    const stance = 0.2 * k;
    const legs = [];
    for (const sgn of [1, -1]) {
      const hipJ = P(xSpine, yHip, zLine + sgn * 0.09 * k);
      const ankle = P(xSpine + 0.01, 0.08 * k, zLine + sgn * stance);
      const L = hipJ.distanceTo(ankle) * 1.01 / 2;
      const { joint: knee } = solveTwoBone(hipJ, ankle, L, L, P(1, 0, 0));
      const thigh = makeBone(0.085 * k, 0.06 * k, pants);
      thigh.update(hipJ, knee);
      const shin = makeBone(0.058 * k, 0.042 * k, pants);
      shin.update(knee, ankle);
      g.add(thigh, shin, ellipsoid(0.06 * k, 0.06 * k, 0.06 * k, pants, knee));
      // 靴: つま先は胸の向き (+x)。前足 (的側) は少し開く
      const foot = new THREE.Group();
      const upperShoe = new THREE.Mesh(new THREE.BoxGeometry(0.26 * k, 0.07 * k, 0.1 * k), shoe);
      upperShoe.position.set(0.07 * k, 0.045 * k, 0);
      const soleM = new THREE.Mesh(new THREE.BoxGeometry(0.27 * k, 0.02 * k, 0.105 * k), sole);
      soleM.position.set(0.07 * k, 0.01, 0);
      upperShoe.castShadow = soleM.castShadow = true;
      foot.add(upperShoe, soleM);
      foot.position.set(ankle.x - 0.02, 0, ankle.z);
      foot.rotation.y = sgn > 0 ? 0.3 : 0.05;
      g.add(foot);
      legs.push(hipJ);
    }

    // ---- 胴体: 局所座標 (x=胸の正面, z=弓手側) で作って肩の線の向きに回す。腰は肩ほどは開かない ----
    const chest = new THREE.Group();
    chest.position.set(chestC.x, 0, chestC.z);
    chest.rotation.y = yaw;
    const pelvis = new THREE.Group();
    pelvis.position.set(xSpine, 0, zLine);
    pelvis.rotation.y = yaw * 0.35;
    pelvis.add(ellipsoid(0.105 * k, 0.11 * k, 0.17 * k, pants, P(0, yHip + 0.04 * k, 0)));            // 骨盤
    pelvis.add(ellipsoid(0.108 * k, 0.025, 0.155 * k, gear, P(0, yHip + 0.1 * k, 0)));                // ベルト
    chest.add(ellipsoid(0.1 * k, 0.17 * k, 0.145 * k, shirtDark, P(0, yHip + 0.2 * k, 0)));          // 腹
    chest.add(ellipsoid(0.115 * k, 0.17 * k, 0.175 * k, shirt, P(0.005, yShoulder - 0.12 * k, 0)));  // 胸
    chest.add(ellipsoid(0.02, 0.13 * k, 0.1 * k, gear, P(0.1 * k, yShoulder - 0.12 * k, 0.07 * k))); // チェストガード (弓手側の胸)
    g.add(chest, pelvis);
    for (const s of [sh.bow, sh.draw]) g.add(ellipsoid(0.058 * k, 0.058 * k, 0.058 * k, shirt, s));
    // ベルトとクイーバー (引き手側の腰)
    const qTop = P(xSpine + 0.06, yHip + 0.06, zLine - 0.2 * k), qBot = P(xSpine + 0.1, yHip - 0.32, zLine - 0.12 * k);
    const quiver = makeBone(0.045, 0.035, gear);
    quiver.update(qBot, qTop);
    g.add(quiver);
    const qDir = qTop.clone().sub(qBot).normalize();
    for (let i = 0; i < 4; i++) {
      const fl = makeBone(0.006, 0.006, new THREE.MeshLambertMaterial({ color: SHOT_COLORS[i] }));
      const off = P(Math.cos(i * 1.7) * 0.02, 0, Math.sin(i * 1.7) * 0.02);
      fl.update(qTop.clone().add(off), qTop.clone().add(off).add(qDir.clone().multiplyScalar(0.07)));
      g.add(fl);
    }

    // ---- 首・頭: 顔は的を向き、右目が矢の真上 (物理の eye) に来る ----
    const head = P(eye.x - 0.035 * k, eye.y + 0.01, eye.z - 0.075 * k);
    const neckBase = P(chestC.x + 0.01, yShoulder + 0.03, chestC.z);
    const neck = makeBone(0.05 * k, 0.045 * k, skin);
    neck.update(neckBase, head.clone().add(P(0, -0.08 * k, -0.02)));
    g.add(neck);
    const headG = new THREE.Group();
    headG.position.copy(head);
    headG.add(ellipsoid(0.08 * k, 0.11 * k, 0.095 * k, skin));
    const hairM = ellipsoid(0.085 * k, 0.09 * k, 0.095 * k, hair, P(0, 0.035 * k, -0.012 * k));
    headG.add(hairM);
    headG.add(ellipsoid(0.03 * k, 0.04 * k, 0.03 * k, skin, P(0, -0.075 * k, 0.045 * k)));   // あご
    headG.add(ellipsoid(0.012 * k, 0.018 * k, 0.02 * k, skin, P(0.01 * k, -0.005, 0.09 * k))); // 鼻
    for (const sgn of [1, -1]) headG.add(ellipsoid(0.015, 0.025, 0.012, skin, P(sgn * 0.08 * k, 0, -0.005)));  // 耳
    g.add(headG);
    this.head = headG;

    // ---- 腕 (毎フレーム poseArcher で関節位置を解く) ----
    const arm = () => ({
      upper: makeBone(0.048 * k, 0.038 * k, shirt),
      fore: makeBone(0.036 * k, 0.028 * k, skin),
      elbow: ellipsoid(0.04 * k, 0.04 * k, 0.04 * k, shirt),
      hand: ellipsoid(0.028 * k, 0.045 * k, 0.05 * k, skin),
    });
    this.bowArm = arm();
    this.drawArm = arm();
    this.armGuard = makeBone(0.04 * k, 0.034 * k, gear);
    this.tab = ellipsoid(0.01, 0.04 * k, 0.035 * k, gear);
    for (const a of [this.bowArm, this.drawArm]) g.add(a.upper, a.fore, a.elbow, a.hand);
    g.add(this.armGuard, this.tab);
    this.released = false;
    this.poseArcher();
  }

  /** 弓手はグリップ、引き手は弦 (リリース後はフォロースルーで首の後ろへ) に合わせて腕の関節を解く */
  poseArcher() {
    const b = this.body;
    if (!b || !this.bowArm) return;
    const P = (x, y, z) => new THREE.Vector3(x, y, z);
    const place = (arm, shoulder, wrist, handTip, pole) => {
      const { joint, end } = solveTwoBone(shoulder, wrist, b.upper, b.fore, pole);
      arm.upper.update(shoulder, joint);
      arm.fore.update(joint, end);
      arm.elbow.position.copy(joint);
      const hd = handTip.clone().sub(end);
      arm.hand.position.copy(end).add(hd.clone().multiplyScalar(0.5));
      arm.hand.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hd.normalize());
      return { joint, end };
    };
    // 弓手: 手首はグリップの少し後ろ。肘は弦を避けて外側 (−x) へ逃がす
    const grip = P(0.0, this.gripY, -0.005);
    const bw = place(this.bowArm, b.sh.bow, P(-0.01, this.gripY + 0.005, -0.065 * b.k), grip, P(-1, -0.4, 0));
    this.armGuard.update(bw.joint.clone().lerp(bw.end, 0.35), bw.end.clone().lerp(bw.joint, 0.05));

    // 引き手: 指は弦のノッキング位置。肘は矢の延長線上の後ろ・やや上へ
    let fingers;
    if (this.released) fingers = P(0.03, b.yA - 0.02, this.prep.eye[2] - 0.2 * b.k);   // フォロースルー
    else fingers = P(0, b.yA - 0.005, this.stringZ ?? -0.2);
    const wrist = fingers.clone().add(P(0.03 * b.k, -0.015, -0.075 * b.k));
    const dw = place(this.drawArm, b.sh.draw, wrist, fingers, P(0.55, 0.05, -0.84));
    this.tab.position.copy(dw.end.clone().lerp(fingers, 0.7));
    this.tab.quaternion.copy(this.drawArm.hand.quaternion);
  }

  setBowAttitude(q) {
    this.bowGroup.quaternion.set(q[1], q[2], q[3], q[0]);
  }

  resetBow() {
    this.bowGroup.quaternion.identity();
    this.released = false;
    this.poseArcher();
  }

  clearStuck() {
    this.stuckGroup.clear();
  }

  makeArrowMesh(arrow, color, segments = 10) {
    const g = new THREE.Group();
    const shaftMat = new THREE.MeshStandardMaterial({ color: '#1b1b1b', metalness: 0.3, roughness: 0.4 });
    const L = arrow.L, xc = arrow.xCg;
    const rr = Math.max(arrow.r, 0.0025);
    g.userData.segments = [];
    for (let i = 0; i < segments; i++) {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr, L / segments, 8), shaftMat);
      seg.rotation.x = Math.PI / 2;
      const s = (i + 0.5) / segments;
      seg.position.z = s * L - xc;
      seg.userData.s = s;
      g.add(seg);
      g.userData.segments.push(seg);
    }
    const point = new THREE.Mesh(new THREE.ConeGeometry(rr, 0.02, 8), new THREE.MeshStandardMaterial({ color: '#cfcfcf', metalness: 0.9 }));
    point.rotation.x = Math.PI / 2;
    point.position.z = L - xc + 0.01;
    g.add(point);
    const vaneMat = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
    const vanes = new THREE.Group();
    for (let k = 0; k < 3; k++) {
      const v = new THREE.Mesh(new THREE.PlaneGeometry(0.012, 0.045), vaneMat);
      v.rotation.x = Math.PI / 2;
      const a = (k * 2 * Math.PI) / 3;
      v.position.set(Math.cos(a) * (rr + 0.006), Math.sin(a) * (rr + 0.006), 0);
      v.rotation.y = a;
      const holder = new THREE.Group();
      holder.add(v);
      vanes.add(holder);
    }
    vanes.position.z = 0.045 - xc;
    g.add(vanes);
    g.userData.vanes = vanes;
    const nock = new THREE.Mesh(new THREE.CylinderGeometry(rr * 1.1, rr * 1.1, 0.015, 8), new THREE.MeshLambertMaterial({ color }));
    nock.rotation.x = Math.PI / 2;
    nock.position.z = -xc + 0.007;
    g.add(nock);
    return g;
  }

  /** 矢の発射 (結果 result.flight.path を再生) */
  launch(result, shotIndex) {
    if (this.flying) this.scene.remove(this.flying.mesh);
    const color = SHOT_COLORS[shotIndex % 6];
    const mesh = this.makeArrowMesh(this.prep.arrow, color);
    mesh.traverse((o) => { o.castShadow = true; });
    this.world.add(mesh);
    this.flying = { mesh, result, color, done: false };
    this.released = true;
    this.placeArrow(0);
  }

  /** 経過時間 t の矢の位置・姿勢・パラドックスのしなりを反映。着弾後は true を返す */
  placeArrow(t, exaggerate = 1) {
    const f = this.flying;
    if (!f) return true;
    const path = f.result.flight.path;
    let i = 0;
    while (i < path.length - 2 && path[i + 1].t < t) i++;
    const a = path[i], b = path[Math.min(i + 1, path.length - 1)];
    const u = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 1;
    const pos = v3(a.r).lerp(v3(b.r), u);
    const dir = v3(a.d).lerp(v3(b.d), u).normalize();
    f.mesh.position.copy(pos);
    f.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    // 4.3 アーチャーズ・パラドックス: 自由-自由梁1次モード形状 (両端と中央が逆位相) で横にしならせる
    const ys = paradoxDeflection(this.prep.arrow.paradox, Math.min(t, f.result.flightTime)) * exaggerate;
    for (const seg of f.mesh.userData.segments) {
      seg.position.x = ys * Math.cos(2 * Math.PI * seg.userData.s);
    }
    const dist = pos.z;
    f.mesh.userData.vanes.rotation.z = (2 * Math.PI * dist) / this.prep.arrow.spinPitch;
    const finished = t >= f.result.flightTime;
    if (finished && !f.done) {
      f.done = true;
      for (const seg of f.mesh.userData.segments) seg.position.x = 0;
      if (f.result.flight.reached) {
        // 畳に刺さった状態で残す (約 25cm 刺さる)
        const stuck = f.mesh;
        stuck.position.add(dir.clone().multiplyScalar(0.25));
        this.world.remove(stuck);
        this.stuckGroup.add(stuck);
      } else {
        this.world.remove(f.mesh);
      }
      this.flying = null;
    }
    return finished;
  }

  /** 飛翔中の矢の位置 (Three.js のワールド座標) */
  arrowPosition() {
    return this.flying ? this.flying.mesh.getWorldPosition(new THREE.Vector3()) : null;
  }

  updateWind(windField, simTime, dt) {
    const b = this.bounds;
    for (let i = 0; i < PARTICLES; i++) {
      const x = this.pPos[i * 3], y = this.pPos[i * 3 + 1], z = this.pPos[i * 3 + 2];
      const w = windField.at(x, y, z, simTime);
      const nx = x + w[0] * dt, ny = y + w[1] * dt, nz = z + w[2] * dt;
      if (Math.abs(nx) > b.x || ny < 0.05 || ny > b.y + 0.5 || nz < b.z0 || nz > b.z1) {
        this.respawn(i);
        // 風上側の端から再投入する
        if (Math.abs(w[0]) > Math.abs(w[2])) this.pPos[i * 3] = -Math.sign(w[0]) * b.x * 0.999;
        else if (Math.abs(w[2]) > 0.05) this.pPos[i * 3 + 2] = w[2] > 0 ? b.z0 + 0.01 : b.z1 - 0.01;
      } else {
        this.pPos[i * 3] = nx;
        this.pPos[i * 3 + 1] = ny;
        this.pPos[i * 3 + 2] = nz;
      }
    }
    this.particles.geometry.attributes.position.needsUpdate = true;
    if (this.sock) {
      const w = windField.at(...this.sockPos, simTime);
      const sp = Math.hypot(w[0], w[2]);
      const yaw = Math.atan2(w[0], w[2]);
      const droop = (1 - Math.min(1, sp / 6)) * (Math.PI / 2) * 0.9;
      this.sock.rotation.set(0, 0, 0);
      this.sock.rotateY(yaw);
      this.sock.rotateX(droop);
    }
  }

  setMode(mode) {
    this.mode = mode;
    this.controls.enabled = mode === 'third';
    // 1人称では目の直前にある弦・ハンドル・自分の体が視界を塞ぐので描画しない (照準はピンのオーバーレイで示す)
    this.bowGroup.visible = mode !== 'first';
    this.archerGroup.visible = mode !== 'first';
    if (mode === 'third') {
      this.camera.fov = 45;
      this.camera.position.set(-2.4, 1.9, -2.6);
      this.controls.target.set(0, 1.3, 1.2);
      this.camera.updateProjectionMatrix();
    }
  }

  /** 1人称: 目の位置からサイトピンの向き (=的中心 + 照準の揺れ) を見る */
  render(sway) {
    const cam = this.camera;
    if (this.mode === 'first' && this.prep) {
      const e = this.prep.eye;
      cam.position.copy(toThree(e[0], e[1], e[2]));
      const D = this.distance - e[2];
      const look = toThree(Math.tan(sway.azim) * D, TARGET_CENTER_HEIGHT + Math.tan(sway.elev) * D, this.distance);
      cam.up.set(0, 1, 0);
      cam.lookAt(look);
      if (cam.fov !== this.fovFirst) {
        cam.fov = this.fovFirst;
        cam.updateProjectionMatrix();
      }
    } else if (this.mode === 'follow') {
      const p = this.arrowPosition();
      if (p) {
        const d = this.flying.mesh.getWorldDirection(new THREE.Vector3());
        cam.position.copy(p).add(d.clone().multiplyScalar(-1.1)).add(new THREE.Vector3(0.25, 0.18, 0));
        cam.lookAt(p.clone().add(d.multiplyScalar(2)));
      } else {
        cam.position.copy(toThree(0.8, TARGET_CENTER_HEIGHT + 0.25, this.distance - 2.5));
        cam.lookAt(toThree(0, TARGET_CENTER_HEIGHT, this.distance));
      }
      if (cam.fov !== 50) {
        cam.fov = 50;
        cam.updateProjectionMatrix();
      }
    } else {
      this.controls.update();
    }
    this.renderer.render(this.scene, cam);
  }
}
