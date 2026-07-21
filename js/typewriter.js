/** Phrase typed into the fake chat line, looping forever. */
export const LOOP_PHRASE =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Donec a arcu sed lectus rutrum tincidunt vel eu justo. Fusce non nisi massa. Duis molestie quam sit amet purus efficitur, non rhoncus diam lacinia. Fusce viverra ante tortor, sit amet auctor leo congue vitae. Vivamus et elementum massa. Fusce placerat mauris et nulla feugiat, nec scelerisque mi iaculis. Sed ultricies tortor purus, in placerat neque sollicitudin in. Curabitur ullamcorper ipsum pulvinar velit suscipit elementum. Nam tortor nisl, congue nec velit eget, sodales fermentum quam. Fusce pretium sapien eget pulvinar semper. Donec rutrum ipsum ac enim lobortis, in cursus metus porta. ";

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
 * Cast a ray inside bounds; reflect off edges like light.
 * Returns polyline points covering at least `length` pixels.
 */
function buildReflectPath(startX, startY, dirX, dirY, length, bounds) {
  const pts = [{ x: startX, y: startY }];
  let x = startX;
  let y = startY;
  let dx = dirX;
  let dy = dirY;

  const len0 = Math.hypot(dx, dy) || 1;
  dx /= len0;
  dy /= len0;

  let traveled = 0;
  let guard = 0;

  while (traveled < length && guard++ < 80) {
    const { left, right, top, bottom } = bounds;

    // Nudge inward if somehow outside
    x = Math.min(Math.max(x, left + 0.5), right - 0.5);
    y = Math.min(Math.max(y, top + 0.5), bottom - 0.5);

    let tHit = Infinity;
    let hitAxis = null; // 'x' | 'y'

    if (dx > 1e-8) {
      const t = (right - x) / dx;
      if (t > 1e-4 && t < tHit) {
        tHit = t;
        hitAxis = "x";
      }
    } else if (dx < -1e-8) {
      const t = (left - x) / dx;
      if (t > 1e-4 && t < tHit) {
        tHit = t;
        hitAxis = "x";
      }
    }

    if (dy > 1e-8) {
      const t = (bottom - y) / dy;
      if (t > 1e-4 && t < tHit) {
        tHit = t;
        hitAxis = "y";
      }
    } else if (dy < -1e-8) {
      const t = (top - y) / dy;
      if (t > 1e-4 && t < tHit) {
        tHit = t;
        hitAxis = "y";
      }
    }

    if (!Number.isFinite(tHit) || tHit === Infinity) break;

    const remaining = length - traveled;
    const step = Math.min(tHit, remaining);
    x += dx * step;
    y += dy * step;
    traveled += step;
    pts.push({ x, y });

    if (step < tHit - 1e-6) break; // reached needed length mid-segment

    // Reflect
    if (hitAxis === "x") dx *= -1;
    if (hitAxis === "y") dy *= -1;

    // Tiny push off the wall to avoid re-hitting same edge
    x += dx * 0.75;
    y += dy * 0.75;
  }

  return pts;
}

function pathLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return L;
}

/** Sample position + tangent angle (deg) at distance `d` along polyline */
function samplePath(pts, d) {
  if (pts.length < 2) {
    return { x: pts[0]?.x ?? 0, y: pts[0]?.y ?? 0, angle: 0 };
  }

  let left = d;
  for (let i = 1; i < pts.length; i++) {
    const x0 = pts[i - 1].x;
    const y0 = pts[i - 1].y;
    const x1 = pts[i].x;
    const y1 = pts[i].y;
    const seg = Math.hypot(x1 - x0, y1 - y0) || 1e-6;

    if (left <= seg) {
      const t = left / seg;
      return {
        x: x0 + (x1 - x0) * t,
        y: y0 + (y1 - y0) * t,
        angle: (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI,
      };
    }
    left -= seg;
  }

  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  return {
    x: b.x,
    y: b.y,
    angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
  };
}

/**
 * @param {{
 *   rayEl: HTMLElement,
 *   fieldEl: HTMLElement,
 *   ghostEl?: HTMLElement | null,
 *   phrase?: string,
 *   onAdvance?: (info: { length: number, char: string }) => void,
 * }} opts
 */
export function createTypewriterLine(opts) {
  const phrase = opts.phrase ?? LOOP_PHRASE;
  const rayEl = opts.rayEl;
  const fieldEl = opts.fieldEl;
  const ghostEl = opts.ghostEl ?? null;
  const onAdvance = opts.onAdvance;

  let typed = "";
  let phraseIndex = 0;

  /** @type {HTMLSpanElement[]} */
  const glyphs = [];
  /** @type {{ x: number, y: number, angle: number }[]} */
  const glyphPose = [];
  /** @type {{ x: number, y: number, angle: number } | null} */
  let cursorPose = null;
  /** @type {Map<string, number>} */
  const widthCache = new Map();

  /** 0 = calm, 1 = max zoom → max shake & size */
  let zoomProgress = 0;

  const FX = {
    /** max translate jitter in px at full zoom */
    shake: 4,
    /** max extra rotation jitter in deg */
    twist: 3,
    /** max scale boost (1.28 = +28%) */
    scaleBoost: 0.28,
  };

  function setZoomProgress(t) {
    zoomProgress = Math.min(1, Math.max(0, t));
  }

  function paintGlyphs() {
    if (!glyphs.length) return;

    const p = zoomProgress;
    // Stronger ramp near the end of the zoom
    const intensity = p * p;
    const shake = intensity * FX.shake;
    const twist = intensity * FX.twist;
    const scale = 1 + p * FX.scaleBoost;

    for (let i = 0; i < glyphs.length; i++) {
      const pose = glyphPose[i];
      const g = glyphs[i];
      if (!pose || !g) continue;

      const sx = (Math.random() - 0.5) * 2 * shake;
      const sy = (Math.random() - 0.5) * 2 * shake;
      const rj = (Math.random() - 0.5) * 2 * twist;

      g.style.transform = `translate(${pose.x + sx}px, ${pose.y + sy}px) rotate(${pose.angle + rj}deg) translate(-50%, -50%) scale(${scale})`;
    }

    const cursor = rayEl.querySelector(".chat-ray__cursor");
    if (cursor && cursorPose) {
      const sx = (Math.random() - 0.5) * shake;
      const sy = (Math.random() - 0.5) * shake;
      cursor.style.transform = `translate(${cursorPose.x + sx}px, ${cursorPose.y + sy}px) rotate(${cursorPose.angle}deg) translate(-50%, -50%) scale(${scale})`;
    }
  }

  function update() {
    if (typed.length === 0) return;
    paintGlyphs();
  }

  function measureCharWidth(ch) {
    const key = ch === " " ? " " : ch;
    if (widthCache.has(key)) return widthCache.get(key);

    const probe = document.createElement("span");
    probe.className = "chat-ray__glyph";
    probe.textContent = ch === " " ? "\u00a0" : ch;
    probe.style.visibility = "hidden";
    probe.style.position = "absolute";
    probe.style.transform = "none";
    rayEl.appendChild(probe);
    const w = probe.getBoundingClientRect().width || 10;
    probe.remove();
    widthCache.set(key, Math.max(w, 4));
    return widthCache.get(key);
  }

  function getBounds() {
    const pad = 18;
    return {
      left: pad,
      right: window.innerWidth - pad,
      top: pad + 56,
      bottom: window.innerHeight - pad - 52,
    };
  }

  function getStartAndDir() {
    const rect = fieldEl.getBoundingClientRect();
    const prompt = fieldEl.querySelector(".chat-line__prompt");
    const promptRect = prompt?.getBoundingClientRect();
    // Start just after the ">" prompt, inside the field — then spill sideways
    const startX = promptRect
      ? promptRect.right + 10
      : rect.left + 36;
    const startY = rect.top + rect.height * 0.55;
    const dirX = 1;
    const dirY = -0.22;
    return { startX, startY, dirX, dirY };
  }

  function ensureGlyphs() {
    while (glyphs.length < typed.length) {
      const i = glyphs.length;
      const span = document.createElement("span");
      span.className = "chat-ray__glyph";
      const ch = typed[i];
      span.textContent = ch === " " ? "\u00a0" : ch;
      rayEl.appendChild(span);
      glyphs.push(span);
    }
    while (glyphs.length > typed.length) {
      const span = glyphs.pop();
      span?.remove();
    }
  }

  function layout() {
    ensureGlyphs();
    if (ghostEl) ghostEl.hidden = typed.length > 0;

    if (typed.length === 0) {
      rayEl.replaceChildren();
      glyphs.length = 0;
      glyphPose.length = 0;
      cursorPose = null;
      return;
    }

    const widths = [];
    let total = 0;
    const tracking = 3.5; // extra gap between glyphs along the ray
    for (let i = 0; i < typed.length; i++) {
      const w = measureCharWidth(typed[i]) + tracking;
      widths.push(w);
      total += w;
    }
    // cursor width
    const cursorW = 10;
    total += cursorW + 4;

    const { startX, startY, dirX, dirY } = getStartAndDir();
    const bounds = getBounds();
    let pts = buildReflectPath(startX, startY, dirX, dirY, total + 40, bounds);

    // If path came up short (degenerate), rebuild with steeper angle
    if (pathLength(pts) < total * 0.9) {
      pts = buildReflectPath(startX, startY, 1, -0.55, total + 80, bounds);
    }

    glyphPose.length = 0;
    let dist = 0;
    for (let i = 0; i < typed.length; i++) {
      const sample = samplePath(pts, dist + widths[i] * 0.5);
      glyphPose.push({
        x: sample.x,
        y: sample.y,
        angle: sample.angle,
      });
      dist += widths[i];
    }

    // Cursor at end of ray
    let cursor = rayEl.querySelector(".chat-ray__cursor");
    if (!cursor) {
      cursor = document.createElement("span");
      cursor.className = "chat-ray__cursor";
      rayEl.appendChild(cursor);
    }
    const cSample = samplePath(pts, dist + cursorW * 0.5);
    cursorPose = { x: cSample.x, y: cSample.y, angle: cSample.angle };

    paintGlyphs();
  }

  function advance() {
    const char = phrase[phraseIndex % phrase.length];
    typed += char;
    phraseIndex += 1;
    layout();
    onAdvance?.({ length: typed.length, char });
  }

  function onKeyDown(event) {
    if (event.repeat) return;
    if (!isChatKey(event)) return;
    if (event.target instanceof Element) {
      const tag = event.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") return;
    }
    advance();
    event.preventDefault();
  }

  function onResize() {
    layout();
  }

  function attach(target = window) {
    target.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    layout();
    return () => {
      target.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }

  return {
    attach,
    advance,
    getText: () => typed,
    relayout: layout,
    setZoomProgress,
    update,
  };
}
