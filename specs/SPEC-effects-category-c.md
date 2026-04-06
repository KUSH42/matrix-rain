# SPEC — Category C: New Column Behaviour Effects

**Status**: Implemented
**Target files**: `matrix-rain-tsl.js`, `matrix-rain-webgpu.js`, `demo.html`

---

## Overview

Four new column-level behavioural effects:

1. **Cluster gravity wells** — clusters periodically contract toward their centroid then disperse
2. **Perspective convergence** — glyphs skew horizontally toward a vanishing point
3. **Morse code flicker** — glyph alpha pulses in deterministic dot-dash rhythm per column
4. **Spiral formation** — columns orbit the central Y axis in a slow vortex

All four are additive overlays on top of the existing position/appearance pipeline. None replace
existing systems. All are off by default (default uniform values produce zero net effect).

---

## 1. Cluster Gravity Wells

### Concept

Each column is attracted toward its cluster's world XZ centroid. The attraction is sinusoidal:
contracting and dispersing periodically. The displacement is additive, applied to the billboard
center `colCenter` inside the trail-window cull block.

### New attribute: `aClusterCenter`

A `vec2` (2 floats/instance) baked attribute storing the **raw** world XZ coordinates of the
column's cluster centroid (no `uColumnOffset` applied — raw `colABuf` coords). This is
consistent with how all other per-column geometry attributes store raw positions.

**Computation in `buildGeometry()`** — two-pass, after the main column loop:

```js
// Pass 1: accumulate raw wx/wz per cluster — regular columns only.
// This loop runs AFTER the for (let c = 0; c < nCols; c++) loop that fills colABuf
// and BEFORE the reserve pool loop (required: the reserve loop writes into clusterCenterBuf).
// Reserve columns (c >= reserveStart) are evenly distributed across the shell, not clustered,
// so including them would bias cluster centroids away from their true angular centers.
const reserveStart2 = nCols - spawnReserves;  // same value as the reserveStart below
const clusterSumX   = new Float32Array(nClusters);
const clusterSumZ   = new Float32Array(nClusters);
const clusterCount2 = new Int32Array(nClusters);
for (let c = 0; c < reserveStart2; c++) {
  const ci   = c % nClusters;
  const base = c * N_ROWS * 4;
  clusterSumX[ci]  += colABuf[base];      // raw wx
  clusterSumZ[ci]  += colABuf[base + 1];  // raw wz
  clusterCount2[ci]++;
}
// Pass 2: compute centroid per cluster
const clusterCenterX = new Float32Array(nClusters);
const clusterCenterZ = new Float32Array(nClusters);
for (let ci = 0; ci < nClusters; ci++) {
  const cnt = Math.max(1, clusterCount2[ci]);
  clusterCenterX[ci] = clusterSumX[ci] / cnt;
  clusterCenterZ[ci] = clusterSumZ[ci] / cnt;
}

// Pass 3: build per-instance attribute buffer (replicated over N_ROWS rows per column)
const clusterCenterBuf = new Float32Array(total * 2);  // vec2, total = nCols * N_ROWS
for (let c = 0; c < nCols; c++) {
  const ci = c % nClusters;
  const cx = clusterCenterX[ci];
  const cz = clusterCenterZ[ci];
  for (let row = 0; row < N_ROWS; row++) {
    const i2 = (c * N_ROWS + row) * 2;
    clusterCenterBuf[i2]     = cx;
    clusterCenterBuf[i2 + 1] = cz;
  }
}
geom.setAttribute('aClusterCenter', new THREE.InstancedBufferAttribute(clusterCenterBuf, 2));
```

**Reserve pool columns** — inside the existing reserve pool loop (after `nearestCluster` is
determined), add:

```js
// Inside the reserve pool loop, after nearestCluster is determined:
for (let r = 0; r < N_ROWS; r++) {
  const i2 = (c * N_ROWS + r) * 2;
  clusterCenterBuf[i2]     = clusterCenterX[nearestCluster];
  clusterCenterBuf[i2 + 1] = clusterCenterZ[nearestCluster];
}
```

### New uniforms

Added to `makeUniforms()`:

```js
uGravityStrength: uniform(0.0),   // gravity well pull amplitude (world units); 0 = off, max ~1.5
uGravityRate:     uniform(0.2),   // oscillation frequency Hz; range [0.1, 0.5]
```

### Vertex shader insertion point

Insert inside the **trail window cull** `If(dist.greaterThanEqual(-0.5).and(dist.lessThanEqual(maxVisible)), () => { ... })` block, **after `colCenter.addAssign(right.mul(sway))`** (the sway line), **before** the Z-rotation block:

```js
// ── Cluster gravity well ──────────────────────────────────────────────
// aClusterCenter stores raw cluster centroid XZ (no uColumnOffset).
// Direction is computed in raw space, matching aColAAttr.x/y (also raw).
// The additive displacement is the same in offset-adjusted space because
// offset cancels: (centroid+offset) - (col+offset) = centroid - col.
const aClusterCenterAttr = attribute('aClusterCenter', 'vec2');
const gravDirX    = aClusterCenterAttr.x.sub(aColAAttr.x);   // raw X delta
const gravDirZ    = aClusterCenterAttr.y.sub(aColAAttr.y);   // raw Z delta
const gravDist    = sqrt(gravDirX.mul(gravDirX).add(gravDirZ.mul(gravDirZ)));
const gravEpsilon = float(0.001);
const gravSafeLen = max(gravDist, gravEpsilon);
const gravUnitX   = gravDirX.div(gravSafeLen);
const gravUnitZ   = gravDirZ.div(gravSafeLen);
// Per-cluster phase desync using the already-declared aClusterBurstSeedAttr
const gravPhase = aClusterBurstSeedAttr.mul(6.2832);
const gravSin   = sin(uTime.mul(uGravityRate).mul(6.2832).add(gravPhase));
// Guard: isLocked columns are message reveal columns — displacing them moves visible
// message characters off their intended position. Zero out the displacement.
// isLocked is declared before the density-cull If and is in scope here.
const gravDisp  = select(isLocked, float(0.0), gravSin.mul(uGravityStrength));
// Apply to colCenter (a toVar() vec3 — use addAssign with a full vec3)
colCenter.addAssign(vec3(gravUnitX.mul(gravDisp), float(0), gravUnitZ.mul(gravDisp)));
```

Note: `aColAAttr` is already declared at function-entry level (`const aColAAttr = attribute('aColA', 'vec4')`).
`aClusterBurstSeedAttr` is already declared at function-entry level.
`colCenter` is a `toVar()` result so `addAssign(vec3(...))` is valid TSL (same pattern as `colCenter.addAssign(right.mul(sway))`).

### Does gravity disturb `aSpawnTheta`?

No. `aSpawnTheta` is baked at geometry build time from the column's original `wx/wz` and is only
used for the spawn wave gate. Gravity displaces `colCenter` (the rendered billboard position);
it never modifies baked attributes.

### Does gravity disturb the shell structure at max strength?

At `uGravityStrength = 1.5` the displacement is at most 1.5 wu toward the cluster centroid.
Cluster centroids are averages of shell positions (within 3.5–8 wu of origin). No column
exceeds the far plane (60 wu). No NaN risk.

### Geometry rebuild required?

`aClusterCenter` is baked — any `rebuildGeom()` call regenerates it. No new `_geomParams` keys
are needed: the gravity uniforms are hot-swappable, and centroid computation uses existing
`_geomParams.clusterCount` implicitly via the existing round-robin logic.

### Handle methods

```js
setGravityStrength(v) { uniforms.uGravityStrength.value = Math.max(0, Math.min(1.5, v)); },
setGravityRate(v)     { uniforms.uGravityRate.value = Math.max(0.1, Math.min(0.5, v)); },
setGravity(strength, rate) {
  this.setGravityStrength(strength);
  if (rate !== undefined) this.setGravityRate(rate);
},
```

### Demo UI

```html
<label>Gravity strength
  <input type="range" id="s-gravity-strength" min="0" max="1.5" step="0.01" value="0">
  <input type="number" id="n-gravity-strength" min="0" max="1.5" step="0.01" value="0" style="width:54px">
</label>
<label>Gravity rate (Hz)
  <input type="range" id="s-gravity-rate" min="0.1" max="0.5" step="0.01" value="0.2">
  <input type="number" id="n-gravity-rate" min="0.1" max="0.5" step="0.01" value="0.2" style="width:54px">
</label>
```

JS (follows existing `linkSlider` pattern used throughout `demo.html`):
```js
linkSlider('gravity-strength', v => handle.setGravityStrength(v));
linkSlider('gravity-rate',     v => handle.setGravityRate(v));
```

---

## 2. Perspective Convergence

### Concept

Each billboard quad's center is shifted horizontally in clip space toward a configurable vanishing
point. Applied in the vertex shader immediately after `clipPos` is computed, inside the
`camDist3D.greaterThanEqual(1.5)` block. This produces convergence: columns left of the VP skew
right, columns right of the VP skew left.

### Implementation

The skew is applied in clip space. After `clipPos.assign(cameraProjectionMatrix.mul(viewPos4))`:

```
clipPos.x -= (aColAAttr.x - uPerspectiveWorldX) * uPerspectiveStrength * clipPos.w
```

The `clipPos.w` multiplication keeps the shift perspective-correct (homogeneous clip coords).
`aColAAttr.x` is the raw baked world X of the column (no `uColumnOffset` applied). The
`uPerspectiveWorldX` uniform is also in raw world X space. Both are raw, so no offset issue.

**Note on `uColumnOffset`**: the camera follow mode shifts the rendered columns via `aWX = aColAAttr.x + uColumnOffset.x`. But `clipPos` already incorporates `aWX` through `colCenter.x` → `worldPos` → `viewPos4`. The skew delta `(aColAAttr.x - uPerspectiveWorldX)` uses the raw column X. When column follow is active, the visual center of the rain shifts but `uPerspectiveWorldX` (in raw world space) stays put. This is acceptable — implementer should document that `setPerspective(cx)` should be recalled after changing `uColumnOffset` if a screen-center VP is desired.

### New uniforms

```js
uPerspectiveWorldX:   uniform(0.0),   // world X of vanishing point (raw, no offset); default = 0 (scene centre)
uPerspectiveStrength: uniform(0.0),   // skew strength 0–1; 0 = off
```

`uPerspectiveCenter` (screen UV vec2) is NOT a uniform — screen→world conversion happens in JS.

### Vertex shader insertion point

Insert immediately **after `clipPos.assign(cameraProjectionMatrix.mul(viewPos4))`** inside the
`If(camDist3D.greaterThanEqual(1.5), () => { ... })` block:

```js
// ── Perspective convergence skew ─────────────────────────────────────
// Shift clip.x toward the vanishing point in perspective-correct clip space.
// Positive (aColAAttr.x > VP) → positive perspDX → subtract → shift left toward VP.
// Clamped to ±1 wu so that NDC shift at strength=1.0 is at most ±1 (full screen edge).
// A column 1+ world unit from the VP at strength=1 reaches the screen edge — strength
// values above ~0.3 produce dramatic convergence for the default shell radius (~5.75 wu).
const perspDX   = clamp(aColAAttr.x.sub(uPerspectiveWorldX), float(-1.0), float(1.0));
const perspSkew = perspDX.mul(uPerspectiveStrength).mul(clipPos.w);
// Rebuild clipPos as a full vec4 — component-wise subAssign on a swizzle is not
// valid TSL; full vec4 reassignment via .assign() is the correct pattern.
clipPos.assign(vec4(
  clipPos.x.sub(perspSkew),
  clipPos.y,
  clipPos.z,
  clipPos.w,
));
```

`clipPos` is a `toVar()` result — `clipPos.assign(vec4(...))` is valid TSL (same as
`headY.assign(...)` pattern used elsewhere in the vertex Fn).

**Why this is inside the camDist block**: the sentinel `clipPos = (2,2,2,1)` at the top of the
vertex Fn must not be modified by the skew. Since the skew is inside the same `If` block where
`clipPos` gets its real value, culled instances are unaffected.

### Handle method

```js
setPerspective(strength, cx = 0.5, cy = 0.5) {
  // Convert screen UV cx to raw world X at approximate mean shell depth.
  const depth      = 5.75;   // mean shell radius (approximate mid-range)
  const halfFovTan = Math.tan((camera.fov * Math.PI / 180) / 2);
  const fullW      = 2 * halfFovTan * camera.aspect * depth;
  // Raw world X: offset from camera position in camera's local XZ frame.
  // For a stationary camera at z=6 looking at origin, position.x ≈ 0.
  uniforms.uPerspectiveWorldX.value   = (cx - 0.5) * fullW + camera.position.x;
  // Strength 0–1; perspDX is clamped to ±1 wu in the shader, so NDC shift at
  // strength=1 is at most ±1. Values above ~0.3 produce dramatic convergence.
  uniforms.uPerspectiveStrength.value = Math.max(0, Math.min(1, strength));
},
```

`camera` is in the `initMatrixRain` closure and is accessible to all handle methods.
The `cy` parameter is accepted for API symmetry but has no effect (skew is X-only).

### Interaction with wave offset

`waveOffset` displaces `lockedCellY` (world Y) — does not touch world X. Perspective convergence
only modifies `clipPos.x`. No conflict.

### Geometry rebuild required?

No. Both uniforms are hot-swappable.

### Demo UI

```html
<label>Perspective strength
  <input type="range" id="s-persp-strength" min="0" max="1" step="0.01" value="0">
  <input type="number" id="n-persp-strength" min="0" max="1" step="0.01" value="0" style="width:54px">
</label>
<label>Perspective center X (screen UV 0–1)
  <input type="range" id="s-persp-cx" min="0" max="1" step="0.01" value="0.5">
  <input type="number" id="n-persp-cx" min="0" max="1" step="0.01" value="0.5" style="width:54px">
</label>
```

JS:
```js
function updatePerspective() {
  handle.setPerspective(
    parseFloat(document.getElementById('s-persp-strength').value),
    parseFloat(document.getElementById('s-persp-cx').value),
  );
}
document.getElementById('s-persp-strength').addEventListener('input', updatePerspective);
document.getElementById('s-persp-cx').addEventListener('input', updatePerspective);
```

---

## 3. Morse Code Flicker

### Concept

Each column has a deterministic pattern (variable on-fraction and period) derived from a hash of
its column index. Glyph alpha pulses: during "on" windows alpha is unchanged; during "off" windows
alpha is reduced by `uMorseAmt`. No shader arrays required.

### Encoding approach

Rather than encoding actual Morse sequences (which requires per-pattern array access — invalid in
WGSL/TSL without explicit constant arrays), we use two hash values per column to produce varied
periodic patterns:

- `morsePeriodMul` ∈ {1, 2, 3, 4} — total cycle period multiplier (produces 4 distinct pattern speeds)
- `morseOnFrac` ∈ [0.15, 0.65] — what fraction of each period has the glyph at full alpha

Both are derived from a single `h2` hash of `aColIdx`. Each column gets a unique combination.
An additional `h2` hash gives per-column phase offset to desync columns.

### New uniforms

```js
uMorseRate: uniform(2.0),   // base cycle rate Hz; range [0.5, 4.0]
uMorseAmt:  uniform(0.0),   // modulation depth 0–1; 0 = off (no flicker)
```

No `uMorsePulse` — Morse timing is driven by `uTime` directly in the shader.

### Vertex shader insertion point

Insert **inside the boot cull `If(bootFadeVal.greaterThanEqual(0.001), () => { ... })` block,
immediately after the `vAlpha.assign(aAlpha.mul(alphaJitter).mul(zoneBrightBias).mul(clusterAlphaMul))`
line** (the only `vAlpha.assign(...)` inside the density-cull block):

```js
// ── Morse code flicker ───────────────────────────────────────────────
// Per-column pattern parameters derived from a single h2 hash:
//   morsePeriodMul ∈ {1,2,3,4}: four distinct period lengths
//   morseOnFrac    ∈ [0.15, 0.65]: fraction of period at full alpha
const morsePatHash   = h2(vec2(aColIdxAttr.mul(0.41).add(0.3), float(7.7)));
const morsePeriodMul = floor(morsePatHash.mul(4.0)).add(1.0);   // 1, 2, 3, or 4
const morseOnFrac    = fract(morsePatHash.mul(4.0)).mul(0.5).add(0.15);
const morseColPhase  = h2(vec2(aColIdxAttr.mul(0.17), float(0.33)));
const morseCycleT    = fract(
  uTime.mul(uMorseRate).div(morsePeriodMul).add(morseColPhase)
);
// morseOn = 1.0 in "on" window, 0.0 in "off" window
const morseOn     = step(morseCycleT, morseOnFrac);
// morseFactor: 1.0 when on, (1-uMorseAmt) when off → 0 = full silence, 1 = no change
const morseFactor = morseOn.add(float(1.0).sub(morseOn).mul(float(1.0).sub(uMorseAmt)));
// Guard: do not flicker locked head columns — message reveal chars must remain stable.
// isLocked is declared before the density-cull If and is in scope here.
const morseFinal  = select(isLocked, float(1.0), morseFactor);
// Use explicit .assign() on the varying — varyings in this codebase only use .assign(),
// not compound operators like mulAssign.
vAlpha.assign(vAlpha.mul(morseFinal));
```

### Interaction with message reveal lock state

`isLocked` is declared before the density-cull block and is accessible inside it. The `select`
guard ensures locked columns are never flickered.

The fragment stage also forces `rawBright = 1.0` for locked head cells — even if Morse somehow
dimmed `vAlpha`, the locked head brightness would override it. The `select` guard makes this
explicit and belt-and-braces safe.

### Geometry rebuild required?

No. Both uniforms are hot-swappable.

### Handle method

```js
setMorseFlicker(enabled, rate, amt) {
  if (amt !== undefined)       uniforms.uMorseAmt.value  = enabled ? Math.max(0, Math.min(1, amt)) : 0;
  else if (enabled === false)  uniforms.uMorseAmt.value  = 0;
  if (rate !== undefined)      uniforms.uMorseRate.value = Math.max(0.5, Math.min(4.0, rate));
},
```

### Demo UI

```html
<label>Morse flicker amount
  <input type="range" id="s-morse-amt" min="0" max="1" step="0.01" value="0">
  <input type="number" id="n-morse-amt" min="0" max="1" step="0.01" value="0" style="width:54px">
</label>
<label>Morse rate (Hz)
  <input type="range" id="s-morse-rate" min="0.5" max="4" step="0.1" value="2">
  <input type="number" id="n-morse-rate" min="0.5" max="4" step="0.1" value="2" style="width:54px">
</label>
```

JS:
```js
linkSlider('morse-amt',  v => handle.setMorseFlicker(v > 0, undefined, v));
linkSlider('morse-rate', v => handle.setMorseFlicker(undefined, v));
```

---

## 4. Spiral Formation

### Concept

Each column's rendered world XZ center is rotated around the world Y axis (origin XZ = 0,0)
additively over time. `aSpawnTheta` (already baked, normalised [0,1] angular position) provides
the per-column angular offset that creates the spiral winding. The displacement is additive to
`colCenter`; the billboard facing angle is unaffected (still camera-facing from `aWX/aWZ`).

### Orbit geometry

```
spiralA  = uTime * uSpiralRate + aSpawnTheta * uSpiralPitch
newX     = aColAAttr.x * cos(spiralA) - aColAAttr.y * sin(spiralA)
newZ     = aColAAttr.x * sin(spiralA) + aColAAttr.y * cos(spiralA)
offsetX  = (newX - aColAAttr.x) * uSpiralAmt
offsetZ  = (newZ - aColAAttr.y) * uSpiralAmt
```

The rotation uses **raw** `aColAAttr.x/y` (no `uColumnOffset`). The axis of rotation is at
the raw world origin (0, 0). When column follow mode is active, the rendered columns orbit
around the raw origin, not the camera position. This is acceptable; the effect is still visually
coherent. It is consistent with how gravity wells use raw positions.

At `uSpiralAmt = 1` the orbit radius equals the column's raw shell radius (up to 8 wu). Maximum
world extent from raw origin is 2× shell radius ≈ 16 wu, well within the far plane (60 wu).
No NaN or overflow risk.

At `uSpiralAmt = 0` the displacement is exactly zero (identity).

### Conflict with wave offset

`waveOffset` is applied to `lockedCellY` (world Y only). Spiral displaces `colCenter.x` and
`colCenter.z` only. No conflict; they compose additively.

### Conflict with sway

Sway adds a vec3 to `colCenter` in the direction of `right`. Spiral adds a vec3 to `colCenter`
in the world XZ plane. Both are `addAssign` calls on the same `colCenter` toVar — they compose
correctly.

### New uniforms

```js
uSpiralAmt:   uniform(0.0),         // orbital amplitude 0–1; 0 = off
uSpiralRate:  uniform(0.1),         // angular velocity rad/s; range [0, 0.5]
uSpiralPitch: uniform(Math.PI),     // angular phase spread per unit of aSpawnTheta [0–2π]
                                    // π (default) = 180° phase difference across the full shell
```

### Vertex shader insertion point

Insert inside the **trail window cull** block, **after the gravity well block** (i.e. after
`colCenter.addAssign(vec3(...gravity...))`) and **before the Z-rotation block**:

```js
// ── Spiral formation ─────────────────────────────────────────────────
// Rotate the column's raw world XZ position around the Y axis.
// aSpawnTheta ∈ [0,1] provides the per-column angular offset (spiral winding).
// Use raw aColAAttr.x/y (not aWX/aWZ) so the rotation axis stays at the
// raw world origin — consistent with gravity well raw-space convention.
const spiralA   = uTime.mul(uSpiralRate).add(aSpawnThetaAttr.mul(uSpiralPitch));
const cosSpiral = cos(spiralA);
const sinSpiral = sin(spiralA);
const spiralNewX = aColAAttr.x.mul(cosSpiral).sub(aColAAttr.y.mul(sinSpiral));
const spiralNewZ = aColAAttr.x.mul(sinSpiral).add(aColAAttr.y.mul(cosSpiral));
// Guard: isLocked columns are message reveal columns. Orbiting them would move visible
// message characters away from their intended world position. Zero amplitude for locked.
const spiralAmt = select(isLocked, float(0.0), uSpiralAmt);
const spiralDX  = spiralNewX.sub(aColAAttr.x).mul(spiralAmt);
const spiralDZ  = spiralNewZ.sub(aColAAttr.y).mul(spiralAmt);
colCenter.addAssign(vec3(spiralDX, float(0), spiralDZ));
```

`aSpawnThetaAttr` is already declared at function-entry level:
`const aSpawnThetaAttr = attribute('aSpawnTheta', 'float')`.
`colCenter.addAssign(vec3(...))` matches the existing sway pattern exactly.

### Does spiral affect `vColCenterX`?

`vColCenterX` is assigned from `aColAAttr.x.add(uColumnOffset.x)` (raw + offset) — the baked
world X. It is used in the fragment stage for message reveal Y-band suppression. Spiral changes
the rendered billboard position (`colCenter`) but not `vColCenterX`. This is correct: message
reveal works with baked positions, not rendered positions.

### Geometry rebuild required?

No. All three uniforms are hot-swappable.

### Handle method

```js
setSpiral(amt, rate, pitch) {
  uniforms.uSpiralAmt.value = Math.max(0, Math.min(1, amt));
  if (rate  !== undefined) uniforms.uSpiralRate.value  = Math.max(0, Math.min(0.5, rate));
  if (pitch !== undefined) uniforms.uSpiralPitch.value = Math.max(0, Math.min(Math.PI * 2, pitch));
},
```

### Demo UI

```html
<label>Spiral amount
  <input type="range" id="s-spiral-amt" min="0" max="1" step="0.01" value="0">
  <input type="number" id="n-spiral-amt" min="0" max="1" step="0.01" value="0" style="width:54px">
</label>
<label>Spiral rate (rad/s)
  <input type="range" id="s-spiral-rate" min="0" max="0.5" step="0.01" value="0.1">
  <input type="number" id="n-spiral-rate" min="0" max="0.5" step="0.01" value="0.1" style="width:54px">
</label>
<label>Spiral pitch (rad)
  <input type="range" id="s-spiral-pitch" min="0" max="6.283" step="0.01" value="3.14">
  <input type="number" id="n-spiral-pitch" min="0" max="6.283" step="0.01" value="3.14" style="width:54px">
</label>
```

JS:
```js
function updateSpiral() {
  handle.setSpiral(
    parseFloat(document.getElementById('s-spiral-amt').value),
    parseFloat(document.getElementById('s-spiral-rate').value),
    parseFloat(document.getElementById('s-spiral-pitch').value),
  );
}
['s-spiral-amt', 's-spiral-rate', 's-spiral-pitch'].forEach(id =>
  document.getElementById(id).addEventListener('input', updateSpiral)
);
```

---

## Summary of changes

### `matrix-rain-tsl.js`

| Change | Location |
|--------|---------|
| Add `uGravityStrength`, `uGravityRate` to `makeUniforms()` return object | `makeUniforms()` |
| Add `uPerspectiveWorldX`, `uPerspectiveStrength` to `makeUniforms()` | `makeUniforms()` |
| Add `uMorseRate`, `uMorseAmt` to `makeUniforms()` | `makeUniforms()` |
| Add `uSpiralAmt`, `uSpiralRate`, `uSpiralPitch` to `makeUniforms()` | `makeUniforms()` |
| Destructure 9 new uniforms in `buildGlyphMaterial()` | top of `buildGlyphMaterial()` |
| Gravity well: `attribute('aClusterCenter', 'vec2')` + XZ `colCenter` displacement | vertex Fn, inside trail-window If, after sway |
| Spiral: XZ rotation applied to `colCenter` | vertex Fn, inside trail-window If, after gravity |
| Perspective: `clipPos.assign(vec4(clipPos.x.sub(perspSkew), ...))` | vertex Fn, inside camDist If, after `clipPos.assign(...)` |
| Morse: `vAlpha.assign(vAlpha.mul(morseFinal))` with `isLocked` guard | vertex Fn, inside boot-fade If, after `vAlpha.assign(...)` |

### `matrix-rain-webgpu.js`

| Change | Location |
|--------|---------|
| Two-pass centroid computation after main column loop | `buildGeometry()` |
| Allocate `clusterCenterBuf` (`Float32Array(total * 2)`) and fill it | `buildGeometry()` |
| `geom.setAttribute('aClusterCenter', ...)` | `buildGeometry()`, alongside other `setAttribute` calls |
| Fill `aClusterCenter` for reserve pool columns | reserve pool loop in `buildGeometry()` |
| Add `setGravityStrength(v)`, `setGravityRate(v)`, `setGravity(s, r?)` | handle object |
| Add `setPerspective(strength, cx?, cy?)` | handle object |
| Add `setMorseFlicker(enabled, rate?, amt?)` | handle object |
| Add `setSpiral(amt, rate?, pitch?)` | handle object |

### `demo.html`

Add sliders for all 9 new uniform values in appropriate UI sections.

---

## Uniform defaults summary

| Uniform | Default | Type | Range | Effect off when |
|---------|---------|------|-------|----------------|
| `uGravityStrength` | `0.0` | float | 0–1.5 wu | = 0 |
| `uGravityRate` | `0.2` | float | 0.1–0.5 Hz | N/A (rate only matters when strength > 0) |
| `uPerspectiveWorldX` | `0.0` | float | world X | N/A (only matters when strength > 0) |
| `uPerspectiveStrength` | `0.0` | float | 0–1 | = 0 |
| `uMorseRate` | `2.0` | float | 0.5–4.0 Hz | N/A (rate only matters when amt > 0) |
| `uMorseAmt` | `0.0` | float | 0–1 | = 0 |
| `uSpiralAmt` | `0.0` | float | 0–1 | = 0 |
| `uSpiralRate` | `0.1` | float | 0–0.5 rad/s | N/A (rate only matters when amt > 0) |
| `uSpiralPitch` | `π` | float | 0–2π rad | N/A (pitch only matters when amt > 0) |

---

## Review history

### Round 1 review

**Issues found and fixed:**

1. **Gravity: division-by-zero when column is at cluster centroid** — Added `gravEpsilon = 0.001`
   and `gravSafeLen = max(gravDist, gravEpsilon)`. When distance is zero the direction components
   become `(0/0.001)` ≈ 0, which when multiplied by `gravDisp` produces a negligible displacement.
   Visually correct.

2. **Gravity: centroid computation order** — Centroid accumulation must happen after the main
   column loop fills `colABuf`. Spec now makes this explicit with a "two-pass, after the main
   column loop" note.

3. **Gravity: `gravDirX` must use raw `aColAAttr.x`, not offset-adjusted `aWX`** — `aClusterCenter`
   stores raw coordinates. Using `aWX = aColAAttr.x + uColumnOffset.x` against a raw centroid
   would produce a biased direction when column follow mode is active. Fix: use `aColAAttr.x`
   and `aColAAttr.y` for the direction computation. The direction delta is the same in raw and
   offset-adjusted spaces (offset cancels), so this is mathematically equivalent and avoids any
   inconsistency.

4. **Gravity: insertion must be inside the trail-window cull If block** — `colCenter` is only
   declared inside `If(dist.greaterThanEqual(-0.5)...)`. Spec now explicitly states the nesting
   level.

5. **Perspective: component-wise swizzle mutation** — `clipPos.x.subAssign(...)` is NOT valid
   TSL (swizzle of a toVar is a new node, not mutably addressable). Fixed: use
   `clipPos.assign(vec4(clipPos.x.sub(perspSkew), clipPos.y, clipPos.z, clipPos.w))` — the
   same full-vec4 reassignment pattern used for `headY.assign(select(...))` in the vertex Fn.

6. **Perspective: `uPerspectiveCenter` screen UV converted to world X in JS** — Removed the
   screen UV vec2 uniform. `setPerspective(strength, cx)` does the conversion using `camera.fov`,
   `camera.aspect`, and `camera.position.x`. Camera is in the closure.

7. **Morse: `uMorsePulse` removed** — `uTime` is already updated every frame in `tick()`.
   Computing Morse timing from `uTime` in the shader is simpler and avoids a redundant uniform.

8. **Morse: must be inside density-cull AND boot-fade If blocks** — The `vAlpha.assign(...)`
   this inserts after is at line 316, inside both the density-cull and boot-fade `If` blocks.
   Spec now explicitly states the insertion is inside the boot-fade block.

9. **Morse: `isLocked` guard added** — Locked columns (message reveal) must not flicker.
   `select(isLocked, float(1.0), morseFactor)` ensures locked columns get morseFactor = 1.

10. **Spiral: TSL component assignment** — Cannot use `colCenter.x.addAssign(...)` on a
    swizzle. Must use `colCenter.addAssign(vec3(dx, 0, dz))` — same pattern as sway. Fixed.

11. **Spiral: uses raw `aColAAttr.x/y` not offset-adjusted `aWX/aWZ`** — Consistent with
    gravity well convention and avoids offset-dependent rotation axis.

12. **WGSL culling constraint** — Verified: no `Return()` calls inside `If()` blocks for any
    new effect. All effects are additive modifications. The sentinel `clipPos = (2,2,2,1)` is
    unmodified for culled instances.

13. **Handle naming conflicts** — `setGravity`, `setGravityStrength`, `setGravityRate`,
    `setPerspective`, `setMorseFlicker`, `setSpiral` — none conflict with any existing handle
    method in the CLAUDE.md API table.

14. **`_geomParams` rebuild coverage** — `aClusterCenter` is generated entirely from
    `_geomParams.clusterCount` and the round-robin assignment already in `buildGeometry()`.
    No new `_geomParams` keys needed. Any existing rebuild trigger (e.g. `setClusterParams`,
    `setSquadSize`) correctly regenerates `aClusterCenter`.

### Round 2 review

**Issues found and fixed:**

15. **Gravity: `clusterCenterBuf` must be allocated BEFORE the reserve pool loop** — The reserve
    pool loop writes into `clusterCenterBuf`. The allocation and Pass 1/2/3 centroid computation
    must complete before the reserve pool loop runs. Spec ordering already reflects this: the
    centroid computation is described as happening after the main column loop, before the reserve
    pool section. Confirmed correct.

16. **Gravity: `clusterCount2` vs. `clusterCount` naming** — Used `clusterCount2` in the spec
    pseudocode to avoid collision with the existing `clusterColCount` variable inside
    `buildGeometry()`. The spec is unambiguous.

17. **Spiral: `aSpawnThetaAttr` declaration scope** — `aSpawnThetaAttr` is declared at the
    function-entry level of the vertex Fn (line ~170 in current codebase). It is in scope
    throughout all nested `If` blocks including the trail-window cull block where the spiral
    code goes.

18. **Spiral: at `uSpiralPitch = 2π`, full phase wrap** — A column at `aSpawnTheta = 1.0`
    gets `spiralA = uTime*rate + 2π`, which is identical to `spiralA = uTime*rate + 0` (full
    wrap). So `uSpiralPitch = 2π` is visually equivalent to `uSpiralPitch = 0` (all columns
    orbit in phase). Default `π` gives a half-turn phase spread: columns on opposite sides of
    the shell counter-rotate, producing an elegant vortex. This is the intended aesthetic.

19. **Perspective: `clipPos.x.subAssign` inside camDist If — confirmed structure** — The camDist
    `If` block currently contains only `vDepthDim.assign(...)` and `clipPos.assign(...)`. The
    perspective line goes after `clipPos.assign(...)`, still inside this block. Confirmed.

20. **Morse: `morsePeriodMul` range** — `floor(h2 * 4) + 1` where h2 ∈ [0,1). `h2 * 4` ∈ [0,4).
    `floor(...)` ∈ {0,1,2,3}. `+1` gives {1,2,3,4}. Correct.

21. **Morse: `morseOnFrac` range** — `fract(h2 * 4) ∈ [0,1)`. `* 0.5 + 0.15` → [0.15, 0.65).
    This means no column is ever completely off (min 15% on fraction). Correct.

### Round 3 review

**Issues found and fixed:**

22. **Morse: `vAlpha.mulAssign()` not used on varyings in this codebase** — Grep of `matrix-rain-tsl.js`
    shows varyings (`vAlpha`, `vDeathFade`, `vBurst` etc.) exclusively use `.assign()` for
    mutation. `mulAssign` exists on `toVar()` results but may not work on `varying()` nodes.
    Fixed: changed to `vAlpha.assign(vAlpha.mul(morseFinal))` which is unambiguously valid.

23. **Perspective: `clipPos.x.subAssign()` on swizzle not valid** — Component swizzles of
    `toVar()` vectors are read-only references in TSL. Fixed: use `clipPos.assign(vec4(...))` to
    rebuild the full clip position vector.

**Remaining checks — all pass:**

- No `Return()` inside `If()` in vertex Fn for any new effect. ✓
- All new attributes declared with correct types (`'vec2'` for `aClusterCenter`, existing
  `'float'` attributes reused for spiral and morse). ✓
- `clusterCenterBuf` is `Float32Array(total * 2)` where `total = nCols * N_ROWS`. ✓
- All uniform defaults produce zero net effect (effects off by default). ✓
- `aClusterCenter` is reset correctly on any `rebuildGeom()` call since it is generated inside
  `buildGeometry()`. ✓
- `vAlpha.assign(vAlpha.mul(morseFinal))` is inside both density-cull and boot-fade blocks,
  operating on the correctly initialized `vAlpha`. Uses `.assign()` (not `.mulAssign()`) since
  varyings in this codebase exclusively use `.assign()` for mutation. ✓
- Perspective `clipPos.assign(vec4(clipPos.x.sub(perspSkew), ...))` is inside the `camDist >= 1.5`
  block, after `clipPos` receives its real (non-sentinel) value. Uses full vec4 reassignment
  (not swizzle mutation) — correct TSL pattern. ✓
- Spiral and gravity both use raw `aColAAttr.x/y` (not offset-adjusted `aWX/aWZ`) for rotation
  and direction computation, consistently with how the baked `aClusterCenter` stores raw coords. ✓

### Round 4 review

**Issues found and fixed:**

24. **Gravity: Pass 1 centroid loop included reserve columns** — Reserve columns (c ≥ reserveStart)
    are evenly redistributed around the shell, not clustered. With the default 48 reserves and
    12 clusters, each cluster absorbed 4 spurious evenly-distributed positions, biasing centroids
    ~8% away from their true angular center. Fixed: Pass 1 loop bound changed from `nCols` to
    `reserveStart2 = nCols - spawnReserves`. Pass 3 (buffer fill) still loops over all `nCols`
    since reserve entries are overwritten in the reserve pool loop anyway.

25. **Gravity: centroid computation placement** — Passes 1–3 must run BEFORE the reserve pool loop
    because the reserve loop writes centroid entries into `clusterCenterBuf`. This ordering was
    already correct (spec says "after the main column loop"), and is preserved after Issue 24 fix:
    since reserves are excluded from Pass 1, the centroid values are purely from regular columns
    regardless of whether the reserve loop has run. Round 2 item 15 confirmed this ordering. ✓

26. **Perspective: `perspDX` clamp of ±3 wu produced extreme off-screen skew** — At strength=1.0
    and ±3 wu clamp, the NDC shift reached ±3 (three screen widths off-screen). Practical usable
    range was 0–0.1. Fixed: clamp reduced to ±1 wu, giving NDC shift ≤ ±1.0 at full strength.
    Columns 1+ wu from the VP reach the screen edge at strength=1; values above ~0.3 are dramatic.
    Handle range remains 0–1; the tighter clamp makes the full range usable.
- `colCenter.addAssign(vec3(...))` pattern is used for both gravity and spiral, matching the
  existing `colCenter.addAssign(right.mul(sway))` pattern in the codebase. ✓

### Round 5 review

**Issues found and fixed:**

27. **Gravity: no `isLocked` guard — message reveal characters displaced** — Gravity displaces
    `colCenter` (the billboard XZ center) for all columns including `isLocked` ones. During a
    message reveal, locked columns display message characters at specific world positions. Pulling
    them toward their cluster centroid moves those characters sideways, corrupting the reveal.
    Fixed: `gravDisp` wrapped in `select(isLocked, float(0.0), gravSin.mul(uGravityStrength))`.
    `isLocked` is declared at line 336, before the density-cull block, and is in scope here. ✓

28. **Spiral: no `isLocked` guard — message reveal characters orbited** — Same issue. Spiral
    rotates `colCenter` XZ around the world Y axis, which would orbit message characters away from
    their intended position during reveal. Fixed: `uSpiralAmt` replaced with
    `select(isLocked, float(0.0), uSpiralAmt)` so locked columns have zero spiral amplitude.

**Remaining checks — all pass:**

- Cat A shimmer (lines 530–541) already uses `select(isVertLockHead, float(0.0), shimmerDisp)` —
  suppresses shimmer on the locked head cell only. Gravity and spiral now suppress on the entire
  locked column (`isLocked`), which is correct since `colCenter` XZ is shared by all rows. ✓
- `isLocked` is in scope inside the trail-window cull block (declared at line 336 before all
  `If` blocks). ✓
- `isSpawnActive` reserve columns active during message reveal also have `isLocked = true`
  (their `aLockState.z` component is set when claimed), so the guard covers them. ✓

### Round 6 review

**Issues found and fixed:**

29. **`setMorseFlicker`: `!enabled` is truthy when `enabled = undefined`** — The demo rate slider
    calls `handle.setMorseFlicker(undefined, v)` (enabled=undefined, rate=v, amt=undefined).
    The `else if (!enabled)` branch evaluates `!undefined === true` and zeros out `uMorseAmt`,
    silencing the effect every time the rate slider is adjusted. Fixed: `else if (!enabled)` →
    `else if (enabled === false)` so only an explicit `false` triggers the disable path.
    Call patterns:
    - `setMorseFlicker(v > 0, undefined, v)` — amount slider: sets amount, rate unchanged ✓
    - `setMorseFlicker(undefined, v)` — rate slider: sets rate only, amount unchanged ✓
    - `setMorseFlicker(false)` — explicit disable: zeros amount ✓

**Remaining checks — all pass:**

- No further logic bugs found in any of the four effects' shader snippets, handle methods,
  geometry code, or demo UI. ✓
