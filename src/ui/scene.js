// Three.js による射場・ボウ・矢・風パーティクルの描画。物理は src/physics 側で計算済みの結果を再生するだけ。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { faceCanvas, SHOT_COLORS } from './targetFace.js';
import { paradoxDeflection } from '../physics/arrow.js';
import { TARGET_CENTER_HEIGHT } from '../physics/scoring.js';
import { INCH } from '../physics/units.js';

const PARTICLES = 1400;
const GRIP_BELOW_ARROW = 0.03;   // 矢はグリップのピボットより少し上を通る

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

function cylinderBetween(a, b, radius, material) {
  const A = v3(a), B = v3(b);
  const len = A.distanceTo(B);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 12), material);
  mesh.position.copy(A).add(B).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  return mesh;
}

export class RangeScene {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
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
    this.scene.add(sun);

    this.buildGround();
    this.targetGroup = new THREE.Group();
    this.stuckGroup = new THREE.Group();
    this.bowGroup = new THREE.Group();
    this.archerGroup = new THREE.Group();
    this.scene.add(this.targetGroup, this.stuckGroup, this.bowGroup, this.archerGroup);
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
    this.scene.add(ground);
    this.lines = new THREE.Group();
    this.scene.add(this.lines);
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
    this.scene.add(this.particles);
    this.bounds = { x: 8, y: 4, z0: -4, z1: 30 };
    for (let i = 0; i < PARTICLES; i++) this.respawn(i);
  }

  respawn(i) {
    const b = this.bounds;
    this.pPos[i * 3] = (Math.random() * 2 - 1) * b.x;
    this.pPos[i * 3 + 1] = 0.1 + Math.random() * b.y;
    this.pPos[i * 3 + 2] = b.z0 + Math.random() * (b.z1 - b.z0);
  }

  /** 射距離・的サイズが変わったら射場を作り直す */
  setRange(distance, faceCm) {
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

    const lineMat = new THREE.MeshBasicMaterial({ color: '#f5f5f5' });
    const shootLine = new THREE.Mesh(new THREE.PlaneGeometry(20, 0.06), lineMat);
    shootLine.rotation.x = -Math.PI / 2;
    shootLine.position.set(0, 0.005, -0.2);
    this.lines.add(shootLine);
    for (let z = 10; z < distance; z += 10) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.04), lineMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(-3, 0.005, z);
      this.lines.add(m);
    }
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

    this.bounds = { x: 8, y: 4, z0: -4, z1: distance + 4 };
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
    bowGroup.add(riser);
    const limbCurve = (sgn) => new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.3 * sgn, 0.01), new THREE.Vector3(0, 0.55 * sgn, -0.045),
      new THREE.Vector3(0, 0.78 * sgn, -0.07), new THREE.Vector3(0, 0.845 * sgn, -0.035),
    ]);
    for (const sgn of [1, -1]) bowGroup.add(new THREE.Mesh(new THREE.TubeGeometry(limbCurve(sgn), 24, 0.012, 8), limbMat));
    this.tipTop = [0, 0.84, -0.04];
    this.tipBottom = [0, -0.84, -0.04];

    // サイト
    bowGroup.add(cylinderBetween([-0.015, 0.13, 0.02], [-0.035, 0.13, 0.25], 0.006, rodMat));
    const pin = new THREE.Mesh(new THREE.SphereGeometry(0.006, 10, 8), new THREE.MeshBasicMaterial({ color: '#00ff8c' }));
    pin.position.set(-0.035, 0.13 + setup.sight.yMm / 4000, 0.25);
    bowGroup.add(pin);

    for (const part of prep.model.parts) {
      const radius = part.name === 'center' ? 0.009 : 0.007;
      bowGroup.add(cylinderBetween(part.from, part.to, radius, rodMat));
      const dir = v3(part.to).sub(v3(part.from)).normalize();
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
    if (this.drawHand) {
      this.drawHand.position.set(0.03, this.gripY + GRIP_BELOW_ARROW - 0.02, z - 0.02);
    }
  }

  buildArcher(prep) {
    const g = this.archerGroup;
    g.clear();
    const skin = new THREE.MeshLambertMaterial({ color: '#d7a98c' });
    const cloth = new THREE.MeshLambertMaterial({ color: '#3a4f7a' });
    const pants = new THREE.MeshLambertMaterial({ color: '#2a2a33' });
    const y = prep.hArrow;
    const zEye = prep.eye[2];
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.105, 20, 16), skin);
    this.head.position.set(0.09, y + 0.12, zEye - 0.06);
    g.add(this.head);
    const shL = [0.05, y - 0.07, -0.6], shR = [0.12, y - 0.07, zEye - 0.32];
    g.add(cylinderBetween(shL, shR, 0.07, cloth));
    const hip = [0.1, y - 0.6, (shL[2] + shR[2]) / 2];
    g.add(cylinderBetween([(shL[0] + shR[0]) / 2, y - 0.08, hip[2]], hip, 0.13, cloth));
    g.add(cylinderBetween([0.1, y - 0.6, shL[2] + 0.05], [0.1, 0, shL[2] + 0.1], 0.06, pants));
    g.add(cylinderBetween([0.1, y - 0.6, shR[2] - 0.05], [0.1, 0, shR[2] - 0.1], 0.06, pants));
    g.add(cylinderBetween(shL, [0, this.gripY, -0.02], 0.035, cloth));
    this.drawHand = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), skin);
    g.add(this.drawHand);
    this.drawElbow = [0.12, y + 0.02, zEye - 0.38];
    g.add(cylinderBetween(shR, this.drawElbow, 0.035, cloth));
    this.setDraw(0);
  }

  setBowAttitude(q) {
    this.bowGroup.quaternion.set(q[1], q[2], q[3], q[0]);
  }

  resetBow() {
    this.bowGroup.quaternion.identity();
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
    this.scene.add(mesh);
    this.flying = { mesh, result, color, done: false };
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
        this.scene.remove(stuck);
        this.stuckGroup.add(stuck);
      } else {
        this.scene.remove(f.mesh);
      }
      this.flying = null;
    }
    return finished;
  }

  arrowPosition() {
    return this.flying ? this.flying.mesh.position.clone() : null;
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
      cam.position.set(e[0], e[1], e[2]);
      const D = this.distance - e[2];
      const look = new THREE.Vector3(Math.tan(sway.azim) * D, TARGET_CENTER_HEIGHT + Math.tan(sway.elev) * D, this.distance);
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
        cam.position.set(0.8, TARGET_CENTER_HEIGHT + 0.25, this.distance - 2.5);
        cam.lookAt(0, TARGET_CENTER_HEIGHT, this.distance);
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
