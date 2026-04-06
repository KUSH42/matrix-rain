# SPEC-demo-params — Port 2D demo controls to demo.html

**Status**: Implemented
**Priority**: Medium
**Reference**: `demo-2d.html` controls panel, `demo.html` controls panel

---

## Motivation

`demo-2d.html` exposes several organic animation controls — brightness, breathing, head-wave
speed/amount, phase correlation, weighted glyphs — that have direct 3D analogues but are
currently hardcoded constants in `matrix-rain-tsl.js`. Exposing them as uniforms + handle
methods allows real-time tuning in `demo.html` and is a low-overhead change (no geometry
rebuild, no shader recompile).

---

## Audit: 2D sliders vs 3D status

| 2D control | 3D status | Action |
|---|---|---|
| Opacity | ✅ already in demo.html | — |
| Speed | ✅ already (setSpeed → uSpeedMul) | — |
| Brightness | ❌ no 3D equivalent | **Add uBrightness uniform + handle method** |
| Cell width / height | ✅ `uCellW`/`uCellH` exist but not exposed | **Expose via setCellSize(w, h)** |
| Head wave speed | ❌ hardcoded 0.15 rad/s | **Add uWaveSpeed uniform** |
| Head wave amount | ❌ hardcoded ±4 world units | **Add uWaveAmt uniform** |
| Speed oscillation | ❌ hardcoded 0.15 amplitude | **Add uBreathAmt uniform** |
| Weighted glyphs | ❌ LUT always active, no toggle | **Add uWeightedGlyphs uniform** |
| Freeze | ✅ already in demo.html | — |
| Reduced motion | ✅ already in demo.html | — |
| Glitch intensity / trigger | ✅ already in demo.html | — |
| Speed ramp multiplier / trigger | ✅ already in demo.html | — |
| Speed min / max | ❌ geometry-baked | Skip — needs rebuild |
| Trail min / max | ❌ geometry-baked | Skip — needs rebuild |
| Density | ❌ all 600 cols always active | Skip — N/A to 3D |
| Streams/col | ❌ 3D is single-head per column | Skip — N/A |
| Multi-layer depth + layer controls | ❌ 3D is volumetric | Skip — N/A |

---

## New uniforms

Add to `makeUniforms()` in `matrix-rain-tsl.js`:

```js
uBrightness:    uniform(1.0),   // output brightness multiplier — range [0.2, 2.0]
uBreathAmt:     uniform(1.0),   // speed-oscillation amplitude scale — 0 = off, 1 = ±15%
uWaveSpeed:     uniform(0.15),  // wave crest angular speed in rad/s (hardcoded was 0.15)
uWaveAmt:       uniform(1.0),   // wave offset amplitude scale — 0 = off, 1 = ±4 world units
uWeightedGlyphs: uniform(1.0), // LUT weight blend — 0 = uniform sampling, 1 = full LUT
```

---

## Shader changes (`matrix-rain-tsl.js`)

### Destructure new uniforms

In `buildGlyphMaterial`, add to the destructure block:
```js
uBrightness, uBreathAmt, uWaveSpeed, uWaveAmt, uWeightedGlyphs,
```

### Breathing amplitude

Current (line ~211):
```js
const breathMul = float(1).add(
  sin(uTime.mul(breathFreq).mul(6.2832).add(breathPhase)).mul(0.15)
);
```

Replace `0.15` with `uBreathAmt.mul(0.15)`:
```js
const breathMul = float(1).add(
  sin(uTime.mul(breathFreq).mul(6.2832).add(breathPhase)).mul(uBreathAmt.mul(0.15))
);
```

### Head-wave speed and amplitude

Current (line ~223–224):
```js
const wavePhase  = thetaWave.mul(3.0).add(uTime.mul(0.15));  // 3 crests, 0.15 rad/s
const waveOffset = sin(wavePhase).mul(4.0);                   // ±4 world units
```

Replace hardcoded values with uniforms:
```js
const wavePhase  = thetaWave.mul(3.0).add(uTime.mul(uWaveSpeed));
const waveOffset = sin(wavePhase).mul(uWaveAmt.mul(4.0));
```

### Weighted glyphs blend

Current lines (from SPEC-glyph-weights implementation):
```js
const baseGlyph = texture(uGlyphWeightLUT, vec2(h2(cellId.mul(0.47).add(0.5)), 0.5)).r.mul(255.0).floor();
const mutGlyph  = texture(uGlyphWeightLUT, vec2(h2(cellId.mul(0.37).add(changeTick.mul(vec2(0.11, 0.07)))), 0.5)).r.mul(255.0).floor();
```

Replace both lines. Add a select node so that at `uWeightedGlyphs = 0` the sampling
degrades to uniform, at `1` it uses the LUT fully.

Use intermediate hash variables to avoid computing each hash twice:

```js
// Weighted vs uniform glyph selection — uWeightedGlyphs blends LUT → uniform.
// A per-cell coin-flip hash selects LUT or uniform for each cell independently.
const baseHash  = h2(cellId.mul(0.47).add(0.5));
const baseRaw   = floor(baseHash.mul(uGlyphCount));
const baseLUT   = texture(uGlyphWeightLUT, vec2(baseHash, 0.5)).r.mul(255.0).floor();
const baseGlyph = select(h2(cellId.mul(0.53).add(0.1)).lessThan(uWeightedGlyphs), baseLUT, baseRaw);

const mutHash  = h2(cellId.mul(0.37).add(changeTick.mul(vec2(0.11, 0.07))));
const mutRaw   = floor(mutHash.mul(uGlyphCount));
const mutLUT   = texture(uGlyphWeightLUT, vec2(mutHash, 0.5)).r.mul(255.0).floor();
const mutGlyph = select(h2(cellId.mul(0.61).add(0.3)).lessThan(uWeightedGlyphs), mutLUT, mutRaw);
```

At `uWeightedGlyphs = 1.0` the `lessThan` always passes → always LUT (same as before).
At `uWeightedGlyphs = 0.0` the `lessThan` never passes → always uniform (original behaviour).
At intermediate values, each cell independently picks one or the other.

### Brightness output multiplier

At the end of the fragment `outputNode` Fn (line ~542), the final return is:

```js
// Pre-multiplied alpha — additive compositing on the canvas
return vec4(col2.mul(alpha), alpha);
```

Replace with:

```js
return vec4(col2.mul(alpha).mul(uBrightness), alpha);
```

`uBrightness` scales only the RGB additive contribution; the alpha channel is unchanged,
preserving the max-equation alpha blending used for order-independent compositing.

---

## New handle methods (`matrix-rain-webgpu.js`)

Add to the returned handle object:

```js
setBrightness(v)       { uniforms.uBrightness.value = v; },
setBreathAmt(v)        { uniforms.uBreathAmt.value = v; },
setWaveSpeed(v)        { uniforms.uWaveSpeed.value = v; },
setWaveAmt(v)          { uniforms.uWaveAmt.value = v; },
setWeightedGlyphs(v)   { uniforms.uWeightedGlyphs.value = v; },
setCellSize(w, h)      {
  uniforms.uCellW.value = w;
  uniforms.uCellH.value = h;
},
```

These are all pure uniform writes — no rebuild required.

---

## demo.html changes

### New "Organic" sub-panel

Add a new collapsible section after the Animation sub-panel (before CRT):

```html
<!-- Organic sub-panel -->
<div style="border-top:1px solid #00ff7044;margin-top:4px;padding-top:4px;
            display:flex;flex-direction:column;gap:4px;">
  <label style="color:#7fffaa;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;">
    — Organic —
  </label>

  <label>Brightness
    <input id="ctl-brightness" type="range" min="0.2" max="2.0" step="0.05" value="1.0">
  </label>

  <label>Cell W
    <input id="ctl-cellw" type="range" min="0.04" max="0.30" step="0.005" value="0.12">
  </label>

  <label>Cell H
    <input id="ctl-cellh" type="range" min="0.02" max="0.20" step="0.005" value="0.08">
  </label>

  <label>Breath amount
    <input id="ctl-breath-amt" type="range" min="0" max="1" step="0.05" value="1.0">
  </label>

  <label>Head wave speed
    <input id="ctl-wave-speed" type="range" min="0" max="0.5" step="0.01" value="0.15">
  </label>

  <label>Wave amount
    <input id="ctl-wave-amt" type="range" min="0" max="1" step="0.05" value="1.0">
  </label>

  <label>Weighted glyphs
    <input id="ctl-weighted" type="checkbox" checked>
  </label>
</div>
```

### JS wiring

In the `bind` call block, add:
```js
bind('ctl-brightness',  v  => rain.setBrightness(v));
bind('ctl-breath-amt',  v  => rain.setBreathAmt(v));
bind('ctl-wave-speed',  v  => rain.setWaveSpeed(v));
bind('ctl-wave-amt',    v  => rain.setWaveAmt(v));
bind('ctl-weighted',    on => rain.setWeightedGlyphs(on ? 1.0 : 0.0));
```

Cell W and H are coupled (like the 2D demo), so use explicit event listeners:
```js
document.getElementById('ctl-cellw').addEventListener('input', () => {
  rain.setCellSize(
    parseFloat(document.getElementById('ctl-cellw').value),
    parseFloat(document.getElementById('ctl-cellh').value),
  );
});
document.getElementById('ctl-cellh').addEventListener('input', () => {
  rain.setCellSize(
    parseFloat(document.getElementById('ctl-cellw').value),
    parseFloat(document.getElementById('ctl-cellh').value),
  );
});
```

### Settings import/export

Add the new keys to `collectSettings()`:
```js
brightness:     fv('ctl-brightness'),
cellW:          fv('ctl-cellw'),
cellH:          fv('ctl-cellh'),
breathAmt:      fv('ctl-breath-amt'),
waveSpeed:      fv('ctl-wave-speed'),
waveAmt:        fv('ctl-wave-amt'),
weightedGlyphs: cb('ctl-weighted'),
```

Add corresponding `applySettings()` cases:
```js
set('ctl-brightness',  s.brightness);
set('ctl-cellw',       s.cellW);
set('ctl-cellh',       s.cellH);
set('ctl-breath-amt',  s.breathAmt);
set('ctl-wave-speed',  s.waveSpeed);
set('ctl-wave-amt',    s.waveAmt);
chk('ctl-weighted',    s.weightedGlyphs);
// live push:
if (s.brightness     !== undefined) rain.setBrightness(s.brightness);
if (s.cellW          !== undefined || s.cellH !== undefined) rain.setCellSize(
  s.cellW ?? parseFloat(document.getElementById('ctl-cellw').value),
  s.cellH ?? parseFloat(document.getElementById('ctl-cellh').value),
);
if (s.breathAmt      !== undefined) rain.setBreathAmt(s.breathAmt);
if (s.waveSpeed      !== undefined) rain.setWaveSpeed(s.waveSpeed);
if (s.waveAmt        !== undefined) rain.setWaveAmt(s.waveAmt);
if (s.weightedGlyphs !== undefined) rain.setWeightedGlyphs(s.weightedGlyphs ? 1.0 : 0.0);
```

### CLAUDE.md handle method table

Add new rows to the Handle Methods table:

| `setBrightness(v)` | Output brightness multiplier 0.2–2.0 |
| `setBreathAmt(v)` | Speed-oscillation amplitude 0–1 (0=off) |
| `setWaveSpeed(v)` | Wave crest angular speed rad/s (default 0.15) |
| `setWaveAmt(v)` | Wave offset amplitude 0–1 (0=off, 1=±4 world units) |
| `setWeightedGlyphs(v)` | Glyph weight LUT blend 0–1 (0=uniform, 1=full LUT) |
| `setCellSize(w, h)` | Cell world-unit dimensions (default 0.12, 0.08) |

---

## Files Changed

| File | Change |
|---|---|
| `matrix-rain-tsl.js` | Add 5 new uniforms; replace 3 hardcoded constants; add weighted glyphs select nodes; multiply final color by `uBrightness` |
| `matrix-rain-webgpu.js` | Add 6 handle methods |
| `demo.html` | Add "Organic" sub-panel (7 controls); wire JS; extend collectSettings/applySettings |
| `CLAUDE.md` | Update Handle Methods table with 6 new entries |

No changes to `matrix-rain-passes-tsl.js`, `matrix-rain-presets.js`, or `demo-2d.html`.

---

## Verification

1. **Brightness**: sliding to 2.0 doubles glyph luminance; at 0.2 the rain dims noticeably.
2. **Breath amount**: at 0 the speed is constant — no per-column oscillation visible over 10 s.
   At 1.0 you can see individual columns subtly speed up and slow down.
3. **Head wave speed**: at 0 the wave crest is frozen (no drift). At 0.5 the 3-crest pattern rotates
   visibly around the shell over ~12 s (2π / (0.5 × 3) ≈ 4 s per crest).
4. **Wave amount**: at 0 all columns advance independently (no phase clustering). At 1 the
   arc-shaped wave pattern is visible (same as before this spec).
5. **Weighted glyphs**: set charSet to matrix1999, toggle off — denser katakana should no
   longer dominate; simple strokes become more common.
6. **Cell size**: changing W/H adjusts glyph spacing in real time without rebuilding.
7. **Export / import round-trip**: export a settings JSON, reload the page, import — all
   six new params restore correctly.
8. **PP mode switch**: switching PP mode destroys and recreates the rain instance with
   defaults (consistent with existing behaviour — only charSet is preserved). The new
   controls reset to their defaults, same as opacity, depth, etc. No regression.
