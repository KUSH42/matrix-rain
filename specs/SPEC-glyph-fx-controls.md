# SPEC-glyph-fx-controls

**Status**: Approved
**Priority**: P1

---

## Motivation

Ten visual / animation features ported from the `../three` (WebGL) implementation are
already compiled into `matrix-rain-tsl.js` but every configurable value is a hardcoded
constant.  They cannot be toggled or tuned without editing shader source.  This spec adds
uniforms, handle methods, and demo-panel controls for all ten:

| Feature | Current state |
|---|---|
| Drip stretch | `0.35` hardcoded amplitude |
| Edge emission glow | `0.4` hardcoded intensity |
| Per-column Z-rotation | `0.1745` rad (5°) hardcoded max |
| Film grain | `0.07` hardcoded strength |
| Atmospheric depth tint | `0.4` hardcoded blend |
| Startup cascade | always runs, 2.5 s ceiling hardcoded |
| Glyph stability fraction | `0.30` hardcoded |
| Hold-cycle duration multiplier | `10 s` ceiling hardcoded; no global scale |
| Burst glyph-change rate | `12 Hz` hardcoded during burst |
| Depth-adaptive POM LOD | `uPomSteps` already uniform; no demo control |

Globe occlusion: out of scope (not yet implemented, not requested).

---

## Baseline

All ten effects live in `matrix-rain-tsl.js` inside `buildGlyphMaterial()`.
Uniforms are declared in `makeUniforms()` and destructured at the top of
`buildGlyphMaterial()`.  All new uniforms follow the same pattern.

Handle methods live in `initMatrixRain()` in `matrix-rain-webgpu.js`.
Controls live in `demo.html`.

---

## New Uniforms  (`matrix-rain-tsl.js` → `makeUniforms()`)

All 11 must be added.  9 are for main controls; 2 are for the debug `<details>` block
(documented fully in the Debug-only controls section below).

```js
// Main controls
uDripAmt:       uniform(0.35),   // drip-stretch Y-scale amplitude  0–0.8
uEdgeGlow:      uniform(0.4),    // edge-emission corona intensity   0–1.5
uZRotRange:     uniform(0.1745), // per-column Z-rotation max angle  0–0.524 rad (0–30°)
uGrainAmt:      uniform(0.07),   // film-grain strength              0–0.25
uDepthTintAmt:  uniform(0.4),    // atmospheric depth-tint blend     0–1
uBootEnabled:   uniform(1.0),    // startup cascade on/off           0 or 1
uStability:     uniform(0.30),   // fraction of stable cells         0–1
uHoldMult:      uniform(1.0),    // hold-cycle duration multiplier   0.1–5
uBurstGlyphRate:uniform(12.0),   // glyph-change rate during burst   1–30 Hz
// Debug controls
uHueRange:      uniform(0.14),   // per-column hue rotation max, rad — 0.14 ≈ ±8°
uBurstProb:     uniform(0.005),  // fraction of columns that burst per 4 s cycle
```

`uPomSteps` already exists (`uniform(6)`); it just needs a demo control and handle method.

---

## Shader changes  (`matrix-rain-tsl.js`)

Each change is a **minimal one-line substitution** of a hardcoded literal with the new
uniform.  No structural change to control flow.

### 1. Drip stretch  (vertex stage, `dripStretch` block)

```js
// Before
const dripStretch = float(1).add(
  float(0.35).mul(exp(max(dist, 0.0).negate().mul(1.5)))
);
// After
const dripStretch = float(1).add(
  uDripAmt.mul(exp(max(dist, 0.0).negate().mul(1.5)))
);
```

Disable path: `uDripAmt = 0` → `dripStretch = 1.0` (no stretch).

---

### 2. Edge emission glow  (fragment stage)

```js
// Before
const edgeGlow = exp(edgeDist.negate().mul(18.0)).mul(0.4);
// After
const edgeGlow = exp(edgeDist.negate().mul(18.0)).mul(uEdgeGlow);
```

Disable path: `uEdgeGlow = 0`.

---

### 3. Per-column Z-rotation  (vertex stage, `rotAngle` line)

```js
// Before
const rotAngle = h2(vec2(aSeed, 42.0)).sub(0.5).mul(0.1745);
// After
const rotAngle = h2(vec2(aSeed, 42.0)).sub(0.5).mul(uZRotRange);
```

`uZRotRange = 0` → all columns aligned (no roll).
Max useful value ≈ 0.524 rad (30°); beyond that quads look misaligned.

---

### 4. Film grain  (fragment stage)

```js
// Before
const grain = h2(…).sub(0.5).mul(0.07);
// After
const grain = h2(…).sub(0.5).mul(uGrainAmt);
```

Disable path: `uGrainAmt = 0`.

---

### 5. Atmospheric depth tint  (fragment stage)

```js
// Before
col2.assign(mix(col2, col2.mul(vec3(0.6, 0.85, 1.1)), depthTint.mul(0.4)));
// After
col2.assign(mix(col2, col2.mul(vec3(0.6, 0.85, 1.1)), depthTint.mul(uDepthTintAmt)));
```

Disable path: `uDepthTintAmt = 0`.

---

### 6. Startup cascade  (vertex stage, `bootFadeVal` block)

```js
// Before
const bootDelay   = h2(vec2(aColIdxAttr.mul(0.31), 0.77)).mul(2.5);
const bootFadeVal = smoothstep(bootDelay, bootDelay.add(0.3), uTime);
vBootFade.assign(bootFadeVal);
// After
const bootDelay   = h2(vec2(aColIdxAttr.mul(0.31), 0.77)).mul(2.5);
const bootFadeRaw = smoothstep(bootDelay, bootDelay.add(0.3), uTime);
const bootFadeVal = mix(float(1), bootFadeRaw, uBootEnabled);
vBootFade.assign(bootFadeVal);
```

`uBootEnabled = 0` → all columns instantly visible (bootFade = 1).
`uBootEnabled = 1` → normal 2.5 s stagger.

`uBootEnabled` is intentionally a float (not bool) so it can be set after `renderer.init()`
without a shader recompile — WebGPU buffers treat it as a regular f32 uniform.

---

### 7. Glyph stability  (fragment stage, `glyphIdx` select)

```js
// Before
const glyphIdx = select(
  isDeepTrail.or(stability.lessThan(0.30)),
  baseGlyph,
  mutGlyph
);
// After
const glyphIdx = select(
  isDeepTrail.or(stability.lessThan(uStability)),
  baseGlyph,
  mutGlyph
);
```

`uStability = 0` → no cells are stable (all mutate freely).
`uStability = 1` → all cells are stable (glyphs never change).

---

### 8. Hold-cycle multiplier  (fragment stage, `holdSec` block)

```js
// Before
const holdSec = select(isHead,
  float(0.067),
  select(isNearHead,
    float(2.0).add(holdRand.mul(0.3)),
    float(10.0).add(holdRand.mul(2.0))
  )
);
// After — multiply base hold durations by uHoldMult
const holdSec = select(isHead,
  float(0.067),
  select(isNearHead,
    float(2.0).add(holdRand.mul(0.3)),
    float(10.0).add(holdRand.mul(2.0))
  )
).mul(uHoldMult);
```

Head zone (0.067 s) is intentionally **not** multiplied — it is a display-rate
constant (≈ 15 Hz), not a hold duration in the artistic sense.  Scaling it would
make the head look smeared or frozen rather than flickery.

`uHoldMult = 0.1` → glyphs change ~10× faster (near-cinematic scramble).
`uHoldMult = 5.0` → glyphs are nearly frozen except near head.

---

### 9. Burst glyph-change rate  (fragment stage, `burstOffset`)

```js
// Before
const burstOffset = select(
  vBurst.greaterThan(0.5), floor(uTime.mul(12.0)), float(0)
);
// After
const burstOffset = select(
  vBurst.greaterThan(0.5), floor(uTime.mul(uBurstGlyphRate)), float(0)
);
```

`uBurstGlyphRate = 1` → glyph rate during burst equals normal rate (no acceleration).
`uBurstGlyphRate = 30` → very fast scramble during burst.

---

### 10. POM step-count control  (fragment stage — no shader change needed)

`uPomSteps` is already used at line `int(max(uPomSteps.mul(pomLod), 3.0))`.
Only a handle method and demo control are missing.

---

## `buildGlyphMaterial()` destructure update

Add all eleven new uniforms (9 main + 2 debug) to the destructure block at the top of
`buildGlyphMaterial()`:

```js
const {
  …existing…,
  uDripAmt, uEdgeGlow, uZRotRange, uGrainAmt, uDepthTintAmt,
  uBootEnabled, uStability, uHoldMult, uBurstGlyphRate,
  uHueRange, uBurstProb,
} = uniforms;
```

---

## Handle methods  (`matrix-rain-webgpu.js`)

Twelve new methods total — 10 main (below) + 2 debug (`setHueRange`, `setBurstProb`,
specified in the Debug-only controls section).  All follow the same one-liner pattern as
existing scalar setters.

```js
setDrip(v)            { uniforms.uDripAmt.value       = v; },
setEdgeGlow(v)        { uniforms.uEdgeGlow.value       = v; },
setZRotation(deg)     { uniforms.uZRotRange.value      = deg * Math.PI / 180; },
setFilmGrain(v)       { uniforms.uGrainAmt.value       = v; },
setDepthTint(v)       { uniforms.uDepthTintAmt.value   = v; },
setStartupCascade(on) { uniforms.uBootEnabled.value    = on ? 1.0 : 0.0; },
setStability(v)       { uniforms.uStability.value      = v; },
setHoldMult(v)        { uniforms.uHoldMult.value       = v; },
setBurstGlyphRate(v)  { uniforms.uBurstGlyphRate.value = v; },
setPomSteps(v)        { uniforms.uPomSteps.value       = Math.max(3, Math.round(v)); },
```

`setZRotation` takes **degrees** to match user-facing controls; converts internally.

---

## Demo controls  (`demo.html`)

New **"Glyph FX"** sub-panel inserted after the existing "Organic" sub-panel,
using the same `border-top` divider pattern.

```html
<!-- Glyph FX sub-panel -->
<div style="border-top:1px solid #00ff7044;margin-top:4px;padding-top:4px;
            display:flex;flex-direction:column;gap:4px;">
  <label style="color:#7fffaa;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;">
    — Glyph FX —
  </label>

  <label>Drip stretch
    <span style="display:flex;align-items:center;gap:4px;">
      <input id="ctl-drip"     type="range"  min="0" max="0.8"  step="0.02"  value="0.35">
      <input id="ctl-drip-num" type="number" min="0" max="0.8"  step="0.02"  value="0.35">
    </span>
  </label>
  <label>Edge glow
    <span style="display:flex;align-items:center;gap:4px;">
      <input id="ctl-edge-glow"     type="range"  min="0" max="1.5"  step="0.05"  value="0.4">
      <input id="ctl-edge-glow-num" type="number" min="0" max="1.5"  step="0.05"  value="0.4">
    </span>
  </label>
  <label>Z-rotation °
    <span style="display:flex;align-items:center;gap:4px;">
      <input id="ctl-zrot"     type="range"  min="0" max="30"   step="1"     value="10">
      <input id="ctl-zrot-num" type="number" min="0" max="30"   step="1"     value="10">
    </span>
  </label>
  <label>Film grain
    <span style="display:flex;align-items:center;gap:4px;">
      <input id="ctl-grain"     type="range"  min="0" max="0.25" step="0.005" value="0.07">
      <input id="ctl-grain-num" type="number" min="0" max="0.25" step="0.005" value="0.07">
    </span>
  </label>
  <label>Depth tint
    <span style="display:flex;align-items:center;gap:4px;">
      <input id="ctl-depth-tint"     type="range"  min="0" max="1"   step="0.02"  value="0.4">
      <input id="ctl-depth-tint-num" type="number" min="0" max="1"   step="0.02"  value="0.4">
    </span>
  </label>
  <label>Startup cascade
    <input id="ctl-boot" type="checkbox" checked>
  </label>
  <label>Stability
    <span style="display:flex;align-items:center;gap:4px;">
      <input id="ctl-stability"     type="range"  min="0"   max="1"  step="0.02"  value="0.30">
      <input id="ctl-stability-num" type="number" min="0"   max="1"  step="0.02"  value="0.30">
    </span>
  </label>
  <label>Hold mult
    <span style="display:flex;align-items:center;gap:4px;">
      <input id="ctl-hold-mult"     type="range"  min="0.1" max="5"  step="0.1"   value="1.0">
      <input id="ctl-hold-mult-num" type="number" min="0.1" max="5"  step="0.1"   value="1.0">
    </span>
  </label>
  <label>Burst glyph rate
    <span style="display:flex;align-items:center;gap:4px;">
      <input id="ctl-burst-rate"     type="range"  min="1" max="30"  step="1"     value="12">
      <input id="ctl-burst-rate-num" type="number" min="1" max="30"  step="1"     value="12">
    </span>
  </label>
  <label>POM steps
    <span style="display:flex;align-items:center;gap:4px;">
      <input id="ctl-pom-steps"     type="range"  min="3" max="12"  step="1"     value="6">
      <input id="ctl-pom-steps-num" type="number" min="3" max="12"  step="1"     value="6">
    </span>
  </label>
</div>
```

**Bindings** — sliders use `linkSlider()` (see Slider numeric readout section);
the checkbox uses the existing `bind()` helper:

```js
linkSlider('ctl-drip',        'ctl-drip-num',        v => rain.setDrip(v));
linkSlider('ctl-edge-glow',   'ctl-edge-glow-num',   v => rain.setEdgeGlow(v));
linkSlider('ctl-zrot',        'ctl-zrot-num',        v => rain.setZRotation(v));
linkSlider('ctl-grain',       'ctl-grain-num',       v => rain.setFilmGrain(v));
linkSlider('ctl-depth-tint',  'ctl-depth-tint-num',  v => rain.setDepthTint(v));
bind(      'ctl-boot',                               on => rain.setStartupCascade(on));
linkSlider('ctl-stability',   'ctl-stability-num',   v => rain.setStability(v));
linkSlider('ctl-hold-mult',   'ctl-hold-mult-num',   v => rain.setHoldMult(v));
linkSlider('ctl-burst-rate',  'ctl-burst-rate-num',  v => rain.setBurstGlyphRate(v));
linkSlider('ctl-pom-steps',   'ctl-pom-steps-num',   v => rain.setPomSteps(v));
```

**Export / import** — add all twelve (10 main + 2 debug) to `collectSettings()` and
`applySettings()`.

The `set()` helper in `applySettings()` must also update the companion number input so
the readout stays in sync after import.  Update `set()` in-place:

```js
// Updated set() helper in applySettings() — also syncs companion number input
const set = (id, v) => {
  if (v === undefined) return;
  el(id).value = v;
  const numEl = document.getElementById(id + '-num');
  if (numEl) numEl.value = v;
};
```

```js
// collectSettings()
drip:          fv('ctl-drip'),
edgeGlow:      fv('ctl-edge-glow'),
zRot:          fv('ctl-zrot'),
filmGrain:     fv('ctl-grain'),
depthTint:     fv('ctl-depth-tint'),
boot:          cb('ctl-boot'),
stability:     fv('ctl-stability'),
holdMult:      fv('ctl-hold-mult'),
burstGlyphRate:fv('ctl-burst-rate'),
pomSteps:      fv('ctl-pom-steps'),
hueRange:      fv('ctl-hue-range'),
burstProb:     fv('ctl-burst-prob'),

// applySettings() — set() now auto-syncs *-num companions (see above)
set('ctl-drip',        s.drip);
set('ctl-edge-glow',   s.edgeGlow);
set('ctl-zrot',        s.zRot);
set('ctl-grain',       s.filmGrain);
set('ctl-depth-tint',  s.depthTint);
chk('ctl-boot',        s.boot);
set('ctl-stability',   s.stability);
set('ctl-hold-mult',   s.holdMult);
set('ctl-burst-rate',  s.burstGlyphRate);
set('ctl-pom-steps',   s.pomSteps);
set('ctl-hue-range',   s.hueRange);
set('ctl-burst-prob',  s.burstProb);
if (s.drip          !== undefined) rain.setDrip(s.drip);
if (s.edgeGlow      !== undefined) rain.setEdgeGlow(s.edgeGlow);
if (s.zRot          !== undefined) rain.setZRotation(s.zRot);
if (s.filmGrain     !== undefined) rain.setFilmGrain(s.filmGrain);
if (s.depthTint     !== undefined) rain.setDepthTint(s.depthTint);
if (s.boot          !== undefined) rain.setStartupCascade(s.boot);
if (s.stability     !== undefined) rain.setStability(s.stability);
if (s.holdMult      !== undefined) rain.setHoldMult(s.holdMult);
if (s.burstGlyphRate!== undefined) rain.setBurstGlyphRate(s.burstGlyphRate);
if (s.pomSteps      !== undefined) rain.setPomSteps(s.pomSteps);
if (s.hueRange      !== undefined) rain.setHueRange(s.hueRange);
if (s.burstProb     !== undefined) rain.setBurstProb(s.burstProb);
```

---

## CLAUDE.md / API table updates

Add 12 rows to the **Handle Methods** table in `CLAUDE.md`:

| Method | Description |
|---|---|
| `setDrip(v)` | Y-stretch amplitude at column head 0–0.8 (0 = off) |
| `setEdgeGlow(v)` | Edge-emission corona intensity 0–1.5 (0 = off) |
| `setZRotation(deg)` | Per-column panel tilt max angle 0–30° (0 = upright) |
| `setFilmGrain(v)` | Film-grain noise strength 0–0.25 (0 = off) |
| `setDepthTint(v)` | Atmospheric depth-tint blend 0–1 (0 = off) |
| `setStartupCascade(on)` | Boot stagger enable; false = instant on |
| `setStability(v)` | Fraction of cells locked to base glyph 0–1 |
| `setHoldMult(v)` | Hold-cycle duration multiplier 0.1–5 |
| `setBurstGlyphRate(v)` | Glyph-change rate during burst 1–30 Hz |
| `setPomSteps(n)` | POM ray-march step count 3–12 (default 6; clamped to min 3) |
| `setHueRange(deg)` | Per-column G-B hue rotation max 0–45° (default 8°) |
| `setBurstProb(v)` | Fraction of columns that burst per 4 s cycle 0–1 (default 0.005) |

---

## Edge cases

- **Z-rotation demo slider** shows degrees (0–30); `setZRotation` converts to radians.
  CLAUDE.md documents the method in degrees.
- **`uBootEnabled`** affects `vBootFade` which is also used in the `maxAlpha` early-discard
  test in the fragment shader.  When set to 0, all columns are immediately at full
  brightness — verify no fragment early-discard fires spuriously.
- **`uHoldMult`** multiplies the hold duration for near-head and mid/deep trail zones;
  head zone (0.067 s) is deliberately excluded to preserve the flickery head aesthetic.
- **`uStability = 1`** makes every cell use `baseGlyph`, which is a fixed hash per cell.
  The rain still visually scrolls (positions change), only glyph identities freeze.
- **`uBurstGlyphRate`** only affects fragments where `vBurst > 0.5`.  Approximately 0.5 %
  of columns burst at any time, so changing this value has a very subtle overall effect.
- **`setPomSteps`** — the demo slider min is 3, matching the `Math.max(3, …)` clamp in
  the handle method, so the slider and API are consistent.  Callers passing values below
  3 programmatically will be silently clamped to 3.

---

## Debug-only controls

Two parameters are too subtle or niche for the main controls panel but should be
reachable for debugging and shader tuning.  Add them inside the Glyph FX sub-panel
behind a collapsed `<details>` block labelled "— Debug —" so they are hidden by
default but always accessible without a code edit.

### Hue variation range

Controls the ±8° G-B plane hue rotation applied per column.

**Shader substitution** (fragment stage, `hueRad` line):
```js
// Before
const hueRad = hueShift.mul(0.14);
// After
const hueRad = hueShift.mul(uHueRange);
```

**Handle method**:
```js
setHueRange(deg) { uniforms.uHueRange.value = deg * Math.PI / 180; },
```
Takes degrees; converts internally. `0` = all columns same hue, `45` = wild shift.

**Demo control**:
```html
<label>Hue range °
  <span style="display:flex;align-items:center;gap:4px;">
    <input id="ctl-hue-range"     type="range"  min="0" max="45" step="1" value="8">
    <input id="ctl-hue-range-num" type="number" min="0" max="45" step="1" value="8">
  </span>
</label>
```
```js
linkSlider('ctl-hue-range', 'ctl-hue-range-num', v => rain.setHueRange(v));
```

---

### Burst column probability

Controls the fraction of columns that receive a speed/glyph-rate surge each 4 s cycle.
Currently 0.5 % (`step(0.995, burstH)`).

**Shader substitution** (vertex stage, `burstActive` line):
```js
// Before
const burstActive = step(0.995, burstH);
// After
const burstActive = step(float(1).sub(uBurstProb), burstH);
```

**Handle method**:
```js
setBurstProb(v) { uniforms.uBurstProb.value = Math.max(0, Math.min(1, v)); },
```

**Demo control**:
```html
<label>Burst prob
  <span style="display:flex;align-items:center;gap:4px;">
    <input id="ctl-burst-prob"     type="range"  min="0" max="1" step="0.005" value="0.005">
    <input id="ctl-burst-prob-num" type="number" min="0" max="1" step="0.005" value="0.005">
  </span>
</label>
```
```js
linkSlider('ctl-burst-prob', 'ctl-burst-prob-num', v => rain.setBurstProb(v));
```

`uBurstProb = 0` disables burst entirely.  `uBurstProb = 1` bursts all columns simultaneously — useful for stress-testing the burst glyph-rate path.

---

## Slider numeric readout  (`demo.html`)

Every `<input type="range">` in the controls panel gets a companion `<input type="number">`
that shows the current value and allows direct numeric entry.  Checkboxes and selects
are excluded.

### Markup pattern

Replace each bare `<input type="range" …>` with a `<span>` containing both inputs.
The number input shares the same `min`/`max`/`step` and is styled by the CSS rule below
(no inline style needed):

```html
<!-- Before -->
<label>Opacity
  <input id="ctl-opacity" type="range" min="0" max="1" step="0.01" value="0.82">
</label>

<!-- After -->
<label>Opacity
  <span style="display:flex;align-items:center;gap:4px;">
    <input id="ctl-opacity"     type="range"  min="0" max="1" step="0.01" value="0.82">
    <input id="ctl-opacity-num" type="number" min="0" max="1" step="0.01" value="0.82">
  </span>
</label>
```

Width `46px` (set in CSS) fits 5 characters (e.g. `0.005`) without the label overflowing
`min-width:220px`.

### Sync logic — single shared helper

Add one reusable function to the `<script>` block, called once per slider pair:

```js
/**
 * Link a range slider and its numeric companion so edits to either
 * propagate to the other and fire the same onChange callback.
 *
 * @param {string}   rangeId   id of the <input type="range">
 * @param {string}   numId     id of the companion <input type="number">
 * @param {Function} onChange  called with the parsed float value on any change
 */
function linkSlider(rangeId, numId, onChange) {
  const range = document.getElementById(rangeId);
  const num   = document.getElementById(numId);
  range.addEventListener('input', () => {
    num.value = range.value;
    onChange(parseFloat(range.value));
  });
  num.addEventListener('change', () => {
    const raw = parseFloat(num.value);
    if (isNaN(raw)) { num.value = range.value; return; }  // reject empty / non-numeric
    const v = Math.max(parseFloat(num.min), Math.min(parseFloat(num.max), raw));
    num.value   = v;
    range.value = v;
    onChange(v);
  });
}
```

`'input'` on the range fires on every drag step.  `'change'` on the number fires on
Enter or focus-out — not `'input'`, to avoid partial-entry interference while typing.
The `isNaN` guard restores the last valid value if the field is cleared or contains
non-numeric text.  The `Math.max/min` clamp rejects out-of-range keyboard entries.

### Replacing the existing `bind()` calls

The existing `bind(id, fn)` helper handles ranges by listening to `'input'` on the range
only.  For all sliders, replace:

```js
// Before
bind('ctl-opacity', v => rain.setOpacity(v));

// After
linkSlider('ctl-opacity', 'ctl-opacity-num', v => rain.setOpacity(v));
```

For multi-slider groups that call a shared push function (e.g. `pushSpeedRange`), wire
both members the same way — the callback ignores the passed value and reads from the DOM
itself, which is fine:

```js
linkSlider('ctl-spd-min', 'ctl-spd-min-num', () => pushSpeedRange());
linkSlider('ctl-spd-max', 'ctl-spd-max-num', () => pushSpeedRange());
```

**Debounced sliders** — some sliders (e.g. `ctl-ncols`, `ctl-shell-in`) are currently
wired with `addEventListener('input', …)` directly (not through `bind()`), wrapping the
callback in `debounceRebuild()`.  Replace those too, passing the debounced call as the
`onChange` argument:

```js
// Before
document.getElementById('ctl-ncols').addEventListener('input', () => {
  debounceRebuild(() => rain.setColumnCount(parseFloat(document.getElementById('ctl-ncols').value)));
});

// After
linkSlider('ctl-ncols', 'ctl-ncols-num', () => {
  debounceRebuild(() => rain.setColumnCount(parseFloat(document.getElementById('ctl-ncols').value)));
});
```

The `bind()` helper remains in the file for checkbox and select elements; it is not
removed.

### Scope

Every `<input type="range">` in the panel — including the new Glyph FX sliders and debug
sliders added in this spec — gets the readout treatment.  That is approximately 55–60
slider pairs.  `type="color"`, `type="text"`, `type="checkbox"`, selects, and buttons
are all excluded.

### CSS

Add to the `<style>` block (removes spinner arrows in Chrome/Safari for cleanliness):

```css
#controls input[type="number"] {
  width: 46px;
  background: #111;
  color: #00ff70;
  border: 1px solid #00ff7055;
  font-family: 'Courier New', monospace;
  font-size: 10px;
  padding: 1px 3px;
  -moz-appearance: textfield;
}
#controls input[type="number"]::-webkit-outer-spin-button,
#controls input[type="number"]::-webkit-inner-spin-button {
  -webkit-appearance: none;
}
```

Spinner removal is intentional — the panel font is too small for spinners to be usable,
and they break the visual rhythm.

---

## Implementation order

No geometry rebuild, no post-processing changes, no TSL structural changes.
Each step is independently testable.

1. `makeUniforms()` — add 11 new uniforms (9 main + `uHueRange` + `uBurstProb`)
2. `buildGlyphMaterial()` — add all 11 to destructure + apply 11 shader substitutions
3. `initMatrixRain()` — add 12 handle methods (10 main + `setHueRange` + `setBurstProb`)
4. `demo.html` — add Glyph FX sub-panel + debug `<details>` block; wire all sliders with
   `linkSlider()` directly (not `bind()`); add to export/import; update `set()` helper
   to sync `*-num` companions
5. `demo.html` — add `<input type="number">` companions to every pre-existing range slider;
   add CSS; replace all pre-existing slider `bind()` / `addEventListener` calls with
   `linkSlider()` (including debounced sliders)

Step 4 introduces new controls already using `linkSlider()`.
Step 5 retrofits the existing ~50 sliders — independent of step 4 and can be done first.

---

## Out of scope

- Drip decay constant (`1.5` in `exp(-d * 1.5)`) — single-use constant coupled to drip amplitude; exposing both would be confusing
- Globe occlusion — explicitly excluded by user
