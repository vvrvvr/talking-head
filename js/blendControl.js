/**
 * Keyboard → random blend shapes
 *
 * Config (edit here):
 * - shapesPerKey: how many morphs to claim per held key
 * - pressDuration: seconds to ease toward random targets (0–100)
 * - releaseDuration: seconds to ease back to rest on keyup
 * - ease: easing function used for both directions
 *
 * Ownership:
 * - A shape is busy only while its key is physically held.
 * - On keyup shapes are freed immediately and ease back to rest,
 *   so the same key can be spammed and other keys can reuse them.
 * - Claiming a free shape mid-return interrupts that return.
 */

export const BLEND_CONFIG = {
  shapesPerKey: 5,
  pressDuration: 0.1,
  releaseDuration: 0.25,
  valueMin: 0,
  valueMax: 100,
  excludeNames: ["base_head"],
  ease: easeOutCubic,
};

export function easeLinear(t) {
  return t;
}

export function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

/**
 * Keys that feel like messaging / typing — not navigation, media, etc.
 * @param {KeyboardEvent} event
 */
export function isChatKey(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;

  const key = event.key;
  if (key === "Backspace" || key === "Delete" || key === "Enter") return true;
  if (key.length === 1) return true;
  return false;
}

/**
 * @param {import('three').Object3D} root
 */
export function createBlendKeyController(root, config = BLEND_CONFIG) {
  const cfg = { ...BLEND_CONFIG, ...config };
  const channels = collectChannels(root, cfg.excludeNames);

  /** @type {Map<string, RuntimeChannel>} */
  const runtime = new Map(
    channels.map((ch) => [
      ch.id,
      {
        ...ch,
        /** @type {string | null} */
        heldBy: null,
        rest: 0,
        /** @type {Tween | null} */
        tween: null,
        holdValue: 0,
      },
    ])
  );

  /** Keys currently physically down */
  const heldKeys = new Set();

  /** @type {Map<string, string[]>} keyCode → channel ids claimed while held */
  const keyClaims = new Map();

  const onKeyDown = (event) => {
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (shouldIgnoreTarget(event.target)) return;
    if (!isChatKey(event)) return;
    if (heldKeys.has(event.code)) return;

    heldKeys.add(event.code);

    const free = [...runtime.values()].filter((ch) => ch.heldBy === null);
    if (free.length === 0) return;

    const count = Math.min(cfg.shapesPerKey, free.length);
    const picked = pickRandom(free, count);
    const now = performance.now() / 1000;
    const ids = [];

    for (const ch of picked) {
      ch.heldBy = event.code;
      ids.push(ch.id);

      const current = ch.mesh.morphTargetInfluences[ch.index] ?? 0;
      const target100 =
        cfg.valueMin + Math.random() * (cfg.valueMax - cfg.valueMin);
      const to = target100 / 100;

      ch.rest = 0;
      ch.holdValue = to;
      ch.tween = {
        from: current,
        to,
        start: now,
        duration: cfg.pressDuration,
        mode: "press",
      };
    }

    keyClaims.set(event.code, ids);
    event.preventDefault();
  };

  const onKeyUp = (event) => {
    if (!heldKeys.has(event.code)) return;
    heldKeys.delete(event.code);

    const ids = keyClaims.get(event.code) || [];
    keyClaims.delete(event.code);

    const now = performance.now() / 1000;

    for (const id of ids) {
      const ch = runtime.get(id);
      if (!ch || ch.heldBy !== event.code) continue;

      const current = ch.mesh.morphTargetInfluences[ch.index] ?? 0;
      ch.heldBy = null; // free immediately — spam / other keys can reclaim
      ch.tween = {
        from: current,
        to: ch.rest,
        start: now,
        duration: cfg.releaseDuration,
        mode: "release",
      };
    }

    event.preventDefault();
  };

  // If the window loses focus mid-hold, release everything cleanly
  const onBlur = () => {
    for (const code of [...heldKeys]) {
      onKeyUp({ code, preventDefault() {} });
    }
  };

  function update() {
    const now = performance.now() / 1000;

    for (const ch of runtime.values()) {
      const influences = ch.mesh.morphTargetInfluences;

      if (!ch.tween) {
        if (ch.heldBy) influences[ch.index] = ch.holdValue;
        continue;
      }

      const { from, to, start, duration, mode } = ch.tween;
      const t = duration <= 0 ? 1 : Math.min(1, (now - start) / duration);
      const k = cfg.ease(t);
      influences[ch.index] = from + (to - from) * k;

      if (t < 1) continue;

      influences[ch.index] = to;
      ch.tween = null;

      if (mode === "press" && ch.heldBy) {
        ch.holdValue = to;
      }
    }
  }

  function attach(target = window) {
    target.addEventListener("keydown", onKeyDown);
    target.addEventListener("keyup", onKeyUp);
    target.addEventListener("blur", onBlur);
    return () => {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      target.removeEventListener("blur", onBlur);
    };
  }

  function getDebugState() {
    let busy = 0;
    for (const ch of runtime.values()) if (ch.heldBy) busy++;
    return {
      totalShapes: channels.length,
      busy,
      heldKeys: [...heldKeys],
    };
  }

  return { attach, update, getDebugState, channels };
}

function shouldIgnoreTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

function collectChannels(root, excludeNames) {
  const exclude = new Set(excludeNames.map((n) => n.toLowerCase()));
  /** @type {MorphChannel[]} */
  const list = [];

  root.traverse((obj) => {
    if (!obj.isMesh || !obj.morphTargetDictionary || !obj.morphTargetInfluences) {
      return;
    }
    for (const [name, index] of Object.entries(obj.morphTargetDictionary)) {
      if (exclude.has(name.toLowerCase())) continue;
      list.push({
        id: `${obj.uuid}:${index}`,
        name,
        index,
        mesh: obj,
      });
    }
  });

  return list;
}

function pickRandom(array, count) {
  const copy = array.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

/**
 * @typedef {{ id: string, name: string, index: number, mesh: import('three').Mesh }} MorphChannel
 * @typedef {{ from: number, to: number, start: number, duration: number, mode: 'press'|'release' }} Tween
 * @typedef {MorphChannel & { heldBy: string | null, rest: number, tween: Tween | null, holdValue: number }} RuntimeChannel
 */
