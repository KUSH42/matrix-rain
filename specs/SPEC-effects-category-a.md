# SPEC — Effects Category A: Per-Glyph Shader Effects

**Status**: Implemented
**File**: `specs/SPEC-effects-category-a.md`

---

## Overview

Five new visual effects implemented entirely within the TSL glyph shader pipeline. No new
geometry, no new post-processing passes, no new attributes except for Effect 5
(`aHeadOvershoot`). All effects are additive to the existing shader and isolated to their
own uniform guard so they are zero-cost when disabled.

| # | Name | Uniforms added | Attribute added |
|---|---|---|---|
| 1 | Lateral shimmer | `uShimmerAmt`, `uShimmerFreq` | — |
| 2 | Inverted/negative glyphs | `uInversionChance` | — |
| 3 | Glyph rotation | `uGlyphSpinAmt`, `uGlyphSpinSpeed` | — |
| 4 | Per-column hue drift | `uHueDriftRate`, `uHueDriftAmt` | — |
| 5 | Head overshoot | `uHeadOvershootAmt` | `aHeadOvershoot` (float) |

---

## Scope

| File | Changes |
|---|---|
| `matrix-rain-tsl.js` | 8 new uniforms in `makeUniforms()`; 1 new `hueRotateRGB` helper `Fn` at module scope; 1 new attribute read in `buildGlyphMaterial()` vertex Fn; 5 shader effect blocks inserted at precise locations in vertex/fragment Fns |
| `matrix-rain-webgpu.js` | 8 new handle methods; `aHeadOvershoot` buffer built in `buildGeometry()`; attribute set on `geom` |
| `demo.html` | Sliders in a new "Glyph FX B" sub-panel |

**Not changed**: `matrix-rain-passes-tsl.js`, `matrix-rain-presets.js`

---

## Effect 1 — Lateral Shimmer

### Motivation

Columns oscillate left-right along the billboard's `right` axis, simulating thermal
refraction. Amplitude is fullest at the head and decays exponentially into the trail.
Locked message-reveal head cells are suppressed so message characters stay still.

### Uniforms

| Uniform | Type | Default | Range | Description |
|---|---|---|---|---|
| `uShimmerAmt` | `float` | `0.0` | 0–0.15 | Peak lateral displacement in world units (0 = off) |
| `uShimmerFreq` | `float` | `2.0` | 0.5–8.0 | Shimmer oscillation base frequency in Hz |

`uShimmerAmt = 0.0` keeps the effect fully off. `uShimmerFreq` is the global base; per-column
variation is derived from `aSeed` so no new attribute is needed.

### Shader insertion — vertex Fn

**Where**: After `colCenter.addAssign(right.mul(sway));`, before the `// Per-column Z-rotation`
comment. This is inside the trail-window cull block
(`If(dist.greaterThanEqual(-0.5).and(dist.lessThanEqual(maxVisible)), ...)`), where `colCenter`,
`right`, `dist`, and `isVertLockHead` are all in scope.

```js
// ── Lateral shimmer — thermal refraction oscillation ─────────────────
const shimmerFreqMul = float(0.7).add(
  h2(vec2(aSeed.mul(5.1), float(0.37))).mul(0.6)
); // per-column frequency multiplier ∈ [0.7, 1.3]
const shimmerPhase = h2(vec2(aSeed.mul(3.3), float(0.61))).mul(6.2832);
const shimmerDecay = exp(max(dist, 0.0).negate().mul(1.5));
const shimmerDisp  = select(isVertLockHead, float(0.0),
  sin(
    uTime.mul(uShimmerFreq).mul(shimmerFreqMul).mul(6.2832).add(shimmerPhase)
  ).mul(uShimmerAmt).mul(shimmerDecay)
);
colCenter.addAssign(right.mul(shimmerDisp));
```

The `select(isVertLockHead, ...)` guard suppresses shimmer on locked message-reveal head
cells so message characters do not oscillate laterally.

**Interactions**:
- Sway: both displace along `right`, additive. At `uShimmerAmt=0` there is zero interference.
- POM: operates in screen UV space, independent of `colCenter`. No interaction.
- Wave: `waveOffset` displaces world Y; shimmer displaces world X via `right`. Orthogonal.

### Handle methods

```js
setShimmerAmt(v)  { uniforms.uShimmerAmt.value  = Math.max(0, Math.min(0.15, v)); },
setShimmerFreq(v) { uniforms.uShimmerFreq.value = Math.max(0.5, Math.min(8.0, v)); },
```

### Demo UI

```html
<label>Shimmer Amt
  <input id="sl-shimmer-amt" type="range" min="0" max="0.15" step="0.005" value="0">
  <input type="number" min="0" max="0.15" step="0.005" value="0">
</label>
<label>Shimmer Freq
  <input id="sl-shimmer-freq" type="range" min="0.5" max="8.0" step="0.1" value="2.0">
  <input type="number" min="0.5" max="8.0" step="0.1" value="2.0">
</label>
```

---

## Effect 2 — Inverted/Negative Glyphs

### Motivation

Approximately 5 % of cells render with an inverted SDF mask — the glyph shape is treated
as "void" and the surrounding field as "ink". This simulates CRT phosphor burn and adds
visual density variation to the rain.

### Uniforms

| Uniform | Type | Default | Range | Description |
|---|---|---|---|---|
| `uInversionChance` | `float` | `0.0` | 0–1 | Fraction of cells rendered inverted (0 = off) |

Default `0.0` — off until the user enables it.

The inversion decision is per-cell and time-stable: it uses a hash of `cellId` so the same
cell always renders in the same mode (no flickering). Locked message-reveal head cells are
excluded from inversion via `.and(isLockHead.not())`.

### Prerequisite: make `mask` mutable

In the current fragment Fn, `mask` is declared as a `const` TSL node (immutable reference):

```js
const mask = smoothstep(float(0.5).sub(fw), float(0.5).add(fw), sdfG);
```

Change to `.toVar()` so `mask.assign()` is valid:

```js
const mask = smoothstep(float(0.5).sub(fw), float(0.5).add(fw), sdfG).toVar('mask');
```

Note: when Effect 3 (Glyph Rotation) is also applied, `sdfG` will use `spinFace` (see
Effect 3). The `.toVar('mask')` change is the same regardless; only the input `sdfG` differs.

### Shader insertion — fragment Fn

**Where**: After `If(mask.lessThan(0.01), () => { Discard(); });` and before the
`// ── Per-glyph chromatic aberration` comment.

```js
// ── Inverted/negative glyph cells ─────────────────────────────────────
// Per-cell stable hash — same cell is always normal or inverted.
const invertHash = h2(cellId.mul(0.83).add(0.11));
const isInverted = invertHash.lessThan(uInversionChance).and(isLockHead.not());
mask.assign(select(isInverted, float(1.0).sub(mask), mask));
```

`isLockHead` is declared earlier in the fragment Fn (after glyph selection), so it is in
scope at this insertion point.

**Interaction with discard**: The `If(mask < 0.01)` discard runs BEFORE inversion. After
inversion, background regions of inverted cells (original mask near 1.0) become near 0.0
and will be discarded in the second final `If(alpha < 0.015)` check — this is correct
behaviour. The glyph outline is rendered as "void" and background as "transparent".

**Interaction with chromatic aberration**: After inversion, `mask` is flipped but `rMask`
and `bMask` (sampled at the R/B-offset UVs) are not inverted. The `rMask.sub(mask)` delta
will have reversed sign for inverted cells — the R and B chroma fringing appears as negative
(blue where red would be and vice versa). This is an intentional aesthetic choice; the
inverted cell gets a negative-space chroma halo. No code change needed.

**Interaction with edge glow**: Edge glow uses `abs(sdfG - 0.5)`. `sdfG` is not modified by
inversion (only `mask` is). Since `abs(sdfG - 0.5)` is symmetric around 0.5, the edge glow
value is identical for inverted and normal cells. No interaction.

### Handle method

```js
setInversionChance(v) { uniforms.uInversionChance.value = Math.max(0, Math.min(1, v)); },
```

### Demo UI

```html
<label>Inversion Chance
  <input id="sl-inversion-chance" type="range" min="0" max="1" step="0.01" value="0">
  <input type="number" min="0" max="1" step="0.01" value="0">
</label>
```

---

## Effect 3 — Glyph Rotation

### Motivation

Individual cells spin around their own center axis with per-cell random phase and speed.
Rotation fades out into the trail via exponential decay so only head-adjacent cells spin
visibly. This simulates glyph mutation and symbol instability.

### Uniforms

| Uniform | Type | Default | Range | Description |
|---|---|---|---|---|
| `uGlyphSpinAmt` | `float` | `0.0` | 0–1 | Blend: 0 = no rotation, 1 = full rotation |
| `uGlyphSpinSpeed` | `float` | `1.0` | 0–2 | Rotation speed in Hz |

Default `uGlyphSpinAmt = 0.0` — off until enabled.

### Mechanism

Rotation is applied to the POM-displaced face UV (`finalFace`) before atlas sampling.
The UV is rotated around the cell centre (0.5, 0.5) by a per-cell angle that evolves over
time. Locked head cells are suppressed via `select(isLockHead, float(0.0), spinDecay)`.

Per-cell derivation:

```
perCellPhase  ∈ [0, 2π]  — h2(cellId * 0.59 + 0.07) * 6.2832
perCellSpeed  ∈ [0.6, 1.4] — 0.6 + h2(cellId * 0.41 + 0.03) * 0.8
spinDecay     = 0.0 if isLockHead; else exp(-d * 2.0)
spinAngle     = uTime * uGlyphSpinSpeed * perCellSpeed * 2π + perCellPhase
effectiveAngle = spinAngle * uGlyphSpinAmt * spinDecay
```

(`d = max(vDist, 0.0)` is already declared at the top of the fragment Fn.)

### Shader insertion — fragment Fn

**Where**: After `const finalFace = loFace.add(hiFace).mul(0.5);` and before the
`sdfG` sample line. This is after POM has produced the displaced UV.

```js
// ── Glyph rotation — per-cell spin around cell centre ─────────────────
const spinCellPhase = h2(cellId.mul(0.59).add(0.07)).mul(6.2832);
const spinCellSpeed = float(0.6).add(h2(cellId.mul(0.41).add(0.03)).mul(0.8));
const spinDecay     = select(isLockHead, float(0.0), exp(d.negate().mul(2.0)));
const spinAngle     = uTime.mul(uGlyphSpinSpeed).mul(spinCellSpeed).mul(6.2832)
  .add(spinCellPhase)
  .mul(uGlyphSpinAmt)
  .mul(spinDecay);
const cosA     = cos(spinAngle);
const sinA     = sin(spinAngle);
const cfCtr    = finalFace.sub(0.5);
const spinFace = clamp(
  vec2(
    cfCtr.x.mul(cosA).sub(cfCtr.y.mul(sinA)),
    cfCtr.x.mul(sinA).add(cfCtr.y.mul(cosA))
  ).add(0.5),
  0.005, 0.995
).toVar('spinFace');
```

`isLockHead` is declared earlier in the fragment Fn (after glyph selection) and is in scope here.

### Replace `finalFace` with `spinFace` downstream

Every occurrence of `finalFace` after this insertion must be replaced with `spinFace` so the
rotation propagates through all sampling:

```js
// 1. Main glyph sample (was: sampleGlyph(finalFace, glyphIdx, useSDF))
const sdfG = sampleGlyph(spinFace, glyphIdx, useSDF);

// 2. Chromatic aberration UVs (was: finalFace.x ± chromaOff)
const rUV = clamp(vec2(spinFace.x.add(chromaOff), spinFace.y), 0.005, 0.995);
const bUV = clamp(vec2(spinFace.x.sub(chromaOff), spinFace.y), 0.005, 0.995);

// 3. Normal map neighbour samples (was: finalFace.add(vec2(...)))
const mL = sampleGlyph(spinFace.add(vec2(eps.negate(), 0)), glyphIdx, useSDF);
const mR = sampleGlyph(spinFace.add(vec2(eps,           0)), glyphIdx, useSDF);
const mD = sampleGlyph(spinFace.add(vec2(0, eps.negate())), glyphIdx, useSDF);
const mU = sampleGlyph(spinFace.add(vec2(0, eps          )), glyphIdx, useSDF);
```

**Interactions**:
- POM: rotation is applied AFTER POM, so the parallax-displaced UV is rotated. The glyph
  appears to spin inside its depth-carved slot.
- Inversion: `sdfG` (and therefore `mask`) uses `spinFace`, so an inverted cell renders the
  rotated glyph inverted. Correct.
- Chromatic aberration: `rUV`/`bUV` derived from `spinFace`, so chroma fringing rotates with
  the glyph. Correct.
- Lock-head: `spinDecay = 0` → `spinAngle = 0` → `cosA = 1`, `sinA = 0` →
  `spinFace = clamp(cfCtr + 0.5) = finalFace`. No rotation. No extra sample cost beyond the
  one `select`.

### Handle methods

```js
setGlyphSpinAmt(v)   { uniforms.uGlyphSpinAmt.value   = Math.max(0, Math.min(1, v)); },
setGlyphSpinSpeed(v) { uniforms.uGlyphSpinSpeed.value = Math.max(0, Math.min(2, v)); },
```

### Demo UI

```html
<label>Glyph Spin Amt
  <input id="sl-glyph-spin-amt" type="range" min="0" max="1" step="0.01" value="0">
  <input type="number" min="0" max="1" step="0.01" value="0">
</label>
<label>Glyph Spin Speed
  <input id="sl-glyph-spin-speed" type="range" min="0" max="2" step="0.05" value="1">
  <input type="number" min="0" max="2" step="0.05" value="1">
</label>
```

---

## Effect 4 — Per-Column Hue Drift

### Motivation

Each column's colour slowly oscillates its hue angle over time, independently from other
columns, creating a slow colour-ecology feel. The hue drift is implemented as RGB rotation
around the luminance axis (1,1,1)/√3 using the Rodrigues rotation formula.

### Uniforms

| Uniform | Type | Default | Range | Description |
|---|---|---|---|---|
| `uHueDriftRate` | `float` | `0.0` | 0–0.5 | Hue drift oscillation frequency in Hz (0 = off) |
| `uHueDriftAmt` | `float` | `0.0` | 0–45 | Peak hue rotation in degrees (0 = off) |

Both default to `0.0` — the effect is fully off until enabled.

At `uHueDriftRate=0.1` Hz and `uHueDriftAmt=15°`, each column's hue oscillates ±15° around
its base colour, completing one oscillation cycle every 10 seconds.

### Module-scope helper — `hueRotateRGB`

Add the following to `matrix-rain-tsl.js` at module scope, alongside `h2` and `median3`.
Uses Rodrigues rotation around axis n = (1,1,1)/√3. All operations are scalar TSL chains —
no multi-component vector construction from swizzles, safe on all backends.

```js
// ── RGB hue rotation (Rodrigues around luminance axis) ───────────────
// Rotates hue by driftRad radians; preserves luminance and saturation.
// w = 1/sqrt(3), w² = 1/3. All scalar mul/add operations — TSL-backend-safe.
export const hueRotateRGB = Fn(([rgb, driftRad]) => {
  const cosH    = cos(driftRad);
  const sinH    = sin(driftRad);
  const w2      = float(1.0 / 3.0);           // w² = 1/3
  const wsqrt3  = float(1.0 / Math.sqrt(3));  // w  = 1/sqrt(3)
  const diag    = cosH.mul(float(2.0 / 3.0)).add(w2); // cos(θ)·2/3 + 1/3
  const cross_p = w2.mul(float(1.0).sub(cosH)).add(wsqrt3.mul(sinH));
  const cross_m = w2.mul(float(1.0).sub(cosH)).sub(wsqrt3.mul(sinH));
  const nr = rgb.r.mul(diag).add(rgb.g.mul(cross_m)).add(rgb.b.mul(cross_p));
  const ng = rgb.r.mul(cross_p).add(rgb.g.mul(diag)).add(rgb.b.mul(cross_m));
  const nb = rgb.r.mul(cross_m).add(rgb.g.mul(cross_p)).add(rgb.b.mul(diag));
  return vec3(nr, ng, nb);
});
```

Matrix derivation:
```
diag    = cos(θ)·2/3 + 1/3
cross_p = (1−cos(θ))/3 + sin(θ)/√3
cross_m = (1−cos(θ))/3 − sin(θ)/√3

R' = R·diag    + G·cross_m + B·cross_p
G' = R·cross_p + G·diag    + B·cross_m
B' = R·cross_m + G·cross_p + B·diag
```

This preserves the grey axis (R=G=B → diag + cross_p + cross_m = 1), meaning a perfectly
grey colour never shifts hue regardless of angle.

`hueRotateRGB` must be imported into the destructure in `buildGlyphMaterial` or called
directly since it is in the same module file.

### Prerequisite: make `tintedColor` mutable

In the current fragment Fn, `tintedColor` is a `const` node (immutable). Change to `.toVar()`:

```js
// Was:
const tintedColor = mix(uColor, uColor2, blendT);
// Change to:
const tintedColor = mix(uColor, uColor2, blendT).toVar('tintedColor');
```

### Shader insertion — fragment Fn

**Where**: After `const tintedColor = mix(uColor, uColor2, blendT).toVar('tintedColor');`
and before `// Color: head burns white, trail has two-stage ramp down`.

`isLockHead` is declared earlier in the fragment Fn (after glyph selection) and is in scope.

```js
// ── Per-column hue drift ────────────────────────────────────────────────
// cellId.x = floor(vColIdx + 0.5) — a stable per-column integer in the fragment stage.
// driftPhase and driftSpeed use only cellId.x so all rows of a column share the same drift.
const driftPhase = h2(vec2(cellId.x.mul(0.29), float(0.07))).mul(6.2832);
const driftSpeed = float(0.5).add(h2(vec2(cellId.x.mul(0.41), float(0.19))));
// Sine oscillation: drift angle swings ±uHueDriftAmt degrees at uHueDriftRate Hz.
// Wrapped by select so locked head cells never shift hue (message chars stay their base colour).
const driftRadFull = sin(
  uTime.mul(uHueDriftRate).mul(driftSpeed).mul(6.2832).add(driftPhase)
).mul(uHueDriftAmt.mul(float(Math.PI / 180)));
const driftRad = select(isLockHead, float(0.0), driftRadFull);
tintedColor.assign(hueRotateRGB(tintedColor, driftRad));
```

`hueRotateRGB` is available in the same module file and can be called directly inside the
fragment `Fn` closure.

**Interactions**:
- Existing hue blend (`uHueRange`/`uColor2`): drift is applied to the post-blend
  `tintedColor`. Both systems are layered and orthogonal.
- Head burn: the head burn and trail colour ramp reference `tintedColor` after drift, so
  the drifted colour propagates to all colour computations downstream. Correct.
- Lock-head: `driftRad = 0.0` → `hueRotateRGB(color, 0)` returns `color` unchanged
  (identity rotation: cosH=1, sinH=0 → diag=1, cross_p=0, cross_m=0).
- Grain and lighting: both use `tintedColor` downstream and will receive the drifted colour.

### Handle methods

```js
setHueDriftRate(v) { uniforms.uHueDriftRate.value = Math.max(0, Math.min(0.5, v)); },
setHueDriftAmt(v)  { uniforms.uHueDriftAmt.value  = Math.max(0, Math.min(45, v)); },
```

### Demo UI

```html
<label>Hue Drift Rate
  <input id="sl-hue-drift-rate" type="range" min="0" max="0.5" step="0.01" value="0">
  <input type="number" min="0" max="0.5" step="0.01" value="0">
</label>
<label>Hue Drift Amt
  <input id="sl-hue-drift-amt" type="range" min="0" max="45" step="1" value="0">
  <input type="number" min="0" max="45" step="1" value="0">
</label>
```

---

## Effect 5 — Head Overshoot

### Motivation

Column heads occasionally surge forward by up to `uHeadOvershootAmt` cell-lengths, then
fall back. The surge is driven by a per-column Gaussian pulse keyed to the 4-second burst
cycle (staggered by `aHeadOvershoot` phase), applied to `headY` before the trail distance
calculation. Locked message-reveal columns are excluded.

### Attribute

| Attribute | Type | Layout | Description |
|---|---|---|---|
| `aHeadOvershoot` | `float` | Per-instance (replicated N_ROWS times per column) | Phase offset ∈ [0, 1] for the overshoot pulse |

Baked at `buildGeometry()` time with `Math.random()`. Static — no rebuild needed for
`uHeadOvershootAmt` changes.

### Uniforms

| Uniform | Type | Default | Range | Description |
|---|---|---|---|---|
| `uHeadOvershootAmt` | `float` | `0.0` | 0–3 | Maximum overshoot in cell-step units (0 = off) |

### Overshoot mechanism

The surge shape is a Gaussian pulse centred at 12 % of the 4-second burst cycle, with
σ = 0.03 (in phase units ≈ 0.12 s wide at 1σ). The displacement is in the direction of
head travel so it looks like the column is accelerating forward briefly:

```
overPhase   = fract(uTime / 4.0 + aHeadOvershoot)   -- [0, 1] staggered
overPulse   = exp(-(overPhase - 0.12)² / 0.0018)    -- Gaussian, 2σ² = 0.0018
overDisplace = overPulse * uHeadOvershootAmt * cellStep
direction   = -1 for normal columns (downward), +1 for reversed columns
headY      += direction * overDisplace               (suppressed on locked columns)
```

### Shader insertion — vertex Fn

**Where**: After `headY.assign(select(isLocked, aLockStateAttr.x, headY));` (the lock-freeze
line) and after `vDeathFade.assign(select(isLocked, float(1.0), vDeathFade));`, and before
the `// Signed trail distance` comment. At this point `isLocked`, `isRev`, `cellStep`, and
`headY` (as a `.toVar()`) are all in scope.

```js
// ── Head overshoot — bounce inertia surge ─────────────────────────────
const aHeadOvershootAttr = attribute('aHeadOvershoot', 'float');
const overPhase   = fract(uTime.div(float(4.0)).add(aHeadOvershootAttr));
// Gaussian pulse: peak at overPhase=0.12, σ=0.03 (2σ²=0.0018)
const overPulse   = exp(
  overPhase.sub(0.12).mul(overPhase.sub(0.12)).negate().div(float(0.0018))
);
const overDisplace = overPulse.mul(uHeadOvershootAmt).mul(cellStep);
// Forward direction: downward columns → negative headY delta; reversed → positive
const overSign = select(isRev, float(1.0), float(-1.0));
// Locked columns: overshoot suppressed (headY already pinned by lock-freeze)
headY.assign(select(isLocked, headY,
  headY.add(overSign.mul(overDisplace))
));
```

Note: `overPhase.sub(0.12).mul(overPhase.sub(0.12))` computes `(overPhase - 0.12)²` without
using `.pow()`, avoiding any WGSL `pow` precision concerns with small exponents near zero.

**Interactions**:
- Lock-freeze: `select(isLocked, headY, ...)` ensures locked columns are never displaced.
- Death fade: death fade uses `cyclePhase = cyclePos/cycleH` which is unaffected by `headY`.
  Death fade operates correctly on overshoot columns.
- Trail distance: `dist = (cellY - headY) / cellStep`. Overshoot shifts `headY`, so the
  visible trail window shifts with the head — correct. The column's trail follows the surge.
- Wave: `waveOffset` shifts rendered Y position (applied in the placement block). Overshoot
  shifts `headY` (affects dist). They operate on different outputs. No conflict.
- Lock-head vertical snap: the lock-head cell range uses `dist ∈ [-0.5, 0.5)` after headY is
  set. Overshoot is suppressed on locked columns, so the lock-head range is unaffected.

### Geometry — `buildGeometry()`

Add after the `spawnThetaBuf` declaration and fill loop, before the `geom.setAttribute`
calls:

```js
// aHeadOvershoot: per-column phase for overshoot pulse [0, 1], replicated per row
const headOvershootBuf = new Float32Array(total);
for (let c = 0; c < nCols; c++) {
  const ov = Math.random();
  for (let row = 0; row < N_ROWS; row++) {
    headOvershootBuf[c * N_ROWS + row] = ov;
  }
}
```

Add to `geom.setAttribute` block:

```js
geom.setAttribute('aHeadOvershoot', new THREE.InstancedBufferAttribute(headOvershootBuf, 1));
```

No additions to `_geomParams` — the attribute is purely randomised phase, not dependent on
any user-controlled geometry parameter.

### Handle method

```js
setHeadOvershootAmt(v) { uniforms.uHeadOvershootAmt.value = Math.max(0, Math.min(3, v)); },
```

### Demo UI

```html
<label>Head Overshoot
  <input id="sl-head-overshoot" type="range" min="0" max="3" step="0.05" value="0">
  <input type="number" min="0" max="3" step="0.05" value="0">
</label>
```

---

## `makeUniforms()` additions

Add the following entries to the return object of `makeUniforms()` in `matrix-rain-tsl.js`.
Slot them inside the existing Glyph FX controls block (after `uContagionStrength`):

```js
// Category A glyph effects
uShimmerAmt:       uniform(0.0),   // lateral shimmer amplitude (world units)  0–0.15
uShimmerFreq:      uniform(2.0),   // shimmer base frequency Hz                0.5–8.0
uInversionChance:  uniform(0.0),   // fraction of cells rendered inverted       0–1
uGlyphSpinAmt:     uniform(0.0),   // glyph rotation blend (0=off, 1=full)     0–1
uGlyphSpinSpeed:   uniform(1.0),   // glyph spin speed Hz                       0–2
uHueDriftRate:     uniform(0.0),   // per-column hue drift rate Hz              0–0.5
uHueDriftAmt:      uniform(0.0),   // per-column hue drift max degrees          0–45
uHeadOvershootAmt: uniform(0.0),   // head overshoot max displacement (cells)   0–3
```

Add all 8 names to the destructure block at the top of `buildGlyphMaterial()`.

---

## Uniform name conflict audit

Cross-checked against the complete `makeUniforms()` return (lines 53–124 of
`matrix-rain-tsl.js`). All 8 new uniform names are confirmed free:

`uShimmerAmt`, `uShimmerFreq`, `uInversionChance`, `uGlyphSpinAmt`, `uGlyphSpinSpeed`,
`uHueDriftRate`, `uHueDriftAmt`, `uHeadOvershootAmt` — none present. No conflicts.

## Attribute name conflict audit

Existing attributes: `aColIdx`, `aRowIdx`, `aColA`, `aColB`, `aClusterBias`,
`aClusterBurstSeed`, `aSquadPhase`, `aFrustumVis`, `aSpawnTheta`, `aLockState`.

New attribute `aHeadOvershoot` — confirmed free. No conflict.

## Fragment-stage hash seed audit

Existing fragment hash seeds (first component of vec2 passed to `h2`):
`0.37` (cellPhase), `0.91` (stability), `0.29` (holdRand), `0.17` (hueShift/cellId.x),
`0.47` (baseHash), `0.53` (two uses), `0.61` (mutGlyph), `0.71` (flash).

New fragment hash seeds added by this spec:
- Effect 2: `cellId.mul(0.83).add(0.11)` — free
- Effect 3: `cellId.mul(0.59).add(0.07)`, `cellId.mul(0.41).add(0.03)` — free
- Effect 4: `vec2(cellId.x.mul(0.29), float(0.07))` — differs from holdRand's
  `cellId.mul(0.29)` because the y-component is constant `0.07` vs `cellId.y * 0.29`;
  `vec2(cellId.x.mul(0.41), float(0.19))` — differs from Effect 3's use of `0.41`
  because that uses the full `cellId` vec2, not a scalar + constant.

No effective hash collisions.

---

## Implementation order

Implement in this sequence to minimise merge conflicts:

1. Add 8 uniforms to `makeUniforms()` and to the destructure in `buildGlyphMaterial()`.
2. Add `hueRotateRGB` helper at module scope in `matrix-rain-tsl.js`.
3. Add `aHeadOvershoot` buffer to `buildGeometry()` and `geom.setAttribute`.
4. **Vertex Fn — Effect 5**: Insert head overshoot block after lock-freeze, before
   trail distance.
5. **Vertex Fn — Effect 1**: Insert lateral shimmer block after sway addAssign, before
   Z-rotation comment.
6. **Fragment Fn — prerequisite**: Change `tintedColor` declaration to `.toVar('tintedColor')`.
7. **Fragment Fn — Effect 4**: Insert hue drift block after `tintedColor`, before color head burn.
8. **Fragment Fn — prerequisite**: Change `mask` declaration to `.toVar('mask')` and change
   `sdfG` sample to use `spinFace` (step 9 adds `spinFace`; do this in one pass).
9. **Fragment Fn — Effect 3**: Insert glyph rotation block after `finalFace`, replacing all
   downstream `finalFace` uses with `spinFace` (`sdfG`, `rUV`/`bUV`, normal samples).
10. **Fragment Fn — Effect 2**: Insert inversion block after the `mask < 0.01` discard.
11. Add 8 handle methods to `initMatrixRain` handle object.
12. Add UI sliders to `demo.html`.

---

## Review history

### Round 1 — Issues found and fixed

1. **Shimmer insertion point ambiguous in first draft**: Clarified that shimmer must be
   inside the trail-window cull block where `colCenter`, `right`, `dist`, and `isVertLockHead`
   are all in scope. Specified anchor as after `colCenter.addAssign(right.mul(sway))`.

2. **Shimmer on locked head cells**: Added `select(isVertLockHead, float(0.0), ...)` guard
   so message-reveal characters do not oscillate laterally.

3. **`mask` is a TSL `const` node**: TSL `const` creates an immutable node reference;
   `.assign()` is invalid on it. Specified `.toVar('mask')` conversion as prerequisite.

4. **Inversion discard order**: Clarified that the `mask < 0.01` discard runs BEFORE
   inversion. Background regions of inverted cells discard in the final `alpha < 0.015`
   check instead, which is the correct behaviour.

5. **Inversion on locked head cells**: Added `.and(isLockHead.not())` to `isInverted` so
   message-reveal characters never render inverted.

6. **Glyph rotation — downstream `finalFace` uses incomplete**: Original draft only mentioned
   replacing the `sdfG` sample. Enumerated all three replacement sites: `sdfG`, `rUV`/`bUV`
   (chromatic aberration), and the four normal-map neighbour samples.

7. **Glyph rotation on locked head cells**: Added `select(isLockHead, float(0.0), spinDecay)`
   guard, cascading to zero angle → identity transform → `spinFace = finalFace`.

8. **Hue drift — unsafe HSV implementation**: First draft used an `rgb2hsv`/`hsv2rgb` pair
   that relied on `vec4(c.bg, K.wz)` style swizzle construction, which is unsafe in some TSL
   backends. Replaced with `hueRotateRGB` using Rodrigues rotation — pure scalar TSL chains,
   backend-safe.

9. **Hue drift — `driftRad` dimensionally inconsistent**: First formula multiplied a phase
   angle (in radians) by an amplitude (in degrees×π/180), producing an incorrect result.
   Fixed by using `sin()` oscillation: `driftRad = sin(oscillation) * uHueDriftAmt * π/180`,
   giving a clean ±uHueDriftAmt degree oscillation at uHueDriftRate Hz.

10. **Hue drift — `tintedColor` is a TSL `const` node**: Same immutability issue as `mask`.
    Specified `.toVar('tintedColor')` conversion as prerequisite.

11. **Hue drift on locked head cells**: Added `select(isLockHead, float(0.0), driftRadFull)`
    guard so message-reveal characters retain their base colour.

12. **Head overshoot — `pow()` WGSL concern**: Replaced `.pow(float(2.0))` with explicit
    `.mul()` self-product (`overPhase.sub(0.12).mul(overPhase.sub(0.12))`) to avoid any
    WGSL backend concerns with `pow(x, 2)` precision near zero.

13. **Head overshoot insertion point — `cellStep` availability verified**: `cellStep` is
    computed at the top of the boot-cull block, before `headY`, so it is in scope at the
    overshoot insertion point.

14. **Gaussian constant derivation**: Added inline `2σ² = 0.0018` derivation comment.

15. **Handle method naming**: Audited against all existing methods. All 8 new method names
    follow the `set<FeatureName>(v)` pattern and do not shadow existing methods.

### Round 2 — Issues found and fixed

16. **`max(d, 0.0)` redundant in spinDecay**: Review history item (round 1) said it was
    corrected but the spec body text still had `exp(max(d, 0.0).negate()...)`. Fixed to use
    `d` directly: `exp(d.negate().mul(2.0))`, since `d = max(vDist, 0.0)` is already
    non-negative by definition.

17. **Hue drift — fragment hash seeds**: `cellId.x.mul(0.29)` as first component could look
    like a collision with holdRand's `cellId.mul(0.29)`. Confirmed no collision: holdRand
    passes `vec2(cellId.x*0.29, cellId.y*0.29)` while drift passes
    `vec2(cellId.x*0.29, 0.07)` — different second components produce different h2 results.
    Added explicit hash seed audit section to spec.

18. **Chromatic aberration and inversion interaction**: Documented that `rMask`/`bMask` are
    not inverted when `mask` is, resulting in reversed-sign chroma fringing on inverted cells.
    This is an accepted aesthetic choice (negative-space halo); no code change needed.

19. **Effect 3 — note about `sdfG` changing when Effects 2+3 both applied**: Added a note
    in Effect 2's prerequisite section explaining that when Effect 3 is also applied, `sdfG`
    uses `spinFace` not `finalFace`. The `.toVar('mask')` change is the same; only the input
    to `sdfG` differs. Implementation order (step 8+9 done together) handles this correctly.

### Round 3 — Final review, zero issues found

- All 8 uniform names confirmed free of conflicts against full `makeUniforms()`.
- All attribute names confirmed free.
- All fragment hash seeds confirmed non-colliding.
- All 5 shader insertion points verified at correct nesting levels with all required
  variables in scope.
- All lock-head guards confirmed on all 5 effects.
- `tintedColor` and `mask` `.toVar()` conversions specified as explicit prerequisites.
- `hueRotateRGB` Rodrigues rotation matrix verified mathematically correct.
- `aHeadOvershoot` buffer layout matches the per-column replication pattern of existing
  attributes (`aClusterBias`, `aClusterBurstSeed`, etc.).
- All handle method range clamps match their corresponding uniform ranges.
- Implementation order accounts for all cross-effect prerequisites.
