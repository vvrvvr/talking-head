import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { createBlendKeyController } from "./blendControl.js";
import { createTypewriterLine } from "./typewriter.js";

/** @type {{ update: () => void, getDebugState: () => { heldKeys: string[] } } | null} */
let blendControl = null;

const canvas = document.getElementById("viewport");
const statusEl = document.getElementById("status");

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.classList.remove("is-error", "is-ready", "is-idle");
  if (kind) statusEl.classList.add(kind);
}

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  35,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.set(0, 0.15, 1.8);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(0, 0.05, 0);
controls.minDistance = 0.32;
controls.maxDistance = 4;
controls.update();

/** Frontal rest pose — distance is driven by typing zoom */
const HOME = {
  position: new THREE.Vector3(0, 0.12, 1.65),
  target: new THREE.Vector3(0, 0.05, 0),
  idleDelay: 1.1,
  returnDuration: 0.85,
};

const TYPE_ZOOM = {
  startDist: 1.65,
  /** ~20% less aggressive than previous endDist 0.42 */
  endDist: 0.666,
  homeY: 0.12,
  /** More characters → slower approach to the face */
  charsToMax: 220,
  /** Lower = smoother / slower catch-up toward the target distance */
  smooth: 2.8,
};

/** Smoothed dolly distance (shared by typing zoom + center-return) */
let homeDistance = TYPE_ZOOM.startDist;
let homeDistanceTarget = TYPE_ZOOM.startDist;

const _homePos = HOME.position.clone();
const _homeTarget = HOME.target.clone();
const _fromPos = new THREE.Vector3();
const _fromTarget = new THREE.Vector3();
const _zoomOffset = new THREE.Vector3();

let orbitPointerDown = false;
let returnArmedAt = 0;
let returning = false;
let returnStartedAt = 0;
let lastFrameTime = performance.now() / 1000;

function syncHomePose() {
  HOME.position.set(0, TYPE_ZOOM.homeY, homeDistance);
  HOME.target.set(0, 0.05, 0);
}

/** Keep orbit angles, set distance to homeDistance */
function applyDistanceToCamera() {
  _zoomOffset.copy(camera.position).sub(controls.target);
  if (_zoomOffset.lengthSq() < 1e-8) {
    _zoomOffset.set(0, TYPE_ZOOM.homeY - 0.05, 1);
  }
  _zoomOffset.setLength(homeDistance);
  camera.position.copy(controls.target).add(_zoomOffset);
}

function applyTypingZoom(charCount) {
  const t = Math.min(1, charCount / TYPE_ZOOM.charsToMax);
  const eased = 1 - (1 - t) ** 2;
  homeDistanceTarget = THREE.MathUtils.lerp(
    TYPE_ZOOM.startDist,
    TYPE_ZOOM.endDist,
    eased
  );
}

/** Ease homeDistance toward target each frame */
function updateTypingZoom(dt) {
  const k = 1 - Math.exp(-TYPE_ZOOM.smooth * dt);
  const prev = homeDistance;
  homeDistance = THREE.MathUtils.lerp(homeDistance, homeDistanceTarget, k);

  if (Math.abs(homeDistance - prev) < 1e-5) {
    homeDistance = homeDistanceTarget;
    syncHomePose();
    return;
  }

  syncHomePose();

  if (returning) {
    _homePos.copy(HOME.position);
    _homeTarget.copy(HOME.target);
    return;
  }

  applyDistanceToCamera();
  controls.update();
}

function armCameraReturn() {
  returning = false;
  returnArmedAt = performance.now() / 1000 + HOME.idleDelay;
}

function startCameraReturn() {
  // Re-sync home so return uses current typing zoom, not a stale distance
  syncHomePose();
  _fromPos.copy(camera.position);
  _fromTarget.copy(controls.target);
  _homePos.copy(HOME.position);
  _homeTarget.copy(HOME.target);
  returning = true;
  returnStartedAt = performance.now() / 1000;
  returnArmedAt = 0;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function updateCameraReturn() {
  if (orbitPointerDown) return;

  const now = performance.now() / 1000;

  if (!returning && returnArmedAt > 0 && now >= returnArmedAt) {
    syncHomePose();
    const away =
      camera.position.distanceTo(HOME.position) > 0.025 ||
      controls.target.distanceTo(HOME.target) > 0.025;
    if (away) startCameraReturn();
    else returnArmedAt = 0;
  }

  if (!returning) return;

  // Keep destination locked to current zoom while animating
  syncHomePose();
  _homePos.copy(HOME.position);
  _homeTarget.copy(HOME.target);

  const t = Math.min(1, (now - returnStartedAt) / HOME.returnDuration);
  const k = easeInOutCubic(t);

  camera.position.lerpVectors(_fromPos, _homePos, k);
  controls.target.lerpVectors(_fromTarget, _homeTarget, k);
  controls.update();

  if (t >= 1) {
    camera.position.copy(_homePos);
    controls.target.copy(_homeTarget);
    controls.update();
    returning = false;
  }
}

controls.addEventListener("start", () => {
  orbitPointerDown = true;
  returning = false;
  returnArmedAt = 0;
});

controls.addEventListener("end", () => {
  orbitPointerDown = false;
  armCameraReturn();
});

// Studio lights for polished marble
scene.add(new THREE.AmbientLight(0xffffff, 0.25));

const key = new THREE.DirectionalLight(0xfff8f0, 1.65);
key.position.set(2.6, 3.8, 2.4);
scene.add(key);

const fill = new THREE.DirectionalLight(0xdce6f2, 0.7);
fill.position.set(-3.0, 1.6, -0.8);
scene.add(fill);

const rim = new THREE.DirectionalLight(0xf0f4ff, 1.1);
rim.position.set(-0.6, 2.2, -3.0);
scene.add(rim);

const bounce = new THREE.DirectionalLight(0xffffff, 0.35);
bounce.position.set(0.2, -2.5, 1.5);
scene.add(bounce);

function frameObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  object.position.sub(center);

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  object.scale.setScalar(1.15 / maxDim);

  const fitted = new THREE.Box3().setFromObject(object);
  object.position.sub(fitted.getCenter(new THREE.Vector3()));

  controls.target.set(0, 0.05, 0);
  homeDistance = TYPE_ZOOM.startDist;
  homeDistanceTarget = TYPE_ZOOM.startDist;
  syncHomePose();
  camera.position.copy(HOME.position);
  controls.update();
}

function createMarbleTextures() {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#c5beb2";
  ctx.fillRect(0, 0, size, size);

  // Soft cloudy base
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 40 + Math.random() * 120;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${0.08 + Math.random() * 0.12})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Marble veins
  for (let i = 0; i < 14; i++) {
    ctx.beginPath();
    let x = Math.random() * size;
    let y = Math.random() * size;
    ctx.moveTo(x, y);
    const segments = 6 + Math.floor(Math.random() * 6);
    for (let s = 0; s < segments; s++) {
      x += (Math.random() - 0.45) * 90;
      y += (Math.random() - 0.5) * 70;
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(150, 145, 138, ${0.08 + Math.random() * 0.14})`;
    ctx.lineWidth = 0.8 + Math.random() * 2.2;
    ctx.stroke();
  }

  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;

  // Roughness: mostly polished, slightly duller in vein areas
  const roughCanvas = document.createElement("canvas");
  roughCanvas.width = size;
  roughCanvas.height = size;
  const rctx = roughCanvas.getContext("2d");
  rctx.fillStyle = "#7a7a7a";
  rctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 18; i++) {
    rctx.beginPath();
    let x = Math.random() * size;
    let y = Math.random() * size;
    rctx.moveTo(x, y);
    for (let s = 0; s < 5; s++) {
      x += (Math.random() - 0.5) * 100;
      y += (Math.random() - 0.5) * 80;
      rctx.lineTo(x, y);
    }
    rctx.strokeStyle = `rgba(150, 150, 150, ${0.3 + Math.random() * 0.4})`;
    rctx.lineWidth = 1 + Math.random() * 3;
    rctx.stroke();
  }
  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping;

  return { map, roughnessMap };
}

function applyMarbleMaterial(root) {
  const { map, roughnessMap } = createMarbleTextures();

  const marble = new THREE.MeshPhysicalMaterial({
    color: 0xb5aea3,
    map,
    roughnessMap,
    roughness: 0.55,
    metalness: 0.02,
    clearcoat: 0.2,
    clearcoatRoughness: 0.5,
    reflectivity: 0.28,
    envMapIntensity: 0.55,
    sheen: 0.06,
    sheenColor: new THREE.Color(0xcfc8bc),
    sheenRoughness: 0.6,
  });

  root.traverse((child) => {
    if (!child.isMesh) return;

    const old = child.material;
    if (old) {
      const mats = Array.isArray(old) ? old : [old];
      for (const mat of mats) {
        if (mat?.map) {
          mat.map.dispose?.();
          mat.map = null;
        }
      }
    }

    child.material = marble.clone();
    child.material.map = map;
    child.material.roughnessMap = roughnessMap;
    child.material.needsUpdate = true;
  });
}

const manager = new THREE.LoadingManager();
manager.setURLModifier((url) => {
  const clean = url.split("?")[0].toLowerCase();
  if (
    /\.(png|jpe?g|webp|tga|bmp|tif{1,2})$/.test(clean) ||
    clean.includes("kelly.png")
  ) {
    return PIXEL;
  }
  if (/^[a-z]:[\\/]/i.test(url) || url.includes("UNITY PROJECTS")) {
    return PIXEL;
  }
  return url;
});

manager.onError = (url) => {
  console.warn("Asset load error (ignored):", url);
};

setStatus("Загрузка…");

const typewriter = createTypewriterLine({
  rayEl: document.getElementById("chat-ray"),
  fieldEl: document.getElementById("chat-field"),
  ghostEl: document.getElementById("chat-ghost"),
  onAdvance: ({ length }) => applyTypingZoom(length),
});
typewriter.attach(window);
window.__typewriter = typewriter;

const loader = new FBXLoader(manager);
loader.load(
  "models/kelly.fbx",
  (fbx) => {
    applyMarbleMaterial(fbx);
    scene.add(fbx);
    frameObject(fbx);

    blendControl = createBlendKeyController(fbx);
    blendControl.attach(window);

    setStatus("Готово", "is-ready");

    window.__talkingHead = fbx;
    window.__blendControl = blendControl;
  },
  (event) => {
    if (!event.total) {
      setStatus(`Загрузка… ${(event.loaded / 1024 / 1024).toFixed(1)} МБ`);
      return;
    }
    const pct = Math.round((event.loaded / event.total) * 100);
    setStatus(`Загрузка… ${pct}%`);
  },
  (error) => {
    console.error(error);
    setStatus("Ошибка загрузки", "is-error");
  }
);

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

window.addEventListener("resize", onResize);

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now() / 1000;
  const dt = Math.min(0.05, Math.max(0, now - lastFrameTime));
  lastFrameTime = now;

  blendControl?.update();
  updateTypingZoom(dt);
  if (!returning) controls.update();
  updateCameraReturn();
  renderer.render(scene, camera);
}

animate();
