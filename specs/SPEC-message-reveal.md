# SPEC — Message Reveal Rework

## Status: IMPLEMENTED

## Motivation

The existing `showMessage()` implementation is a brightness-only overlay. The glyphs in the
message region stay random throughout; the text is "readable" only as a brightness difference,
not as actual characters. There is no per-cell choreography — the entire letter area reacts
simultaneously when the wave passes. This spec replaces that system with one where:

1. Glyphs actually resolve to the correct target characters.
2. Cells within a letter settle at individually staggered times (organic crystallization).
3. Multiple cascade shapes are available (horizontal wave, radial burst, column-native).
4. The canvas texture is 4× smaller, uses bilinear filtering for soft edges, and encodes
   glyph identity in the G channel.

---

## Scope

### Files changed
- `matrix-rain-tsl.js` — new uniforms + attribute; replace message reveal block; replace
  glyphIdx selection block
- `matrix-rain-webgpu.js` — `renderMessageToTexture` rework; new `aColMsgGlyph` attribute;
  state machine; `showMessage()` API; new `uMsg*` uniforms
- `matrix-3d.html` — new cascade-mode selector, settle sharpness slider, column-mode warning

### Files NOT changed
- `matrix-rain-passes-tsl.js`
- `matrix-rain-presets.js`

---

## Cascade modes

Three modes controlled by `opts.cascadeMode` on `showMessage()`.

| `cascadeMode` | `uMsgCascadeMode` | Trigger | Glyph source |
|---|---|---|---|
| `'wave'` (default) | 0.0 | `uMsgWaveX` sweeps screen UV X 0→1 | texture G channel |
| `'radial'` | 1.0 | `uMsgWaveR` sweeps radial UV distance 0→~1.5 from `uMsgCenter` | texture G channel |
| `'column'` | 2.0 | `uMsgWaveX` sweeps normalized world X of columns left→right | `aColMsgGlyph` attribute |

`'wave'` and `'radial'` are **screen-space** modes. The dual-channel canvas texture drives both
the mask and target glyph identity. `'column'` is **3D-space** mode; the CPU projects the
message onto rain columns at `showMessage()` time and writes per-column glyph indices into
`aColMsgGlyph`.

---

## Part 1 — Texture format upgrade

### Resolution

Current: canvas rendered at full renderer resolution (W × H). New: render at **W/4 × H/4**
(clamped to min 64×32). THREE.js bilinear filtering on the upsampled texture gives natural
soft edges at letter boundaries — no explicit blur pass needed. Font size scales accordingly.

### Dual-channel encoding

| Channel | Content | Rendered how |
|---|---|---|
| R | Soft mask: ~1 inside letters, ~0 outside | Normal `fillText` (white on black), benefiting from sub-pixel AA and downscale softness |
| G | Per-character target glyph index: `glyphIdx / 255` | Solid filled rect per character, no AA, exact discrete value |

The G channel uses `floor(G_float * 255 + 0.5)` to decode. Zero = "no target glyph" (outside
any character cell, or unmapped character). Valid range: 1–254 (glyphIdx 0–253), so glyphIdx
is encoded as `glyphIdx + 1`. Any charset with ≤ 253 glyphs is supported (all current sets
have ≤ 95 glyphs).

### Rendering procedure (`renderMessageToTexture` — new implementation)

```js
function renderMessageToTexture(text, rendererW, rendererH, opts, charSet) {
  const SCALE = 0.25;
  const w = Math.max(64, Math.round(rendererW * SCALE));
  const h = Math.max(32, Math.round(rendererH * SCALE));
  const scaledFont = opts.font.replace(/(\d+)px/, (_, px) => `${Math.max(8, Math.round(px * SCALE))}px`);

  // ── Pass 1: mask (R channel) ──
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w; maskCanvas.height = h;
  const mCtx = maskCanvas.getContext('2d');
  mCtx.fillStyle = 'black';
  mCtx.fillRect(0, 0, w, h);
  mCtx.fillStyle = 'white';
  mCtx.font = scaledFont;
  mCtx.textAlign = opts.align ?? 'center';
  mCtx.textBaseline = 'middle';
  const mx = opts.align === 'center' ? w / 2 : opts.align === 'left' ? (opts.padding ?? 12) * SCALE : w - (opts.padding ?? 12) * SCALE;
  mCtx.fillText(text, mx, h * (opts.yFrac ?? 0.5));
  const maskData = mCtx.getImageData(0, 0, w, h);

  // ── Pass 2: glyph index (G channel) ──
  const idxCanvas = document.createElement('canvas');
  idxCanvas.width = w; idxCanvas.height = h;
  const iCtx = idxCanvas.getContext('2d');
  iCtx.fillStyle = 'black';
  iCtx.fillRect(0, 0, w, h);
  // Measure character advance widths for per-character rect placement
  iCtx.font = scaledFont;
  iCtx.textAlign = 'left';
  iCtx.textBaseline = 'middle';
  const charAdvances = [];
  let totalWidth = 0;
  for (const ch of text) {
    const adv = iCtx.measureText(ch).width;
    charAdvances.push(adv);
    totalWidth += adv;
  }
  // Compute start X relative to alignment
  let charX = opts.align === 'center' ? mx - totalWidth / 2
            : opts.align === 'left'   ? mx
            :                           mx - totalWidth;
  const yFrac = opts.yFrac ?? 0.5;
  for (let ci = 0; ci < text.length; ci++) {
    const gi = charToGlyphIdx(text[ci], charSet);  // -1 if unmapped
    if (gi >= 0) {
      // Encode as (glyphIdx + 1) in 0–255; store in G, all others 0
      const encoded = Math.round(((gi + 1) / 255) * 255);  // = gi + 1
      iCtx.fillStyle = `rgb(0,${encoded},0)`;
      iCtx.fillRect(charX, 0, charAdvances[ci], h);
    }
    charX += charAdvances[ci];
  }
  const idxData = iCtx.getImageData(0, 0, w, h);

  // ── Combine R + G manually ──
  const combined = document.createElement('canvas');
  combined.width = w; combined.height = h;
  const cCtx = combined.getContext('2d');
  const out   = cCtx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    out.data[i*4 + 0] = maskData.data[i*4 + 0]; // R = mask
    out.data[i*4 + 1] = idxData.data[i*4 + 1];  // G = glyph index
    out.data[i*4 + 2] = 0;
    out.data[i*4 + 3] = 255;
  }
  cCtx.putImageData(out, 0, 0);

  const tex = new THREE.CanvasTexture(combined);
  tex.needsUpdate = true;
  return tex;
}
```

### Character-to-glyph-index mapping (`charToGlyphIdx`)

```js
function charToGlyphIdx(char, charSet) {
  const c = char.toUpperCase();
  const code = c.charCodeAt(0);
  switch (charSet) {
    case 'ascii':
    case 'iosevka':
    case 'gsanscode':
      // Printable ASCII: space(32) → index 0, through '~'(126) → index 94
      if (code >= 32 && code <= 126) return code - 32;
      return -1;
    case 'latin':
    case 'datatype':
    case 'orbitron':
      // A–Z → 0–25, 0–9 → 26–35
      if (code >= 65 && code <= 90) return code - 65;
      if (code >= 48 && code <= 57) return code - 48 + 26;
      return -1;
    case 'matrixcode':
    case 'matrix1999':
    case 'japanese':
    case 'chinese':
    case 'cyrillic':
    default:
      // No ASCII-to-glyph mapping available
      return -1;
  }
}
```

**Graceful degradation**: `-1` means the G channel for that character is left at 0 ("no
target"). Those cells scramble fast but never resolve to a specific character — still better
than the old system since they benefit from settle stagger and the brightness boost.

---

## Part 2 — New uniforms

Add to `makeUniforms()`:

```js
uMsgWaveR:          uniform(0.0),              // radial wave front (screen UV distance, 0→~1.5)
uMsgCenter:         uniform(new THREE.Vector2(0.5, 0.5)), // message centre in screen UV
uMsgSettleSharpness: uniform(4.0),             // settle speed: higher = faster per-cell crystallise
uMsgCascadeMode:    uniform(0.0),              // 0=wave, 1=radial, 2=column
uMsgWorldXMin:      uniform(-8.0),             // min world X for column cascade ordering
uMsgWorldXMax:      uniform(8.0),              // max world X for column cascade ordering
```

Existing uniforms retained:
- `uMsgTex` — reused; now dual-channel at 1/4 resolution
- `uMsgRevealProgress` — retained
- `uMsgWaveX` — retained (wave + column mode wave front)
- `uMsgBoost` — retained (reduce default from 3.0 to 2.0)

Add to the `buildGlyphMaterial` destructuring line.

---

## Part 3 — New per-instance attribute

### `aColMsgGlyph` (column mode only)

```js
// After frustumVisAttr setup in initMatrixRain():
const colMsgGlyphData = new Float32Array(mesh.geometry.instanceCount).fill(0);
const colMsgGlyphAttr = new THREE.InstancedBufferAttribute(colMsgGlyphData, 1);
mesh.geometry.setAttribute('aColMsgGlyph', colMsgGlyphAttr);
```

**Encoding**: `0.0` = no target; `(glyphIdx + 1) / 256.0` = target glyph at atlas index
`glyphIdx` (range 0–254). This uses a sentinel of 0 to mean "no target", allowing
the shader to detect and skip unmapped columns cleanly.

Add in `rebuildGeom()` same as `aFrustumVis` — fresh array on every geometry rebuild.

In `matrix-rain-tsl.js` attribute declarations:
```js
const aColMsgGlyphAttr = attribute('aColMsgGlyph', 'float');
```

---

## Part 3b — New varying for column cascade (`matrix-rain-tsl.js`)

Column mode needs the column's world X centre per-fragment, as a stable constant across all
fragments of the same instance. `vWorldPos.x` cannot be used here: it holds the full vertex
world position of the quad corner, which varies by ±(cellWidth × scale / 2) ≈ ±0.15 wu
across the quad face. That jitter would produce per-fragment variation in `colPhase`, making
the cascade front visibly ragged at instance granularity.

Instead, carry the column centre X as a dedicated varying assigned from the per-instance
attribute in the vertex stage.

**Add to the varyings block** (after `vDeathFade`):
```js
const vColCenterX = varying(float(), 'vColCenterX');
```

**Add to the unconditional varying defaults** (alongside the other default assignments):
```js
vColCenterX.assign(0.0);
```

**Add inside the density-pass / boot-fade placement block** (alongside `vWorldPos.assign`):
```js
vColCenterX.assign(aColAAttr.x.add(uColumnOffset.x));
```

`aColAAttr.x` is the baked world X of this column; adding `uColumnOffset.x` makes it
camera-follow-aware, consistent with how `aWX` is computed in the vertex stage.

---

## Part 4 — Shader changes (`matrix-rain-tsl.js`)

### 4a. Message reveal block (replaces lines 459–467)

Replace the existing 9-line scramble block with:

```js
// ── Message reveal ─────────────────────────────────────────────────────
// Cascade front — wave mode uses screen UV X; radial uses distance from uMsgCenter.
// Column mode reuses uMsgWaveX but compares against world X normalized across the shell.
const radialDist  = length(screenUV.sub(uMsgCenter));
// vColCenterX carries the column's baked world X centre (constant across the quad face).
// Using vWorldPos.x would introduce ±cellWidth quad-edge jitter in colPhase.
const colPhase    = clamp(vColCenterX.sub(uMsgWorldXMin).div(uMsgWorldXMax.sub(uMsgWorldXMin)), 0.0, 1.0);

// wavePast: 1 where the cascade front has passed this fragment
const wavePastW   = step(screenUV.x, uMsgWaveX);
const wavePastR   = step(radialDist, uMsgWaveR);
const wavePastC   = step(colPhase, uMsgWaveX);
const isRadial    = uMsgCascadeMode.greaterThanEqual(float(0.5)).and(uMsgCascadeMode.lessThan(float(1.5)));
const isColumn    = uMsgCascadeMode.greaterThanEqual(float(1.5));
const wavePast    = select(isColumn, wavePastC, select(isRadial, wavePastR, wavePastW));

// waveGap: normalised distance the front has moved past this fragment (0 = just passed, 1 = far past)
const waveGapW    = uMsgWaveX.sub(screenUV.x);
const waveGapR    = uMsgWaveR.sub(radialDist);
const waveGapC    = uMsgWaveX.sub(colPhase);
const waveGapRaw  = select(isColumn, waveGapC, select(isRadial, waveGapR, waveGapW));
const waveGap01   = clamp(waveGapRaw.mul(uMsgSettleSharpness), 0.0, 1.0);

// Per-cell settle stagger — each cell crystallises at a slightly different time
const settleDelay = h2(cellId.mul(0.53).add(vec2(0.7, 0.3)));  // [0, 1]
const settleAmt   = smoothstep(
  settleDelay.mul(0.4),
  settleDelay.mul(0.4).add(0.15),
  waveGap01
).mul(uMsgRevealProgress);

// Mask — soft from downscale + bilinear filtering; threshold for screen modes
const msgMaskSoft = uMsgTex.r;
const msgMaskThr  = smoothstep(float(0.15), float(0.45), msgMaskSoft);
// Column mode mask: column has a valid target glyph (aColMsgGlyph > 0)
const colHasTarget = aColMsgGlyphAttr.greaterThan(float(0.001));
const msgMask     = select(isColumn, select(colHasTarget, float(1.0), float(0.0)), msgMaskThr);

// msgActive: drives scramble boost and brightness boost
const msgActive   = msgMask.mul(wavePast).mul(uMsgRevealProgress);

// Scramble boost — fast where wave passed but cell hasn't settled yet
const stillScrambling = msgActive.mul(float(1.0).sub(settleAmt));
const msgHoldSec  = mix(holdSec, float(0.05), stillScrambling);
// settledHold replaces the existing settledHold line
```

The variable `msgHoldSec` replaces the existing `settledHold` below. The subsequent
`changeTick` computation is **unchanged** — it just reads `msgHoldSec` instead of
`settledHold` (rename at that call site).

### 4b. Target glyph decode and glyphIdx selection (replaces lines 488–492)

Replace the existing 5-line `glyphIdx` select block with:

```js
// ── Target glyph resolution ────────────────────────────────────────────
// Screen modes: decode G channel → raw atlas index (0 = no target)
const rawGScreen  = floor(uMsgTex.g.mul(255.0).add(0.5));    // 0 = none, 1–255 = glyphIdx+1
const targetGScr  = rawGScreen.sub(1.0);                     // -1 = none, 0–254 = valid

// Column mode: decode aColMsgGlyph attribute
const rawGCol     = floor(aColMsgGlyphAttr.mul(256.0).add(0.5)); // 0 = none, 1–255 = glyphIdx+1
const targetGCol  = rawGCol.sub(1.0);                           // -1 = none, 0–254 = valid

// Select target source by cascade mode
const targetGlyph = select(isColumn, targetGCol, targetGScr);
const hasTarget   = targetGlyph.greaterThanEqual(float(0.0));

// Probabilistic resolve: coin flip per cell per changeTick.
// When settleAmt > coin value, use target glyph (if available).
const glyphCoin   = h2(cellId.mul(0.71).add(changeTick.mul(vec2(0.03, 0.05))));
const useTarget   = glyphCoin.lessThan(settleAmt).and(hasTarget);

// Final glyph selection
const baseOrMut   = select(
  isDeepTrail.or(stability.lessThan(uStability)),
  baseGlyph,
  mutGlyph,
);
const glyphIdx    = select(
  useTarget,
  clamp(targetGlyph, float(0.0), uGlyphCount.sub(1.0)),
  baseOrMut,
);
```

### 4c. Brightness boost line (line 537 — unchanged except msgActive already computed)

The existing line:
```js
col2.mulAssign(float(1.0).add(msgActive.mul(uMsgBoost.sub(1.0))));
```
Remains unchanged. `msgActive` is now computed in the new block above.

---

## Part 5 — JS changes (`matrix-rain-webgpu.js`)

### 5a. Column projection helper

```js
/**
 * Project the message text onto rain columns, writing per-column target glyph indices.
 * Call on showMessage() when cascadeMode === 'column'.
 *
 * @param {string}   text
 * @param {string}   charSet
 * @param {string}   font       CSS font at full renderer size
 * @param {string}   align
 * @param {number}   yFrac
 * @param {number}   padding
 * @param {object}   camera     THREE.PerspectiveCamera
 * @param {object}   columnOffset  THREE.Vector2
 * @param {object}   aColA      geometry attribute (wx,wz,speed,seed per instance; nCols*N_ROWS entries)
 * @param {object}   attrOut    aColMsgGlyph Float32Array to write into
 */
function projectMessageOntoColumns(text, charSet, font, align, yFrac, padding,
                                   camera, columnOffset, aColA, attrOut, nCols, nRows,
                                   rendererW, rendererH) {
  // Measure character bounding boxes using a temporary canvas at renderer resolution
  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width  = rendererW;
  tmpCanvas.height = rendererH;
  const tCtx = tmpCanvas.getContext('2d');
  tCtx.font = font;

  let totalWidth = 0;
  const advances = [];
  for (const ch of text) {
    const adv = tCtx.measureText(ch).width;
    advances.push(adv);
    totalWidth += adv;
  }
  const originX = align === 'center' ? rendererW / 2 - totalWidth / 2
                : align === 'left'   ? padding
                :                      rendererW - padding - totalWidth;
  const originY = yFrac * rendererH;

  // Estimate text height from font size string (e.g. 'bold 80px monospace' → 80)
  const fontSizeMatch = font.match(/(\d+)px/);
  const fontSize = fontSizeMatch ? parseFloat(fontSizeMatch[1]) : 64;
  const halfH = fontSize * 0.6;                       // rough half-height of capital letter

  // Build array of character rects in pixel coords
  const charRects = [];
  let cx = originX;
  for (let i = 0; i < text.length; i++) {
    charRects.push({ x0: cx, x1: cx + advances[i], gi: charToGlyphIdx(text[i], charSet) });
    cx += advances[i];
  }

  // Project each column's world XZ to screen UV
  const proj    = new THREE.Vector4();
  const worldPt = new THREE.Vector3();
  camera.updateMatrixWorld();
  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

  attrOut.fill(0);  // default: no target

  const colAArr = aColA.array;   // Float32Array, itemSize=4: wx, wz, speed, seed per instance
  for (let c = 0; c < nCols; c++) {
    const base4 = c * nRows * 4;
    const wx = colAArr[base4    ] + columnOffset.x;
    const wz = colAArr[base4 + 1] + columnOffset.y;

    // Project column centre to clip space, then screen UV
    worldPt.set(wx, 0, wz);
    proj.set(worldPt.x, worldPt.y, worldPt.z, 1.0).applyMatrix4(vp);
    if (proj.w <= 0) continue;  // behind camera
    const screenX = ((proj.x / proj.w) * 0.5 + 0.5) * rendererW;
    const screenY = ((proj.y / proj.w) * -0.5 + 0.5) * rendererH;

    // Check vertical overlap with message band
    if (screenY < originY - halfH || screenY > originY + halfH) continue;

    // Find which character this column falls inside
    for (const rect of charRects) {
      if (screenX >= rect.x0 && screenX < rect.x1 && rect.gi >= 0) {
        const encoded = (rect.gi + 1) / 256;  // (glyphIdx+1)/256 in [0,1]
        const base = c * nRows;
        attrOut.fill(encoded, base, base + nRows);
        break;
      }
    }
  }
}
```

Also compute `uMsgWorldXMin` / `uMsgWorldXMax` once on `showMessage()` for column mode:
```js
// Compute world X range across all columns for cascade ordering
let xMin = Infinity, xMax = -Infinity;
for (let c = 0; c < nCols; c++) {
  const wx = aColAArr[c * nRows * 4] + _columnOffset.x;
  xMin = Math.min(xMin, wx);
  xMax = Math.max(xMax, wx);
}
uniforms.uMsgWorldXMin.value = xMin;
uniforms.uMsgWorldXMax.value = xMax;
```

### 5b. State machine update

The 4-state FSM (idle → revealing → holding → fading) is unchanged structurally. One cleanup:
replace the dual-purpose `msgHoldEnd` variable with two separate ones:

```js
let msgState       = 'idle';
let msgRevealSpeed = 0;
let msgHoldDuration = 0;   // holds the hold duration in seconds (replaces dual-purpose msgHoldEnd)
let msgHoldEnd     = 0;    // absolute timestamp when hold ends (set when entering 'holding')
let msgFadeSpeed   = 0;
let msgTex         = null;
let msgCascadeMode = 0;    // mirror of uMsgCascadeMode.value for tick() branching
```

In `tick()`, update the radial wave front alongside the horizontal one:
```js
if (msgState === 'revealing') {
  if (msgCascadeMode === 1) {   // radial
    uniforms.uMsgWaveR.value = Math.min(1.6, uniforms.uMsgWaveR.value + msgRevealSpeed * dt);
    uniforms.uMsgRevealProgress.value = 1.0;
    if (uniforms.uMsgWaveR.value >= 1.6) { msgState = 'holding'; msgHoldEnd = t + msgHoldDuration; }
  } else {                      // wave or column
    uniforms.uMsgWaveX.value = Math.min(1.0, uniforms.uMsgWaveX.value + msgRevealSpeed * dt);
    uniforms.uMsgRevealProgress.value = 1.0;
    if (uniforms.uMsgWaveX.value >= 1.0) { msgState = 'holding'; msgHoldEnd = t + msgHoldDuration; }
  }
} else if (msgState === 'holding') {
  if (t >= msgHoldEnd) msgState = 'fading';
} else if (msgState === 'fading') {
  uniforms.uMsgRevealProgress.value = Math.max(0, uniforms.uMsgRevealProgress.value - msgFadeSpeed * dt);
  if (uniforms.uMsgRevealProgress.value <= 0) {
    msgState = 'idle';
    uniforms.uMsgWaveX.value = 0.0;
    uniforms.uMsgWaveR.value = 0.0;
    if (msgTex) { try { msgTex.dispose(); } catch (_) {} msgTex = null; }
    uniforms.uMsgTex.value = dummyMsgTex;
    // Reset column mode attribute
    const attr = mesh.geometry.getAttribute('aColMsgGlyph');
    if (attr) { attr.array.fill(0); attr.needsUpdate = true; }
  }
}
```

### 5c. `showMessage()` updated signature

```js
/**
 * Display a message by resolving rain glyphs into the target characters.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.font]             CSS font at renderer height (default: 'bold {8%h}px monospace')
 * @param {string} [opts.align]            'left'|'center'|'right' (default: 'center')
 * @param {number} [opts.yFrac]            vertical centre 0–1 (default: 0.5)
 * @param {number} [opts.padding]          horizontal padding px (default: 48)
 * @param {string} [opts.cascadeMode]      'wave'|'radial'|'column' (default: 'wave')
 * @param {number} [opts.revealDuration]   seconds for cascade to complete (default: 1.5)
 * @param {number} [opts.holdDuration]     seconds to hold after reveal (default: 3.0)
 * @param {number} [opts.fadeDuration]     seconds to fade out (default: 1.0)
 * @param {number} [opts.boost]            brightness multiplier during active reveal (default: 2.0)
 * @param {number} [opts.settleSharpness]  how quickly per-cell crystallisation completes (default: 4.0)
 */
showMessage(text, opts = {}) {
  if (msgTex) { try { msgTex.dispose(); } catch (_) {} }
  const w = renderer.domElement.width  || element.clientWidth  || 512;
  const h = renderer.domElement.height || element.clientHeight || 512;
  const {
    font             = `bold ${Math.max(32, Math.round(h * 0.08))}px monospace`,
    align            = 'center',
    yFrac            = 0.5,
    padding          = 48,
    cascadeMode      = 'wave',
    revealDuration   = 1.5,
    holdDuration     = 3.0,
    fadeDuration     = 1.0,
    boost            = 2.0,
    settleSharpness  = 4.0,
  } = opts;

  const modeFloat = cascadeMode === 'radial' ? 1.0 : cascadeMode === 'column' ? 2.0 : 0.0;
  msgCascadeMode = modeFloat;
  uniforms.uMsgCascadeMode.value = modeFloat;
  uniforms.uMsgBoost.value       = boost;
  uniforms.uMsgSettleSharpness.value = settleSharpness;
  uniforms.uMsgCenter.value.set(
    align === 'center' ? 0.5 : align === 'left' ? 0.15 : 0.85,
    // CanvasTexture default flipY=true causes the GPU to see the canvas image flipped:
    // screenUV.y=0 (top of screen) maps to the bottom row of the canvas pixel buffer.
    // Canvas draws text at pixel y = h * yFrac (y=0 at top), so the GPU sees it at
    // screenUV.y = 1 - yFrac. Do NOT set flipY=false on the new texture or this breaks.
    1.0 - yFrac,
  );

  if (cascadeMode === 'column') {
    // Column mode: project onto rain columns; no canvas texture needed
    uniforms.uMsgTex.value = dummyMsgTex;
    const attr    = mesh.geometry.getAttribute('aColMsgGlyph');
    const colA    = mesh.geometry.getAttribute('aColA');
    if (attr && colA) {
      projectMessageOntoColumns(
        text, _activeCharSet, font, align, yFrac, padding,
        camera, _columnOffset, colA, attr.array,
        _geomParams.nCols, N_ROWS, w, h,
      );
      attr.needsUpdate = true;
    }
    // Compute world X range for cascade ordering
    const colAArr = colA?.array;
    if (colAArr) {
      let xMin = Infinity, xMax = -Infinity;
      for (let c = 0; c < _geomParams.nCols; c++) {
        const wx = colAArr[c * N_ROWS * 4] + _columnOffset.x;
        if (wx < xMin) xMin = wx;
        if (wx > xMax) xMax = wx;
      }
      uniforms.uMsgWorldXMin.value = xMin;
      uniforms.uMsgWorldXMax.value = xMax;
    }
  } else {
    // Screen mode: dual-channel canvas texture
    msgTex = renderMessageToTexture(text, w, h, { font, align, yFrac, padding }, _activeCharSet);
    uniforms.uMsgTex.value = msgTex;
  }

  uniforms.uMsgRevealProgress.value = 0.0;
  uniforms.uMsgWaveX.value  = 0.0;
  uniforms.uMsgWaveR.value  = 0.0;
  msgRevealSpeed   = 1.0 / revealDuration;
  msgHoldDuration  = holdDuration;
  msgFadeSpeed     = 1.0 / fadeDuration;
  msgState         = 'revealing';
}
```

**`_activeCharSet` wiring (required)**: The `opts` destructuring uses `const charSet = 'matrixcode'`
which is fixed for the lifetime of the closure. `setCharSet()` does not currently update it, so
calling `setCharSet('latin')` then `showMessage()` would silently use the wrong glyph mapping.

Fix — in `initMatrixRain`, immediately after the opts destructuring:
```js
let _activeCharSet = charSet;  // mutable; updated by setCharSet()
```

In `setCharSet()`, add one line after the descriptor lookup succeeds:
```js
_activeCharSet = name;
```

Both `showMessage()` call sites above already reference `_activeCharSet`.

---

## Part 6 — demo.html changes

### New controls in the Message sub-panel

Replace the existing `Boost` / `Reveal s` / `Hold s` / `Fade s` / `SHOW` / `CLEAR` layout with:

```html
<!-- Mode selector -->
<label>Cascade
  <select id="ctl-msg-cascade">
    <option value="wave" selected>wave →</option>
    <option value="radial">radial ◎</option>
    <option value="column">column ↓ 3D</option>
  </select>
</label>

<!-- Column mode warning (shown only when 'column' selected) -->
<p id="ctl-msg-col-warn"
   style="display:none;color:#ff8800;font-size:9px;margin:0;line-height:1.4;">
  ⚠ Column mode is view-dependent: the glyph mapping is computed once at click time
  from the current camera position. Moving the camera after clicking SHOW will
  misalign the text. Not compatible with active flythrough/orbit.
</p>

<label>Boost
  <span style="display:flex;align-items:center;gap:4px;">
    <input id="ctl-msg-boost"     type="range"  min="1" max="6"  step="0.1" value="2">
    <input id="ctl-msg-boost-num" type="number" min="1" max="6"  step="0.1" value="2">
  </span>
</label>

<label>Settle
  <span style="display:flex;align-items:center;gap:4px;">
    <input id="ctl-msg-settle"     type="range"  min="0.5" max="12" step="0.5" value="4">
    <input id="ctl-msg-settle-num" type="number" min="0.5" max="12" step="0.5" value="4">
  </span>
</label>

<label>Reveal s
  ... (unchanged IDs, same as before)

<!-- Wiring (in makeControls / inline after): -->
```

```js
// Cascade mode toggle — show warning for column mode
document.getElementById('ctl-msg-cascade').addEventListener('change', () => {
  const isCol = document.getElementById('ctl-msg-cascade').value === 'column';
  document.getElementById('ctl-msg-col-warn').style.display = isCol ? '' : 'none';
});

// SHOW wires in cascade mode + settle sharpness
document.getElementById('ctl-msg-show').addEventListener('click', () => {
  rain.showMessage(document.getElementById('ctl-msg-text').value, {
    cascadeMode:     document.getElementById('ctl-msg-cascade').value,
    boost:           parseFloat(document.getElementById('ctl-msg-boost').value),
    settleSharpness: parseFloat(document.getElementById('ctl-msg-settle').value),
    revealDuration:  parseFloat(document.getElementById('ctl-msg-reveal').value),
    holdDuration:    parseFloat(document.getElementById('ctl-msg-hold').value),
    fadeDuration:    parseFloat(document.getElementById('ctl-msg-fade').value),
  });
});

linkSlider('ctl-msg-boost',  'ctl-msg-boost-num',  () => {});
linkSlider('ctl-msg-settle', 'ctl-msg-settle-num', () => {});
// reveal / hold / fade sliders unchanged
```

---

## Edge cases

**Charset with no glyph mapping** (`matrixcode`, `matrix1999`, etc.): `charToGlyphIdx` returns
-1 for all characters. G channel stays 0. In screen modes, the scramble + settle stagger still
apply (improved over the old system) but cells never resolve to a specific character. Brightness
boost still indicates the text region. In column mode, no columns get a target, so the effect
is identical to screen/wave mode without glyph forcing.

**Renderer resize during reveal**: Screen modes render the canvas texture once at the time of
`showMessage()`. Resize will distort the texture mapping. This is unchanged from the current
implementation and is acceptable — call `showMessage()` again to re-render at the new size.

**Camera movement during column mode reveal**: The `aColMsgGlyph` attribute is computed once
at `showMessage()` time. Orbiting or flying after the click will move the column centres
relative to where the text was projected, causing visual drift. This is documented in the UI
warning.

**Column mode + column follow active**: `_columnOffset` may be non-zero. `projectMessageOntoColumns`
receives the current `_columnOffset` and accounts for it in the projection step. Correct at
the time of click; will drift if column follow continues updating after the message is shown.

**Column mode + geometry rebuild** (`setSpeedRange`, `setTrailRange`): `rebuildGeom()` will
reset `aColMsgGlyph` to all zeros (same pattern as `aFrustumVis`), clearing the message. If a
rebuild happens mid-reveal, the column mode message clears. The FSM continues advancing —
the fade-out on `uMsgRevealProgress` is unaffected. Screen modes are unaffected by rebuilds.

**Radial wave radius max**: The wave front starts at `uMsgWaveR = 0` and needs to reach all
corners of the screen. The furthest corner from the centre in screen UV space is at distance
`sqrt(0.5² + 0.5²) ≈ 0.707`. Using 1.6 as the terminus gives a comfortable margin. The JS
tick checks `uMsgWaveR >= 1.6` to transition to 'holding'.

---

## Implementation steps

1. `matrix-rain-tsl.js`:
   - Add 6 new uniforms to `makeUniforms()` (§2)
   - Add all 6 new uniforms to `buildGlyphMaterial` destructuring (alongside the existing `uMsgTex`, `uMsgRevealProgress`, `uMsgWaveX`, `uMsgBoost` lines)
   - Add `aColMsgGlyphAttr` attribute declaration (§3)
   - Add `vColCenterX` varying declaration, default assignment, and placement assignment (§3b)
   - Replace the message reveal block (§4a) — keep surrounding code intact
   - Replace the `glyphIdx` select block (§4b)
   - Brightness boost line (§4c) — unchanged; `msgActive` is now computed in §4a

2. `matrix-rain-webgpu.js`:
   - Add `charToGlyphIdx` helper function (§1 texture section)
   - Rewrite `renderMessageToTexture` (§1 texture section)
   - Add `projectMessageOntoColumns` helper (§5a)
   - Add `colMsgGlyphAttr` allocation after `frustumVisAttr` setup (§3)
   - Update `rebuildGeom()` to re-attach `aColMsgGlyph` (§3)
   - Add `let _activeCharSet = charSet;` immediately after opts destructuring; add `_activeCharSet = name;` in `setCharSet()` (§5c note)
   - Update state machine closure variables (§5b)
   - Update `tick()` fading block (§5b)
   - Replace `showMessage()` body (§5c)

3. `matrix-3d.html`:
   - Add cascade mode `<select>` before boost (§6)
   - Add column mode warning paragraph (§6)
   - Add settle sharpness slider (§6)
   - Update `ctl-msg-show` click handler (§6)
   - Add cascade change listener for warning visibility (§6)
   - Update `linkSlider` calls for new slider
