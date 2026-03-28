# SPEC — Category B Post-Processing Effects

**Status**: Implemented
**Target files**: `matrix-rain-passes-tsl.js`, `matrix-rain-webgpu.js`, `demo.html`

---

## Overview

Six new effects expanding the post-processing pipeline and the animation-loop tick:

| # | Effect | Type | Handle method |
|---|---|---|---|
| B1 | Radial chromatic aberration | New PP pass (after god rays) | `setRadialChroma(v)` |
| B2 | Scanline luma modulation | Modify `buildHoloPass` | (uses `setScanlines`) |
| B3 | Interlace flicker | Modify `buildHoloPass` | `setInterlace(v)` |
| B4 | Bloom threshold breathing | RAF loop only | `setBloomBreath(enabled, rate, amplitude)` |
| B5 | Atmospheric depth fog | New PP pass (after god rays) | `setAtmosphericFog(amt, color)` |
| B6 | Volumetric dust motes | New PP pass (after god rays) | `setDust(v)` |

---

## Pipeline insertion

Current pipeline (from `buildMatrixRainNodes` in `matrix-rain-webgpu.js`):

```
scene → bloom → rtt → heat → rtt → phosphor → rtt
→ soften → rtt → streaks → rtt → holo → rtt → godRays → rttPreFxaa → fxaa
```

After this spec, the pipeline becomes:

```
scene → bloom → rtt → heat → rtt → phosphor → rtt
→ soften → rtt → streaks → rtt → holo → rtt → godRays
→ rttPreFog → fog → dustBuild.outputNode → rttPreRadialChroma
→ radialChroma → rttPreFxaa → fxaa
```

Detailed node chain additions at the end of `buildMatrixRainNodes`:

```js
// --- existing ---
const godRaysBuild = buildGodRaysPass(rttPreGodRays);
godRaysBuild.uEnabled.value = 1.0;

// --- B5: fog (new) ---
const rttPreFog  = rtt(godRaysBuild.outputNode);
const fogBuild   = buildFogPass(rttPreFog);

// --- B6: dust (new) — takes raw outputNode, no custom UV sampling ---
const dustBuild  = buildDustPass(fogBuild.outputNode);

// --- B1: radial chroma (new) — requires TextureNode input for custom UV sampling ---
const rttPreRadialChroma = rtt(dustBuild.outputNode);
const radialChromaBuild  = buildRadialChromaPass(rttPreRadialChroma);

// --- was: rttPreFxaa = rtt(godRaysBuild.outputNode) ---
const rttPreFxaa = rtt(radialChromaBuild.outputNode);
```

The `dispose()` inner function inside `buildMatrixRainNodes` must include the two new RTTs:

```js
for (const n of [afterBloomRtt, afterHeatRtt, rttPhosphor, afterSoftenRtt,
                  rttPreHolo, rttPreGodRays, rttPreFog, rttPreRadialChroma, rttPreFxaa]) {
  try { n?.renderTarget?.dispose(); } catch (_) {}
}
```

The three new pass builders are exposed on the `passBuilders` return object and therefore on `pp._*`:

```js
return {
  // ... existing ...
  passBuilders: {
    _bloomNode:          bloomNode,
    _heatBuild:          heatBuild,
    _softenBuild:        softenBuild,
    _streakBuild:        streakBuild,
    _holoBuild:          holoBuild,
    _godRaysBuild:       godRaysBuild,
    _fogBuild:           fogBuild,           // NEW B5
    _dustBuild:          dustBuild,          // NEW B6
    _radialChromaBuild:  radialChromaBuild,  // NEW B1
  },
  // ...
};
```

And exposed on the `RenderPipeline` object in `buildPP()`:

```js
pipeline._fogBuild          = nodes.passBuilders._fogBuild;
pipeline._dustBuild         = nodes.passBuilders._dustBuild;
pipeline._radialChromaBuild = nodes.passBuilders._radialChromaBuild;
```

---

## B1 — Radial Chromatic Aberration Pass

### Motivation

Screen-edge colour fringing along radial directions from the screen centre, simulating an off-axis CCD or an old projector lens. Unlike the existing holo-pass edge-weighted aberration (which displaces based on a fixed `edgeSq` scale), this pass applies a true radial-outward displacement for each channel.

### Builder: `buildRadialChromaPass(inputTexNode)`

Add to `matrix-rain-passes-tsl.js`.

```js
/**
 * Radial chromatic aberration — R/G/B channels sampled at UV offsets pointing
 * radially away from the screen centre. G channel is unshifted.
 * Requires inputTexNode to be a sampleable TextureNode (wrap upstream in rtt()).
 *
 * @param {TextureNode} inputTexNode
 * @returns {{ outputNode, uRadialChromaticAmt }}
 */
export function buildRadialChromaPass(inputTexNode) {
  const uRadialChromaticAmt = uniform(0.0);

  const outputNode = Fn(() => {
    const base = texture(inputTexNode, screenUV);
    const ctr  = screenUV.sub(vec2(0.5, 0.5));

    // R channel pushed outward from centre, B pushed inward
    const shift = ctr.mul(uRadialChromaticAmt);
    const uvR   = clamp(screenUV.add(shift),         float(0.001), float(0.999));
    const uvB   = clamp(screenUV.sub(shift),         float(0.001), float(0.999));

    const r = texture(inputTexNode, uvR).r;
    const g = base.g;                                  // G unchanged
    const b = texture(inputTexNode, uvB).b;

    return vec4(r, g, b, base.a);
  })();

  return { outputNode, uRadialChromaticAmt };
}
```

**Import additions required** in `matrix-rain-passes-tsl.js`: none — `vec2`, `clamp`, `float`, `vec4`, `texture` already imported.

### Pipeline wiring

Input: `rttPreRadialChroma` (TextureNode — result of `rtt(dustBuild.outputNode)`).
Output: raw `outputNode` → caller wraps in `rtt(radialChromaBuild.outputNode)` as `rttPreFxaa`.

The pass samples at `screenUV + shift` and `screenUV - shift`, both requiring a TextureNode. The `rtt()` wrap before this pass is mandatory.

### Uniform default

| Uniform | Default | Range | Note |
|---|---|---|---|
| `uRadialChromaticAmt` | `0.0` | `0–0.02` | 0 = off (no UV shift) |

### Handle method

```js
setRadialChroma(v) {
  if (postProcessing !== 'rain') return;
  _ppState.radialChromaAmt = v;
  const b = pp?._radialChromaBuild ?? currentRainNodes?.passBuilders?._radialChromaBuild;
  if (b) b.uRadialChromaticAmt.value = v;
},
```

### `_ppState` mirror

Add to `_ppState` initialiser:

```js
radialChromaAmt: 0.0,
```

Add to `_restorePP(nodes)`:

```js
if (pb._radialChromaBuild) {
  pb._radialChromaBuild.uRadialChromaticAmt.value = _ppState.radialChromaAmt;
}
```

### Guard

`setRadialChroma` is a no-op (silent) in `'crt'` and `'none'` modes (guarded by `if (postProcessing !== 'rain') return`).

### Demo UI

Slider in the Post-Processing panel:

```html
<label>Radial Chroma <input type="range" id="radialChroma" min="0" max="0.02" step="0.0005" value="0">
  <input type="number" id="radialChromaNum" min="0" max="0.02" step="0.0005" value="0" style="width:60px"></label>
```

JS wiring: `linkSlider('radialChroma', v => handle.setRadialChroma(v))`.

---

## B2 — Scanline Luma Modulation

### Motivation

Static uniform scanline opacity makes the effect equally visible on the very dark (near-black) background regions as on bright glyph zones. Scaling opacity with local luminance makes scanlines crisper and more visible on bright glyphs while nearly vanishing on the dark background — matching real CRT phosphor behaviour.

### Modification to `buildHoloPass` in `matrix-rain-passes-tsl.js`

**No new uniforms.** Uses existing `uScanlineOpacity`.

Locate the scanline block inside the `Fn(() => {...})()`:

```js
// EXISTING — replace this:
const scan  = sin(screenUV.y.mul(640).add(time.mul(0.5))).mul(0.5).add(0.5);
col.mulAssign(float(1).sub(uScanlineOpacity.mul(float(1).sub(scan))));
```

```js
// NEW — replace with:
const scan  = sin(screenUV.y.mul(640).add(time.mul(0.5))).mul(0.5).add(0.5);
const luma  = clamp(dot(col, vec3(0.2126, 0.7152, 0.0722)), float(0.0), float(1.0));
const effectiveScanOp = uScanlineOpacity.mul(float(0.3).add(float(0.7).mul(luma)));
col.mulAssign(float(1).sub(effectiveScanOp.mul(float(1).sub(scan))));
```

`luma` is computed from `col` which at this point holds the aberration-corrected `vec3(r, g, b)`.
When `uScanlineOpacity = 0`: `effectiveScanOp = 0`, `col.mulAssign(1)` → no change. Correct.
When luma is 0 (pure black): `effectiveScanOp = uScanlineOpacity * 0.3` — a reduced floor so scanlines remain faintly visible on dark backgrounds.
When luma is 1: `effectiveScanOp = uScanlineOpacity * 1.0` — full strength.

**No API changes.** The existing `setScanlines(v)` handle method controls this uniformly.

---

## B3 — Interlace Flicker

### Motivation

Alternating-field flicker recreating the temporal interlace artefact of NTSC/PAL CRT displays: odd and even scan-line rows dim alternately on consecutive frames.

### Modification to `buildHoloPass` in `matrix-rain-passes-tsl.js`

**New uniform** `uInterlaceAmt` (0–1, default 0).
**New parameter** `uInterlaceResY` passed into `buildHoloPass` from the caller and exposed in the return value — same pattern as `uAspect` in `buildStreakPass`.

#### Updated builder signature

```js
/**
 * @param {TextureNode} inputTexNode
 * @param {UniformNode}  [uInterlaceResY]  uniform(screenHeight) — must be updated on resize
 * @returns {{ outputNode, uVignetteStrength, uScanlineOpacity, uAberrationAmt, uGlitchAmt,
 *             uInterlaceAmt, uInterlaceResY }}
 */
export function buildHoloPass(inputTexNode, uInterlaceResY) {
  // ... existing uniforms ...
  const uInterlaceAmt = uniform(0.0);
  if (!uInterlaceResY) uInterlaceResY = uniform(720.0);
  // ...
```

#### Interlace block — insert after the vignette line, before the `return`:

```js
// Interlace flicker — insert after vignette, before return
If(uInterlaceAmt.greaterThan(float(0.001)), () => {
  const frameOdd = mod(floor(time.mul(60.0)), float(2.0));
  const lineOdd  = mod(floor(screenUV.y.mul(uInterlaceResY)), float(2.0));
  // Lines whose parity matches the current frame's field are dimmed
  const dimFactor = float(1.0).sub(uInterlaceAmt.mul(float(0.3)));
  const isDimmed  = abs(lineOdd.sub(frameOdd)).lessThan(float(0.5));
  col.mulAssign(select(isDimmed, dimFactor, float(1.0)));
});
```

`dimFactor = 1 - uInterlaceAmt * 0.3` means at `uInterlaceAmt = 1`, every other line is dimmed to 70% brightness — visible but not harsh. The coefficient 0.3 keeps the effect subtle by default.

#### Updated return

```js
return { outputNode, uVignetteStrength, uScanlineOpacity, uAberrationAmt, uGlitchAmt,
         uInterlaceAmt, uInterlaceResY };
```

### Caller changes in `matrix-rain-webgpu.js`

**Scope-level uniform** (alongside `uAspect`):

```js
const uInterlaceResY = uniform(element.clientHeight || 720);
```

**Pass the uniform into buildHoloPass**:

```js
// was:
const holoBuild = buildHoloPass(rttPreHolo);
// becomes:
const holoBuild = buildHoloPass(rttPreHolo, uInterlaceResY);
```

**ResizeObserver** — update alongside `uAspect` (`renderer.setPixelRatio` uses `Math.min(devicePixelRatio, 2)` at init):

```js
uAspect.value        = w / h;
uInterlaceResY.value = h * Math.min(window.devicePixelRatio, 2);
```

**`handle.onResize(w, h)`** — the handle method used by the external-loop / CRT bridge also sets `uAspect.value`. Update it in the same step:

```js
// was:
onResize(w, h) { uAspect.value = w / h; },
// becomes:
onResize(w, h) {
  uAspect.value        = w / h;
  uInterlaceResY.value = h * Math.min(window.devicePixelRatio, 2);
},
```

**`_ppState` mirror** — add:

```js
interlaceAmt: 0.0,
```

**`_restorePP(nodes)`** — add:

```js
if (pb._holoBuild?.uInterlaceAmt) {
  pb._holoBuild.uInterlaceAmt.value = _ppState.interlaceAmt;
  // uInterlaceResY is managed by the scope-level uniform — no restore needed
}
```

Because `uInterlaceResY` is a scope-level uniform shared with every rebuild of the pass chain (passed into every `buildHoloPass` call from the same `uInterlaceResY` reference), its value persists across rebuilds automatically. No `_ppState` entry needed for it.

### Handle method

```js
setInterlace(v) {
  if (postProcessing !== 'rain') return;
  _ppState.interlaceAmt = v;
  const b = pp?._holoBuild ?? currentRainNodes?.passBuilders?._holoBuild;
  if (b?.uInterlaceAmt) b.uInterlaceAmt.value = v;
},
```

### Guard

No-op in `'crt'` and `'none'` modes (guarded by `if (postProcessing !== 'rain') return`).

### Demo UI

Slider in the Post-Processing / Holo sub-panel:

```html
<label>Interlace <input type="range" id="interlace" min="0" max="1" step="0.01" value="0">
  <input type="number" id="interlaceNum" min="0" max="1" step="0.01" value="0" style="width:60px"></label>
```

JS wiring: `linkSlider('interlace', v => handle.setInterlace(v))`.

---

## B4 — Bloom Threshold Breathing

### Motivation

A slow sinusoidal oscillation on the bloom threshold creates a gentle rhythmic pulse — the whole scene breathes in luminance. Implemented entirely in the RAF loop; no shader changes.

### No shader changes

All logic lives in `tick()` inside `initMatrixRain`.

### Closure state additions

Add these alongside the other animation state vars (e.g. near `burstBloomActive`):

```js
let _bloomBreathEnabled = false;
let _bloomBreathRate    = 0.25;   // Hz — full cycles per second
let _bloomBreathAmp     = 0.08;   // amplitude — threshold swings ±0.08 around base
```

Define `_effectiveBloomThreshold` as a named closure function inside `initMatrixRain` scope, after the state vars and before the `tick()` definition:

```js
function _effectiveBloomThreshold(t) {
  if (!_bloomBreathEnabled) return bloomThreshold;
  return bloomThreshold + Math.sin(t * _bloomBreathRate * Math.PI * 2) * _bloomBreathAmp;
}
```

### tick() modification

The existing burst-bloom block in `tick()`:

```js
const bloomNode = currentRainNodes?.passBuilders?._bloomNode;
if (bloomNode) {
  if (burstBloomActive) {
    // ... burst logic ...
    if (burstBloomTimer > 0) {
      // ... surge computation → bloomNode.threshold.value = lerped value ...
    } else {
      bloomNode.threshold.value = bloomThreshold;  // <-- LINE A
    }
  } else {
    bloomNode.threshold.value = bloomThreshold;    // <-- LINE B
  }
}
```

Change LINE A and LINE B to use the `_effectiveBloomThreshold` helper (defined above `tick()`):

```js
// LINE A replacement:
bloomNode.threshold.value = _effectiveBloomThreshold(t);

// LINE B replacement:
bloomNode.threshold.value = _effectiveBloomThreshold(t);
```

The burst-in-progress path (`burstBloomTimer > 0`) is unchanged — burst always overrides. Breath resumes the moment the burst timer expires.

### Handle method

```js
setBloomBreath(enabled, rate = 0.25, amplitude = 0.08) {
  if (postProcessing !== 'rain') return;
  _bloomBreathEnabled = enabled;
  _bloomBreathRate    = rate;
  _bloomBreathAmp     = amplitude;
  // If disabled, immediately restore the static threshold
  if (!enabled) {
    const bloomNode = currentRainNodes?.passBuilders?._bloomNode
      ?? pp?._bloomNode;
    if (bloomNode) bloomNode.threshold.value = bloomThreshold;
  }
},
```

### Guard

No-op in `'crt'` and `'none'` modes (guarded by `if (postProcessing !== 'rain') return`).

### Demo UI

```html
<label><input type="checkbox" id="bloomBreath"> Bloom Breath</label>
<label>Rate (Hz) <input type="range" id="bloomBreathRate" min="0.05" max="2.0" step="0.05" value="0.25">
  <input type="number" id="bloomBreathRateNum" min="0.05" max="2.0" step="0.05" value="0.25" style="width:60px"></label>
<label>Amplitude <input type="range" id="bloomBreathAmp" min="0" max="0.3" step="0.005" value="0.08">
  <input type="number" id="bloomBreathAmpNum" min="0" max="0.3" step="0.005" value="0.08" style="width:60px"></label>
```

JS wiring:

```js
document.getElementById('bloomBreath').addEventListener('change', e => {
  handle.setBloomBreath(
    e.target.checked,
    parseFloat(document.getElementById('bloomBreathRate').value),
    parseFloat(document.getElementById('bloomBreathAmp').value),
  );
});
linkSlider('bloomBreathRate', v => {
  if (document.getElementById('bloomBreath').checked)
    handle.setBloomBreath(true, v, parseFloat(document.getElementById('bloomBreathAmp').value));
});
linkSlider('bloomBreathAmp', v => {
  if (document.getElementById('bloomBreath').checked)
    handle.setBloomBreath(true, parseFloat(document.getElementById('bloomBreathRate').value), v);
});
```

---

## B5 — Atmospheric Depth Fog

### Motivation

Dark, near-black pixels represent spatial depth or background absence. Adding a faint ambient haze colour to those regions creates the impression of volumetric atmosphere — slightly tinted air between columns and around the edges of the shell.

### Builder: `buildFogPass(inputTexNode)`

Add to `matrix-rain-passes-tsl.js`.

```js
/**
 * Atmospheric depth fog — blends a fog colour into dark (low-luminance) regions.
 * Dark areas (inverse luminance) receive maximum fog; bright areas receive none.
 * Requires inputTexNode to be a sampleable TextureNode (wrap upstream in rtt()).
 *
 * @param {TextureNode} inputTexNode
 * @returns {{ outputNode, uFogAmt, uFogColor }}
 */
export function buildFogPass(inputTexNode) {
  const uFogAmt   = uniform(0.0);
  const uFogColor = uniform(new THREE.Vector3(0.0, 0.06, 0.02));

  const outputNode = Fn(() => {
    const col      = texture(inputTexNode, screenUV).toVar('fog');
    const luma     = clamp(dot(col.rgb, vec3(0.2126, 0.7152, 0.0722)), float(0.0), float(1.0));
    // Fog strength = uFogAmt * (1 - luma): dark pixels get full fog, bright pixels get none.
    const fogBlend = clamp(uFogAmt.mul(float(1.0).sub(luma)), float(0.0), float(1.0));
    col.rgb.assign(mix(col.rgb, uFogColor, fogBlend));
    return col;
  })();

  return { outputNode, uFogAmt, uFogColor };
}
```

**Import additions required** in `matrix-rain-passes-tsl.js`: `vec3` is already imported; `THREE.Vector3` is available via `import * as THREE from 'three/webgpu'`.

### Pipeline wiring

Input: `rttPreFog` (TextureNode — result of `rtt(godRaysBuild.outputNode)`).
Output: raw `fogBuild.outputNode` is passed directly to `buildDustPass` (no rtt needed between fog and dust because dust does not sample at custom UVs).

### Uniform defaults

| Uniform | Default | Range | Note |
|---|---|---|---|
| `uFogAmt` | `0.0` | `0–1` | 0 = off |
| `uFogColor` | `(0.0, 0.06, 0.02)` | vec3 | dark Matrix green |

### Handle method

```js
setAtmosphericFog(amt, color) {
  if (postProcessing !== 'rain') return;
  _ppState.fogAmt   = amt;
  if (color !== undefined) _ppState.fogColor = color;
  const b = pp?._fogBuild ?? currentRainNodes?.passBuilders?._fogBuild;
  if (!b) return;
  b.uFogAmt.value = amt;
  if (color !== undefined) {
    const c = new THREE.Color(color);
    b.uFogColor.value.set(c.r, c.g, c.b);
  }
},
```

### `_ppState` mirror

```js
fogAmt:   0.0,
fogColor: '#00100a',   // serialised as hex string for Color() constructor
```

`_restorePP`:

```js
if (pb._fogBuild) {
  pb._fogBuild.uFogAmt.value = _ppState.fogAmt;
  const fc = new THREE.Color(_ppState.fogColor);
  pb._fogBuild.uFogColor.value.set(fc.r, fc.g, fc.b);
}
```

### Guard

No-op in `'crt'` and `'none'` modes.

### Demo UI

```html
<label>Fog Amount <input type="range" id="fogAmt" min="0" max="1" step="0.01" value="0">
  <input type="number" id="fogAmtNum" min="0" max="1" step="0.01" value="0" style="width:60px"></label>
<label>Fog Colour <input type="color" id="fogColor" value="#00100a"></label>
```

JS wiring (`_ppState` is closure-private; demo reads the slider DOM element for the current amount):

```js
linkSlider('fogAmt', v => handle.setAtmosphericFog(v));
document.getElementById('fogColor').addEventListener('input', e => {
  handle.setAtmosphericFog(
    parseFloat(document.getElementById('fogAmt').value),
    e.target.value
  );
});
```

---

## B6 — Volumetric Dust Motes

### Motivation

Small bright particles drifting slowly across the screen simulate dust caught in the green light — a direct reference to the corridor scenes in the film.

### Builder: `buildDustPass(inputNode)`

Add to `matrix-rain-passes-tsl.js`.

This pass takes `inputNode` directly (no custom UV sampling of the input — purely additive), matching the `buildStreakPass` pattern.

**Import addition required**: `length` must be added to the `three/tsl` import in `matrix-rain-passes-tsl.js`.

```js
/**
 * Volumetric dust motes — 32 procedural light particles drifting across the screen.
 * Additive blend; does not sample input at custom UVs — takes raw inputNode.
 *
 * @param {Node} inputNode  upstream post-processing node
 * @returns {{ outputNode, uDustAmt }}
 */
export function buildDustPass(inputNode) {
  const uDustAmt = uniform(0.0);

  const outputNode = Fn(() => {
    const col      = inputNode.toVar('dstCol');
    const dustAcc  = vec3(0.0).toVar('dstAcc');

    Loop({ start: int(0), end: int(32), type: 'int' }, ({ i }) => {
      const fi = i.toFloat();

      // Deterministic per-mote parameters derived from index via fract-sin hash
      const baseX  = fract(sin(fi.mul(float(47.3213))).mul(float(43758.5453)));
      const baseY  = fract(sin(fi.mul(float(31.7891))).mul(float(12345.6789)));
      const spdX   = float(0.012).add(fract(sin(fi.mul(float(17.1111))).mul(float(9876.5432))).mul(float(0.018)));
      const spdY   = float(0.008).add(fract(sin(fi.mul(float(23.3333))).mul(float(5432.1098))).mul(float(0.012)));
      const phase  = fi.mul(float(2.3998));   // golden-ratio-ish angular spread across 32 motes
      const radius = float(0.0025).add(fract(sin(fi.mul(float(13.7777))).mul(float(8765.4321))).mul(float(0.007)));

      // Smoothly drifting position, wrapping in [0,1] via fract
      const mx = fract(baseX.add(time.mul(spdX)));
      const my = fract(baseY.add(time.mul(spdY).add(sin(time.mul(float(0.31)).add(phase)).mul(float(0.018)))));

      const dist       = length(screenUV.sub(vec2(mx, my)));
      const mote       = exp(dist.mul(dist).negate().div(radius.mul(radius).mul(float(2.0))));
      const brightness = float(0.45).add(float(0.55).mul(sin(time.mul(float(1.1)).add(phase))));

      dustAcc.addAssign(vec3(0.55, 1.0, 0.65).mul(mote).mul(brightness));
    });

    col.rgb.addAssign(dustAcc.mul(uDustAmt));
    // Soft clamp to avoid bloom overflow
    col.rgb.assign(min(col.rgb, vec3(3.0)));
    return col;
  })();

  return { outputNode, uDustAmt };
}
```

### Pipeline wiring

Input: `fogBuild.outputNode` (raw node — no rtt needed).
Output: raw `dustBuild.outputNode` → caller wraps in `rtt(dustBuild.outputNode)` as `rttPreRadialChroma`.

The dust pass is intentionally between fog (additive world haze) and radial chroma (lens effect), so dust particles also receive the final lens aberration.

### Uniform default

| Uniform | Default | Range | Note |
|---|---|---|---|
| `uDustAmt` | `0.0` | `0–1` | 0 = off |

### Handle method

```js
setDust(v) {
  if (postProcessing !== 'rain') return;
  _ppState.dustAmt = v;
  const b = pp?._dustBuild ?? currentRainNodes?.passBuilders?._dustBuild;
  if (b) b.uDustAmt.value = v;
},
```

### `_ppState` mirror

```js
dustAmt: 0.0,
```

`_restorePP`:

```js
if (pb._dustBuild) pb._dustBuild.uDustAmt.value = _ppState.dustAmt;
```

### Guard

No-op in `'crt'` and `'none'` modes.

### Demo UI

```html
<label>Dust <input type="range" id="dust" min="0" max="1" step="0.01" value="0">
  <input type="number" id="dustNum" min="0" max="1" step="0.01" value="0" style="width:60px"></label>
```

JS wiring: `linkSlider('dust', v => handle.setDust(v))`.

---

## CLAUDE.md API table additions

Add to the handle methods table:

| Method | Description |
|---|---|
| `setRadialChroma(v)` | Radial chromatic aberration strength 0–0.02 (0 = off) |
| `setInterlace(v)` | Interlace flicker amount 0–1 (0 = off) |
| `setAtmosphericFog(amt, color?)` | Fog amount 0–1 and optional hex colour (default dark green) |
| `setDust(v)` | Dust mote intensity 0–1 (0 = off) |
| `setBloomBreath(enabled, rate?, amplitude?)` | Sinusoidal bloom threshold oscillation; rate in Hz (default 0.25), amplitude (default 0.08) |

Add to the Shader Uniform Defaults table:

| Uniform | Default | Note |
|---|---|---|
| `uRadialChromaticAmt` | `0.0` | Radial chroma pass |
| `uFogAmt` | `0.0` | Atmospheric fog amount |
| `uFogColor` | `(0.0, 0.06, 0.02)` | Fog colour (dark Matrix green) |
| `uDustAmt` | `0.0` | Dust mote intensity |
| `uInterlaceAmt` | `0.0` | Interlace flicker amount |

Add to the "no-op in 'crt' and 'none'" note:
`setRadialChroma`, `setAtmosphericFog`, `setDust`, `setInterlace`, `setBloomBreath` are no-ops in `'crt'` and `'none'` modes.

---

## Implementation steps

### Step 1 — matrix-rain-passes-tsl.js

1. Add `length` to the `three/tsl` import.
2. Add `buildFogPass(inputTexNode)` (B5).
3. Add `buildDustPass(inputNode)` (B6).
4. Add `buildRadialChromaPass(inputTexNode)` (B1).
5. Modify `buildHoloPass`:
   a. Add `uInterlaceResY` parameter with fallback default.
   b. Add `uInterlaceAmt` uniform.
   c. Replace existing scanline block with luma-modulated version (B2).
   d. Add interlace block after vignette (B3).
   e. Include `uInterlaceAmt` and `uInterlaceResY` in return object.

### Step 2 — matrix-rain-webgpu.js

1. Add scope-level `uInterlaceResY = uniform(element.clientHeight || 720)`.
2. Add `_bloomBreathEnabled`, `_bloomBreathRate`, `_bloomBreathAmp` closure vars.
3. Add `_effectiveBloomThreshold(t)` helper function.
4. Update `buildMatrixRainNodes`:
   a. Pass `uInterlaceResY` to `buildHoloPass`.
   b. Insert fog → dust → rttPreRadialChroma → radialChroma → rttPreFxaa chain.
   c. Update `dispose()` to include new RTTs.
   d. Expose `_fogBuild`, `_dustBuild`, `_radialChromaBuild` in `passBuilders`.
5. Update `buildPP()` to expose `_fogBuild`, `_dustBuild`, `_radialChromaBuild` on pipeline.
6. Update `_ppState` with new fields.
7. Update `_restorePP()` with new restore blocks.
8. Update ResizeObserver to update `uInterlaceResY.value`.
9. Update `tick()` bloom threshold writes to call `_effectiveBloomThreshold(t)`.
10. Add handle methods: `setRadialChroma`, `setInterlace`, `setAtmosphericFog`, `setDust`, `setBloomBreath`.
11. Update `setBloomThreshold(v)` to reset breath: when called, it updates `bloomThreshold`; breath continues oscillating around the new base automatically — no special handling needed.

### Step 3 — matrix-rain-passes-tsl.js import list

```js
// Add 'length' to existing import:
import {
  Fn, float, int, vec2, vec3, vec4,
  uniform,
  sin, dot, abs, max, min, exp, fract, floor, sqrt, clamp, mix,
  smoothstep, step, normalize, length,      // <-- length added
  screenUV, texture,
  If, Loop,
  select, time,
} from 'three/tsl';
```

### Step 4 — demo.html

Add sliders to the existing Post-Processing panel:
- Radial Chroma slider (linkSlider → `setRadialChroma`)
- Interlace slider (linkSlider → `setInterlace`)
- Fog Amount slider + Fog Colour colour picker (→ `setAtmosphericFog`)
- Dust slider (linkSlider → `setDust`)
- Bloom Breath checkbox + Rate slider + Amplitude slider (→ `setBloomBreath`)

---

## Review history

### Round 1 — issues found and fixed

1. **`length` not imported in `matrix-rain-passes-tsl.js`**: The current import list includes `normalize` but not `length`. The dust pass requires `length(screenUV.sub(vec2(mx, my)))`. Fixed: added `length` to the Step 3 import list and noted it in the builder JSDoc.

2. **`clamp(vec2, scalar, scalar)` vs `clamp(vec2, float, float)`**: Existing heat pass uses `clamp(screenUV.add(...), 0.001, 0.999)` — JS literal scalars are accepted. The radial chroma pass uses the same pattern. Verified correct.

3. **`fog → dust` ordering without rtt()**: The fog pass returns a raw `outputNode` that is passed directly into `buildDustPass(inputNode)`. Dust uses `inputNode.toVar()` — no `texture()` call, no custom UV. This is the same pattern as `buildStreakPass` receiving `afterSoftenRtt` directly via `inputNode.toVar()`. Correct — no rtt() needed between fog output and dust input.

4. **Phosphor feedback loop not disturbed**: The phosphor `rttPhosphor` is created from `afterHeatRtt` input, and `renderer.copyTextureToTexture` always copies from `pp._rttPhosphor.renderTarget.texture`. No new passes are inserted before the phosphor stage. The telescreen resize detection (`pp._rttPhosphor?.renderTarget`) still works. Confirmed no interference.

5. **FXAA position**: FXAA wraps `rttPreFxaa` which is now `rtt(radialChromaBuild.outputNode)`. FXAA remains the final step. Confirmed correct.

6. **`buildHoloPass` signature change — call site update needed**: `buildHoloPass(rttPreHolo)` must become `buildHoloPass(rttPreHolo, uInterlaceResY)` in `buildMatrixRainNodes`. Added to Step 2 implementation list. The `if (!uInterlaceResY) uInterlaceResY = uniform(720.0)` fallback ensures backwards compatibility if called without the parameter.

7. **`_effectiveBloomThreshold` and bloom disabled case**: When `pp` is null (before init completes) or `postProcessing !== 'rain'`, `bloomNode` is null so the whole block is skipped. The helper only runs inside the `if (bloomNode)` guard. The `if (postProcessing !== 'rain') return` guard in `setBloomBreath` prevents enabling it in non-rain modes. Safe.

8. **`_ppState.fogColor` type mismatch**: `_ppState.fogColor` is stored as a hex string `'#00100a'`, but `_restorePP` uses `new THREE.Color(_ppState.fogColor)`. `THREE.Color` accepts hex strings. Consistent with how `setAtmosphericFog(amt, color)` uses `new THREE.Color(color)`. Correct.

9. **Dust `min(col.rgb, vec3(3.0))`**: The import list includes `min`. Used identically in `buildStreakPass`: `col.rgb.assign(min(col.rgb, vec3(3.0)))`. Confirmed pattern match.

10. **Interlace `time.mul(60.0)` frame-rate independence**: `floor(time.mul(60.0))` is a wall-clock count of 1/60s intervals, not a frame count — it changes at exactly 60 Hz regardless of actual render frame rate. This means at 30 fps the flicker appears at 30 Hz (one field per rendered frame), while at 120 fps it appears at 60 Hz (one field every two rendered frames). This is acceptable for a stylistic effect. The coefficient 60.0 approximates NTSC field rate.

11. **`abs(lineOdd.sub(frameOdd)).lessThan(float(0.5))` vs `.equal()`**: Both values are 0.0 or 1.0 after `mod(..., 2.0)`. Equality comparison of float values can fail due to precision. Using `abs(diff).lessThan(0.5)` is robust — values are exactly 0.0 and 1.0 from `mod(floor(...), 2.0)`, but the `lessThan` approach is safer practice. Kept as specified.

12. **Dust pass: `vec3(0.55, 1.0, 0.65)` tint**: The dust mote colour is a greenish-white matching the Matrix colour palette. At `uDustAmt = 0` the entire dust computation is still run but produces 0 net contribution (all adds multiply by 0). For performance, wrapping in `If(uDustAmt.greaterThan(float(0.001)), () => { ... })` would avoid the 32-sample loop when disabled. Added this guard as an optional optimisation note: implementations may wrap the dust loop body in `If(uDustAmt.greaterThan(float(0.001)), () => { Loop... })` to skip evaluation when dust is off.

13. **`setAtmosphericFog` demo — `_ppState` is closure-private**: The demo HTML cannot reference `_ppState.fogAmt` directly. The fog colour picker callback must read the fog amount from the slider DOM element, not `_ppState`. Fixed the demo code snippet to use `parseFloat(document.getElementById('fogAmt').value)`.

### Round 2 — issues found and fixed

14. **`onResize` handle method misses `uInterlaceResY` update**: The `onResize(w, h)` method in the handle (used by external-loop / CRT bridge callers) only updated `uAspect.value`. It also needs `uInterlaceResY.value = h * Math.min(window.devicePixelRatio, 2)`. Added to the `buildHoloPass` caller changes section and to Step 2 implementation list.

15. **`_effectiveBloomThreshold` placement was ambiguous**: The spec said "above `tick()` or inline". Since it accesses closure vars (`_bloomBreathEnabled`, `bloomThreshold`, etc.), it must be a named closure function inside `initMatrixRain`, defined after the animation state vars and before the `tick()` definition. The spec now explicitly says this and moves the function definition out of the `tick()` modification section to make it unambiguous.

### Round 3 — re-review, no new issues found

- All TSL node operations use method-chaining style throughout.
- All passes that sample at custom UVs receive a TextureNode from `rtt()`.
- All passes that use value-passthrough take raw `inputNode`.
- The `dispose()` function correctly enumerates all new RTTs (`rttPreFog`, `rttPreRadialChroma`, the new `rttPreFxaa`).
- No existing handle method names are shadowed by new methods.
- `setBloomBreath` correctly guards on `postProcessing !== 'rain'`.
- `_restorePP` covers all new `_ppState` fields.
- `uInterlaceResY` is managed as a scope-level uniform passed into the builder — does not need `_ppState` restoration (value persists in the uniform object across pipeline rebuilds because it is the same uniform instance every time).
- Both ResizeObserver and `onResize` handle method now update `uInterlaceResY`.
- `_effectiveBloomThreshold(t)` is a closure function defined before `tick()` — placement is unambiguous.
- Fog → phosphor interaction: the fog pass is downstream of phosphor, so fog haze does not feed back into the persistence buffer. No artefact risk.
- Dust `fract-sin` hash values produce deterministic, non-flickering positions. Time drives smooth drift only.
- `length` import addition for `matrix-rain-passes-tsl.js` correctly identified and placed in Step 3.
- `int` and `vec4` are already imported in `matrix-rain-passes-tsl.js` — no additional imports needed for those.
- Interlace `abs(lineOdd.sub(frameOdd)).lessThan(float(0.5))` is robust against float comparison failure for the 0/1 values produced by `mod(floor(...), 2.0)`.
