# SPEC — Cluster Class Redesign: Decoupled Hue, Brightness, Speed

**Status**: Draft
**Priority**: P1
**Depends on**: none
**Goal**: Replace the single `aClusterBias` attribute (which conflates brightness and speed) with three
independent per-column attributes (`aClusterHue`, `aClusterBright`, `aClusterSpeed`), introduce a JS
`Cluster` class to own all per-cluster state, and add per-cluster hue rotation via a TSL `hueRotateRGB`
helper — unlocking visually distinct, aesthetically controllable clusters.

---

## Motivation

The current system has one signed float per column (`aClusterBias ∈ [−1, 1]`) that drives both
brightness and speed through a single `uClusterBiasAmt` uniform.  This creates an unavoidable
coupling:

| aClusterBias | Visual result |
|---|---|
| +1 | bright + fast |
| 0  | medium + medium |
| −1 | dim + slow |

There is no way to get **bright + slow** or **dim + fast** columns.  More critically, there is no
per-cluster color at all, so clusters are visually indistinguishable at a glance — the user's core
complaint.

This spec replaces that architecture with:

1. **Three independent per-column float attributes** — `aClusterHue`, `aClusterBright`, `aClusterSpeed`
   — each in [−1, 1], driven by separate cluster seeds, scaled by separate uniforms.
2. **A JS `Cluster` class** that owns all per-cluster state (theta, hue, brightness, speed, burst,
   yCenter, rSeed, phase) to make the geometry builder readable and extensible.
3. **`hueRotateRGB()` TSL helper** that rotates the output glyph color around the luminance axis by a
   per-cluster hue offset — applied in the fragment Fn so it acts on the final composited color.

---

## Scope

| File | Change |
|---|---|
| `matrix-rain-tsl.js` | Remove `aClusterBias`, `uClusterBiasAmt`; add `aClusterHue`, `aClusterBright`, `aClusterSpeed`; add `uClusterHueRange`, `uClusterBrightRange`, `uClusterSpeedRange`; add `hueRotateRGB` TSL Fn; apply hue in fragment Fn; decouple brightness and speed paths |
| `matrix-rain-webgpu.js` | Add `Cluster` class; rewrite cluster seed generation; rename buffers; update `_geomParams`; update handle methods |
| `matrix-3d.html` | Replace 1 "Cluster bias" slider with 3 sliders: Hue range, Brightness range, Speed range |
| `CLAUDE.md` | Update uniforms table, handle methods table |

**Not changed**: `matrix-rain-passes-tsl.js`, `matrix-rain-presets.js`

---

## Goals

1. Clusters are visually distinguishable by **hue** — a bright green cluster vs. a blue-shifted one is
   immediately legible.
2. Cluster brightness and speed are **independently tunable** — you can have a bright+slow cluster
   next to a dim+fast one.
3. Setting `setClusterHueRange(0)` produces exactly the same look as before the redesign (backward
   compatible hue path).
4. Setting both `setClusterBrightRange(0)` and `setClusterSpeedRange(0)` disables all cluster visual
   variation without a geometry rebuild.
5. The `Cluster` class makes `buildGeometry()` readable and future cluster properties easy to add.
6. Vertex buffer slot count increases by exactly 2 (remove 1 `aClusterBias`, add 3 new) — total 11 slots, well within the WebGPU 16-slot limit.

---

## Non-Goals

- Per-column (not per-cluster) color variation — that would require different data.
- Animated per-cluster hue shift over time — that can be layered on top later.
- Cluster inheritance from external scene lights or materials.
- Changes to `matrix-rain-passes-tsl.js` or `matrix-rain-presets.js`.

---

## Concept: Cluster Class

### Current state (array-of-arrays, hard to read)

```js
const clusterBiases      = Array.from({ length: nClusters }, () => Math.random() * 2 - 1);
const clusterBurstSeeds  = Array.from({ length: nClusters }, () => Math.random());
const clusterSpeedSeeds  = Array.from({ length: nClusters }, () => Math.random());
const clusterYCenters    = Array.from({ length: nClusters }, () => (Math.random() - 0.5) * WORLD_H);
const clusterRSeeds      = Array.from({ length: nClusters }, () => Math.random());
const clusterPhases      = Array.from({ length: nClusters }, () => Math.random());
// ... then clusterBiases[clusterIdx] etc scattered throughout the loop
```

### Proposed `Cluster` class

```js
class Cluster {
  constructor(thetaCenter, worldH) {   // worldH passed from buildGeometry() — not a module-level const
    this.theta      = thetaCenter;        // angular center on XZ shell (radians)
    this.hue        = Math.random() * 2 - 1;   // per-cluster hue offset [-1, 1]
    this.brightness = Math.random() * 2 - 1;   // per-cluster brightness bias [-1, 1]
    this.speed      = Math.random() * 2 - 1;   // per-cluster speed bias [-1, 1]
    this.burstSeed  = Math.random();      // burst desync offset [0, 1]
    this.yCenter    = (Math.random() - 0.5) * worldH;  // spawn Y band center
    this.rSeed      = Math.random();      // shell depth seed [0, 1]
    this.phase      = Math.random();      // cycle phase seed [0, 1]
    // Squad sub-structure (computed lazily during column assignment)
    this._colCount  = 0;
    this.squadPhases      = null;  // populated by initSquads()
    this.squadTrailBiases = null;  // populated by initSquads()
  }

  initSquads(maxSquadsPerCluster) {
    this.squadPhases = Array.from({ length: maxSquadsPerCluster }, () => {
      const jitter = (Math.random() - 0.5) * 0.2;
      return Math.max(0, Math.min(1, this.phase + jitter));
    });
    this.squadTrailBiases = Array.from({ length: maxSquadsPerCluster }, () => Math.random() * 2 - 1);
  }

  nextSquadIdx(squadSize) {
    return Math.floor(this._colCount++ / squadSize);
  }
}
```

All per-cluster scalar state lives inside the object.  The geometry loop reads from the `Cluster`
instance — no more `clusterBiases[clusterIdx]`, `clusterSpeedSeeds[clusterIdx]`, etc.

---

## New Attributes

Replace `aClusterBias` (1 float) with three independent floats, each the same size:

| Attribute | Type | Range | Purpose |
|---|---|---|---|
| `aClusterHue` | `float` | [−1, 1] | Per-cluster hue rotation direction and magnitude |
| `aClusterBright` | `float` | [−1, 1] | Per-cluster brightness bias |
| `aClusterSpeed` | `float` | [−1, 1] | Per-cluster speed bias |

**Vertex buffer impact**: net +2 slots — each `THREE.InstancedBufferAttribute` consumes one vertex
buffer slot regardless of component count.  We remove 1 (`aClusterBias`) and add 3, for a net
increase of 2.  Current slot count:

| Slot | Attribute |
|---|---|
| 0 | `aColA` (vec4) |
| 1 | `aColB` (vec4) |
| 2 | `aClusterBias` (float) → **removed** |
| 3 | `aClusterBurstSeed` (float) |
| 4 | `aSquadPhase` (float) |
| 5 | `aFrustumVis` (float) |
| 6 | `aSpawnTheta` (float) |
| 7 | `aLockState` (float) |
| 8 | `aSpawnWaveMask` (float) |

After change: remove slot 2 (`aClusterBias`), add 3 new slots:

| New slot | Attribute |
|---|---|
| 2 | `aClusterHue` (float) |
| 3 (was 2) | `aClusterBright` (float) |
| 4 (new) | `aClusterSpeed` (float) |

Total: 11 slots (was 9, net +2).  Well within the 16-slot limit.

---

## New Uniforms

Remove: `uClusterBiasAmt`

Add:

```js
uClusterHueRange:    uniform(18.0),   // max hue rotation degrees  0–45 (0 = monochrome)
uClusterBrightRange: uniform(0.35),   // brightness bias magnitude  0–1 (0 = uniform brightness)
uClusterSpeedRange:  uniform(0.30),   // speed bias magnitude       0–1 (0 = uniform speed)
```

`uClusterHueRange` is in **degrees** (not radians) for intuitive slider values.  The shader
converts via `DEG_TO_RAD = float(Math.PI / 180)` — a build-time JS constant node.  There is no
`PI_OVER_180` symbol in TSL.

Default values:
- `uClusterHueRange = 18°`: subtle, film-accurate teal/lime/yellow shifts — recognizable without
  being garish.
- `uClusterBrightRange = 0.35`: replaces the old effective magnitude. At `+1 × 0.35` a column is
  1.35× base brightness; at `−1 × 0.35` it is 0.65×.
- `uClusterSpeedRange = 0.30`: speed multiplied by `[0.70, 1.30]` at extreme bias.

---

## `hueRotateRGB` TSL Helper

Add a top-level TSL `Fn` at the top of `buildGlyphMaterial()` (or as a module-level helper):

### Mathematics

Rotating hue by angle θ around the luminance axis is a linear transform on RGB.  The standard
Rodrigues approach decomposes the rotation into: scalar projection onto the luminance axis, plus a
rotation of the complementary component.

For the matrix rain, we only rotate in the hue direction that the Matrix green naturally varies —
toward teal (−θ) or yellow-green (+θ) — keeping saturation and luminance unchanged.

```
L = (0.2126, 0.7152, 0.0722)  // ITU-R BT.709 luminance coefficients

hueRotate(rgb, θ):
  lum = dot(rgb, L)            // luminance scalar
  gray = vec3(lum)             // gray point on luminance axis
  diff = rgb − gray            // chroma component (perpendicular to luminance)
  u = normalize(cross(L, diff)) when |diff|>ε, else arbitrary⊥
  rotated = diff * cos(θ) + cross(u, diff) * sin(θ)
  return gray + rotated
```

However, a full Rodrigues rotation in TSL requires `normalize`, `cross`, two `mul` chains, and a
branch for degenerate diff.  This is unnecessary complexity for a subtle hue tint.

**Simplified approach**: use a 3×3 rotation matrix baked for the green-axis.  The luminance axis
for Matrix green `(0, 1, 0.44)` (after normalisation) gives a stable, fast rotation:

```js
// Hue rotation around the luminance axis (Y-dominant for Matrix green)
// Approximate: rotates in the green-teal-yellow plane, preserves perceived brightness.
const DEG_TO_RAD = float(Math.PI / 180);
const hueRotateRGB = Fn(([rgb, angleDeg]) => {
  const angle = angleDeg.mul(DEG_TO_RAD);
  const c = cos(angle);
  const s = sin(angle);
  // Luminance-weighted rotation: luma stays fixed, R and B rotate around G
  const r = rgb.r.mul(c).add(rgb.b.mul(s.negate()));
  const g = rgb.g;                  // green component unchanged (luma axis)
  const b = rgb.r.mul(s).add(rgb.b.mul(c));
  return vec3(r, g, b);
});
```

`DEG_TO_RAD` is a JS-side `float()` constant node evaluated at shader-build time — same pattern as
`float(Math.PI * 2)` already used in `matrix-rain-tsl.js`.  There is no `PI_OVER_180` TSL symbol.

This is a 2D rotation in the (R, B) plane, holding G fixed.  It:
- Shifts toward teal at positive angle (increases B, decreases R)
- Shifts toward yellow-green at negative angle (increases R, decreases B)
- Preserves green luminance — the Matrix feel is never lost
- Is 6 multiplies + 2 adds — near-zero GPU cost

The approximation is valid because Matrix rain green lives at `(0, 1, 0.44)` in RGB: the dominant
channel is G, so rotating R and B around G is the natural hue axis.

---

## Shader Changes (`matrix-rain-tsl.js`)

### 1. Attribute and varying declarations (builder scope)

```js
// Remove:
const aClusterBiasAttr      = attribute('aClusterBias',   'float');

// Add — attributes:
const aClusterHueAttr    = attribute('aClusterHue',    'float');  // [-1, 1]
const aClusterBrightAttr = attribute('aClusterBright', 'float');  // [-1, 1]
const aClusterSpeedAttr  = attribute('aClusterSpeed',  'float');  // [-1, 1]

// Add — varying (alongside existing vAlpha, vBurst, vCyclePhase, etc.):
const vClusterHue = varying(float(), 'vClusterHue');
```

Add `vClusterHue.assign(0.0)` to the unconditional pre-gate defaults block (alongside the other
varying defaults at the top of `buildGlyphMaterial()`).  This satisfies WGSL's requirement that all
varyings are assigned on every execution path.

### 2. Uniform declarations (`makeUniforms()`)

```js
// Remove:
uClusterBiasAmt: uniform(0.40),

// Add:
uClusterHueRange:    uniform(18.0),
uClusterBrightRange: uniform(0.35),
uClusterSpeedRange:  uniform(0.30),
```

Update destructure block in `buildGlyphMaterial()`:

```js
// Remove:  uClusterBiasAmt
// Add:     uClusterHueRange, uClusterBrightRange, uClusterSpeedRange
```

### 3. Vertex Fn — brightness path and `vClusterHue` assignment

```js
// Before:
const clusterAlphaMul = float(1.0).add(aClusterBiasAttr.mul(uClusterBiasAmt));
vAlpha.assign(aAlpha.mul(alphaJitter).mul(zoneBrightBias).mul(clusterAlphaMul));

// After:
const clusterAlphaMul = float(1.0).add(aClusterBrightAttr.mul(uClusterBrightRange));
vAlpha.assign(aAlpha.mul(alphaJitter).mul(zoneBrightBias).mul(clusterAlphaMul));
vClusterHue.assign(aClusterHueAttr);   // ← pass hue to fragment Fn via varying
```

Placement of `vClusterHue.assign(aClusterHueAttr)`: inside the density-gate `If` block, alongside
`vAlpha.assign(...)`.  This ensures the hue is set for all active instances.  The pre-gate default
(`vClusterHue.assign(0.0)`) handles culled instances.

### 4. Vertex Fn — speed path

```js
// Before:
// uClusterBiasAmt ∈ [0, 1]; aClusterBias ∈ [−1, 1] → speed multiplier ∈ [0.6, 1.4] at bias=0.40.
const effectiveSpeed = aSpeed.mul(float(1.0).add(aClusterBiasAttr.mul(uClusterBiasAmt)));

// After:
const effectiveSpeed = aSpeed.mul(float(1.0).add(aClusterSpeedAttr.mul(uClusterSpeedRange)));
```

### 5. Fragment Fn — hue rotation

After the depth-tint `col2.assign(...)` block and before the final `return vec4(col2.mul(...), ...)`,
insert:

```js
// ── Per-cluster hue rotation ─────────────────────────────────────────────
// vClusterHue ∈ [-1, 1]; uClusterHueRange in degrees.
// Rotation of R and B around the G (luminance) axis; preserves Matrix feel.
const clusterHueDeg = vClusterHue.mul(uClusterHueRange);
col2.assign(hueRotateRGB(col2, clusterHueDeg));
```

**`col2.assign(...)` not `col2 = ...`**: `col2` is a `toVar('col2')` node (line 712 of
`matrix-rain-tsl.js`).  All mutations in this file use `.assign()` / `.addAssign()`.  A bare JS
`col2 = ...` would rebind the JS variable to a new node, breaking the subsequent
`col2.mul(alpha).mul(uBrightness)` at the return.

**Placement**: after `col2.assign(mix(col2, col2.mul(vec3(0.6, 0.85, 1.1)), ...))` (depth tint,
line 739) and before the final alpha and `return` block.  Applying last means it acts on the fully
composited color including head-white, drip, flash, etc. — the cluster hue identity is perceptually
consistent.

**Alternative placement** (before drip/flash): rejected because it would shift the drip and flash
highlights differently from the body, creating a color seam at the head. Post-composition is correct.

---

## JS Changes (`matrix-rain-webgpu.js`)

### 1. `Cluster` class

Add before `buildGeometry()`:

```js
class Cluster {
  constructor(thetaCenter, worldH) {
    this.theta      = thetaCenter;
    this.hue        = Math.random() * 2 - 1;
    this.brightness = Math.random() * 2 - 1;
    this.speed      = Math.random() * 2 - 1;
    this.burstSeed  = Math.random();
    this.yCenter    = (Math.random() - 0.5) * worldH;
    this.rSeed      = Math.random();
    this.phase      = Math.random();
    this._colCount  = 0;
    this.squadPhases      = null;
    this.squadTrailBiases = null;
  }

  initSquads(maxSquadsPerCluster) {
    this.squadPhases = Array.from({ length: maxSquadsPerCluster }, () => {
      return Math.max(0, Math.min(1, this.phase + (Math.random() - 0.5) * 0.2));
    });
    this.squadTrailBiases = Array.from({ length: maxSquadsPerCluster }, () => Math.random() * 2 - 1);
  }

  nextSquadIdx(squadSize) {
    return Math.floor(this._colCount++ / squadSize);
  }
}
```

### 2. `buildGeometry()` signature — parameter rename

```js
// Remove parameter:
clusterBiasAmt = 0.40,

// Add no new parameters — hue/bright/speed ranges are uniform-only (no geometry rebuild needed).
// (The per-cluster seed values are always [−1, 1]; the range is applied in shader.)
```

No `clusterBiasAmt` in `_geomParams` — the uniform is set via handle methods and does not affect
the baked attributes.

### 3. Cluster construction in `buildGeometry()`

```js
// Remove all of the following (replaced by the Cluster array below):
const clusterBiases      = Array.from({ length: nClusters }, () => Math.random() * 2 - 1);
const clusterBurstSeeds  = Array.from({ length: nClusters }, () => Math.random());
const clusterSpeedSeeds  = Array.from({ length: nClusters }, () => Math.random());
const clusterYCenters    = Array.from({ length: nClusters }, () => (Math.random() - 0.5) * WORLD_H);
const clusterRSeeds      = Array.from({ length: nClusters }, () => Math.random());
const clusterPhases      = Array.from({ length: nClusters }, () => Math.random());
const squadPhases        = Array.from(...);  // full 2-D array
const squadTrailBiases   = Array.from(...);  // full 2-D array
const clusterColCount    = new Int32Array(nClusters);  // ← also remove; replaced by cl.nextSquadIdx()

// The clusterThetas array that drove stratified placement is also subsumed:
// (the theta is now stored as cl.theta inside each Cluster instance)

// Add:
const clusters = Array.from({ length: nClusters }, (_, i) =>
  new Cluster(i * arcSize + Math.random() * arcSize, WORLD_H)
);
clusters.forEach(cl => cl.initSquads(maxSquadsPerCluster));
```

### 4. Buffer declarations

```js
// Remove:
const clusterBiasBuf = new Float32Array(total);

// Add:
const clusterHueBuf    = new Float32Array(total);
const clusterBrightBuf = new Float32Array(total);
const clusterSpeedBuf  = new Float32Array(total);
```

### 5. Per-column cluster reads in the geometry loop

```js
// Remove the scattered per-array reads:
const colBias       = clusterBiases[clusterIdx];          // ← removed
const colBurstSeed  = clusterBurstSeeds[clusterIdx];      // ← removed
const squadSubIdx   = Math.floor(clusterColCount[clusterIdx] / squadSize);  // ← removed
clusterColCount[clusterIdx]++;                            // ← removed
const colSquadPhase = squadPhases[clusterIdx][squadSubIdx];         // ← removed
const colTrailBias  = squadTrailBiases[clusterIdx][squadSubIdx];    // ← removed

// Add (reading from Cluster instance):
const cl            = clusters[clusterIdx];
const colBurstSeed  = cl.burstSeed;
const squadSubIdx   = cl.nextSquadIdx(squadSize);  // increments cl._colCount internally
const colSquadPhase = cl.squadPhases[squadSubIdx];
const colTrailBias  = cl.squadTrailBiases[squadSubIdx];

// Angular position (replaces clusterThetas[clusterIdx]):
const clustered = cl.theta + _gaussRand() * sigma;

// Y offset (replaces clusterYCenters[clusterIdx]):
const yOff = Math.max(-WORLD_H / 2, Math.min(WORLD_H / 2,
  cl.yCenter + (Math.random() - 0.5) * 2 * clusterYSpread
));

// Speed seed (replaces clusterSpeedSeeds[clusterIdx], maps cl.speed [-1,1] → [0,1] center):
const sr = Math.max(0, Math.min(1,
  cl.speed * 0.5 + 0.5 + (Math.random() - 0.5) * 2 * clusterSpeedJitter
));
// Note: cl.speed is [-1, 1]; mapping via *0.5+0.5 ensures cluster centers span the full [0,1]
// speed range. This is also stored as aClusterSpeed for the shader-time multiplier — see
// Design Decisions: "Double-speed-bias" for why this is intentional.

// Radial seed (shell only — replaces clusterRSeeds[clusterIdx]):
const rSeed = topology === 'shell'
  ? Math.max(0, Math.min(1, cl.rSeed + (Math.random() - 0.5) * 2 * clusterRJitter))
  : Math.random();
```

### 6. Per-instance buffer writes

```js
// Remove:
clusterBiasBuf[idx]      = colBias;

// Add:
clusterHueBuf[idx]    = cl.hue;
clusterBrightBuf[idx] = cl.brightness;
clusterSpeedBuf[idx]  = cl.speed;
```

### 7. Geometry attribute registration

```js
// Remove:
geom.setAttribute('aClusterBias', new THREE.InstancedBufferAttribute(clusterBiasBuf, 1));

// Add:
geom.setAttribute('aClusterHue',    new THREE.InstancedBufferAttribute(clusterHueBuf,    1));
geom.setAttribute('aClusterBright', new THREE.InstancedBufferAttribute(clusterBrightBuf, 1));
geom.setAttribute('aClusterSpeed',  new THREE.InstancedBufferAttribute(clusterSpeedBuf,  1));
```

### 8. Reserve pool — cluster attribute writes

```js
// Remove:
const reserveClusterBias = clusterBiases[nearestCluster];
const reserveBurstSeed   = clusterBurstSeeds[nearestCluster];
// ...
clusterBiasBuf[idx]      = reserveClusterBias;
clusterBurstSeedBuf[idx] = reserveBurstSeed;
// ...
squadPhaseBuf[idx]       = reserveSquadPhase;  // (was derived from old squadPhases array)

// With:
const reserveCl = clusters[nearestCluster];
// For squad phase, pick the squad index at current count (don't call nextSquadIdx — reserves
// are not counted toward the cluster's column count, which was already incremented in the
// main loop before reserves were assigned):
const reserveSquadIdx   = Math.floor(reserveCl._colCount / squadSize);  // read-only, no ++
const reserveSquadPhase = reserveCl.squadPhases[Math.min(reserveSquadIdx, reserveCl.squadPhases.length - 1)];
// ...
clusterHueBuf[idx]       = reserveCl.hue;
clusterBrightBuf[idx]    = reserveCl.brightness;
clusterSpeedBuf[idx]     = reserveCl.speed;
clusterBurstSeedBuf[idx] = reserveCl.burstSeed;
squadPhaseBuf[idx]       = reserveSquadPhase;
```

Note: the existing reserve pool already does nearest-cluster angular lookup and sets `colBBuf` Y —
that logic is unchanged.  Only the attribute source (raw arrays → Cluster object) changes.

### 9. `_geomParams` update

```js
// Remove key:
clusterBiasAmt: 0.40,

// No new geom-rebuild keys for hue/bright/speed ranges — those are uniform-only.
// clusterSpeedJitter, clusterYSpread, clusterRJitter remain as before (they affect baked geometry).
```

### 10. Handle methods

```js
// Remove:
setClusterBias(v) {
  _geomParams.clusterBiasAmt = Math.max(0, Math.min(1, v));
  uniforms.uClusterBiasAmt.value = _geomParams.clusterBiasAmt;
},

// Add:
setClusterHueRange(v)    { uniforms.uClusterHueRange.value    = Math.max(0, Math.min(45, v)); },
setClusterBrightRange(v) { uniforms.uClusterBrightRange.value = Math.max(0, Math.min(1, v)); },
setClusterSpeedRange(v)  { uniforms.uClusterSpeedRange.value  = Math.max(0, Math.min(1, v)); },
```

All three are instant uniform updates — no geometry rebuild required.

---

## Demo Controls (`matrix-3d.html`)

### Replace Cluster bias slider

Find and replace the existing "Cluster bias" row in the Columns sub-panel:

```html
<!-- REMOVE: -->
<label>Cluster bias
  <span style="display:flex;align-items:center;gap:4px;">
    <input id="ctl-cluster-bias"     type="range"  min="0" max="1" step="0.01" value="0.40">
    <input id="ctl-cluster-bias-num" type="number" min="0" max="1" step="0.01" value="0.40">
  </span>
</label>

<!-- ADD: -->
<label>Cluster hue range (°)
  <span style="display:flex;align-items:center;gap:4px;">
    <input id="ctl-cluster-hue"     type="range"  min="0" max="45" step="1" value="18">
    <input id="ctl-cluster-hue-num" type="number" min="0" max="45" step="1" value="18">
  </span>
</label>
<label>Cluster brightness range
  <span style="display:flex;align-items:center;gap:4px;">
    <input id="ctl-cluster-bright"     type="range"  min="0" max="1" step="0.01" value="0.35">
    <input id="ctl-cluster-bright-num" type="number" min="0" max="1" step="0.01" value="0.35">
  </span>
</label>
<label>Cluster speed range
  <span style="display:flex;align-items:center;gap:4px;">
    <input id="ctl-cluster-speed"     type="range"  min="0" max="1" step="0.01" value="0.30">
    <input id="ctl-cluster-speed-num" type="number" min="0" max="1" step="0.01" value="0.30">
  </span>
</label>
```

### JS bindings

```js
// Remove:
linkSlider('ctl-cluster-bias', 'ctl-cluster-bias-num', v => rain.setClusterBias(v));

// Add:
linkSlider('ctl-cluster-hue',    'ctl-cluster-hue-num',    v => rain.setClusterHueRange(v));
linkSlider('ctl-cluster-bright', 'ctl-cluster-bright-num', v => rain.setClusterBrightRange(v));
linkSlider('ctl-cluster-speed',  'ctl-cluster-speed-num',  v => rain.setClusterSpeedRange(v));
```

### `collectSettings()` / `applySettings()`

```js
// Remove:  clusterBias: fv('ctl-cluster-bias'),
// Add:
clusterHueRange:    fv('ctl-cluster-hue'),
clusterBrightRange: fv('ctl-cluster-bright'),
clusterSpeedRange:  fv('ctl-cluster-speed'),
```

```js
// Remove:  if (s.clusterBias !== undefined) { rain.setClusterBias(s.clusterBias); setSlider('ctl-cluster-bias', s.clusterBias); }
// Add:
if (s.clusterHueRange    !== undefined) { rain.setClusterHueRange(s.clusterHueRange);       setSlider('ctl-cluster-hue',    s.clusterHueRange); }
if (s.clusterBrightRange !== undefined) { rain.setClusterBrightRange(s.clusterBrightRange); setSlider('ctl-cluster-bright', s.clusterBrightRange); }
if (s.clusterSpeedRange  !== undefined) { rain.setClusterSpeedRange(s.clusterSpeedRange);   setSlider('ctl-cluster-speed',  s.clusterSpeedRange); }
```

Also remove `lbl-cluster-bias` from the topology visibility map if it exists.

---

## `CLAUDE.md` Updates

### Uniforms table — remove and add

```
// Remove:
| `uClusterBiasAmt` | `0.40` | per-cluster speed+brightness bias magnitude 0–1 |

// Add:
| `uClusterHueRange`    | `18.0` | Max hue rotation per cluster in degrees; 0 = monochrome |
| `uClusterBrightRange` | `0.35` | Brightness bias magnitude; 0 = uniform brightness |
| `uClusterSpeedRange`  | `0.30` | Speed bias magnitude; 0 = uniform speed |
```

### Handle methods table — remove and add

```
// Remove:
| `setClusterBias(v)` | Per-cluster speed+brightness bias magnitude 0–1 |

// Add:
| `setClusterHueRange(v)`    | Max per-cluster hue rotation in degrees 0–45 (0 = monochrome, default 18) |
| `setClusterBrightRange(v)` | Per-cluster brightness bias magnitude 0–1 (0 = uniform, default 0.35) |
| `setClusterSpeedRange(v)`  | Per-cluster speed bias magnitude 0–1 (0 = uniform, default 0.30) |
```

---

## Edge Cases

| Case | Behaviour |
|---|---|
| `setClusterHueRange(0)` | `clusterHueDeg = 0` for all columns; `hueRotateRGB(col2, 0)` is identity; zero hue shift, no GPU cost difference |
| `setClusterBrightRange(0)` | `clusterAlphaMul = 1.0` for all; uniform brightness; columns still differ by `clusterSpeedRange` |
| `setClusterSpeedRange(0)` | `effectiveSpeed = aSpeed` for all; all columns use base speed only |
| All three = 0 | No hue shift, no shader-time brightness or speed variation. Clusters are still spatially and temporally coherent (same Y band, phase, geometry-baked speed from `cl.speed * 0.5 + 0.5`), but visually indistinguishable in color. Speed differences from geometry baking remain — setting `uClusterSpeedRange = 0` only disables the shader-time multiplier. |
| `uClusterHueRange = 45` | Maximum shift: +45° toward teal, −45° toward yellow-green; clusters strongly distinguishable |
| Negative `aClusterHue` | `clusterHueDeg < 0`; `hueRotateRGB` with negative angle → yellow-green shift |
| Reserve columns | Inherits `cl.hue / .brightness / .speed` from the nearest cluster — same as active columns in that cluster |
| `clusterBiasAmt` in old presets / saved settings | Old `clusterBias` key in `applySettings` is silently ignored (no matching `setClusterBias` on the new handle) |

---

## Design Decisions

- **R–B rotation holding G fixed** (vs. full Rodrigues rotation): The Matrix rain is green-dominant.
  Rotating R and B around G is the natural hue axis for this color.  Full Rodrigues would be 3×
  more GPU instructions for no perceptual gain, and would risk desaturating or oversaturating with
  large angles.  The simplified form also has no singularity at gray (unlike some Rodrigues
  implementations).

- **`uClusterHueRange` in degrees** (vs. radians): Degrees are the natural unit for a slider.
  The conversion is via `DEG_TO_RAD = float(Math.PI / 180)`, a build-time JS constant node — no
  per-frame GPU cost.

- **Uniform-only for hue/bright/speed ranges** (no `_geomParams`): The per-cluster seed values
  are baked as [−1, 1] attributes.  Changing the range multiplies by a different uniform — no
  rebuild needed.  This gives instant real-time feedback on all three sliders.

- **Speed seed mapping `cl.speed * 0.5 + 0.5`**: `cl.speed ∈ [−1, 1]` is the cluster's raw bias.
  Since the column speed seed is currently a random in [0, 1], we want the cluster center to also
  be in [0, 1].  Mapping `[−1, 1] → [0, 1]` via `× 0.5 + 0.5` ensures cluster centers span the
  full speed range — a cluster with `speed = −1` will be built from slow columns, `speed = +1` from
  fast ones.

- **`Cluster` class instead of parallel arrays**: eliminates scattered `clusterXxx[clusterIdx]`
  reads.  Makes adding future per-cluster properties (e.g., glyph-set override, opacity multiplier)
  a one-line class property change.

- **Hue rotation placement (fragment, post-composition)**: applies to the final composited color
  including head white, drip, flash, message boost.  All visual elements shift together — the
  cluster identity is perceptually consistent.  If placed pre-composition, the head-white override
  would wash out the hue, making bright heads look monochrome while tails are tinted.

- **Double-speed-bias is intentional**: `cl.speed ∈ [−1, 1]` drives two things.  (a) At geometry
  build time: it centers the per-column speed seed distribution via `cl.speed * 0.5 + 0.5`, so a
  cluster with `speed = +1` gets columns that are already born fast.  (b) At shader time: it is
  stored in `aClusterSpeed` and multiplied by `uClusterSpeedRange`, applying a further boost or
  reduction each frame.  Combined effect: fast clusters have higher base speeds AND a runtime boost;
  slow clusters have lower base speeds AND a runtime reduction.  This compounding makes cluster speed
  identities more legible than either mechanism alone.  At `uClusterSpeedRange = 0` only the
  geometry-baked difference remains; at `uClusterSpeedRange = 1` the shader effectively doubles the
  spread for extreme clusters.

---

## Implementation Plan

**Step 1** — Add `Cluster` class to `matrix-rain-webgpu.js` before `buildGeometry()`.

**Step 2** — In `buildGeometry()`:
  - Replace all `clusterBiases`, `clusterBurstSeeds`, `clusterSpeedSeeds`, `clusterYCenters`,
    `clusterRSeeds`, `clusterPhases`, `squadPhases`, `squadTrailBiases`, `clusterColCount`, and
    `clusterThetas` arrays with a single `clusters` array of `Cluster` instances.
  - Call `clusters.forEach(cl => cl.initSquads(maxSquadsPerCluster))`.
  - In the per-column loop, read from `clusters[clusterIdx]` — theta, burstSeed, yCenter, rSeed,
    speed, and squad data all come from the `Cluster` object.
  - Replace `clusterBiasBuf` with `clusterHueBuf`, `clusterBrightBuf`, `clusterSpeedBuf`.
  - Register the three new attributes; remove `aClusterBias` setAttribute call.

**Step 3** — In `buildGeometry()` reserve pool section:
  - Replace `reserveClusterBias`, `reserveBurstSeed`, and old `reserveSquadPhase` derivation with
    reads from `reserveCl = clusters[nearestCluster]`.
  - Write to `clusterHueBuf`, `clusterBrightBuf`, `clusterSpeedBuf`, `clusterBurstSeedBuf`,
    and `squadPhaseBuf` from the `reserveCl` object.

**Step 4** — In `matrix-rain-tsl.js` `makeUniforms()`:
  - Remove `uClusterBiasAmt`.
  - Add `uClusterHueRange`, `uClusterBrightRange`, `uClusterSpeedRange`.

**Step 5** — In `buildGlyphMaterial()`:
  - Declare `DEG_TO_RAD = float(Math.PI / 180)` and `hueRotateRGB` TSL `Fn` near the top.
  - Remove `aClusterBiasAttr`; add `aClusterHueAttr`, `aClusterBrightAttr`, `aClusterSpeedAttr`.
  - Update the destructure block (remove `uClusterBiasAmt`, add three new uniforms).
  - Replace `aClusterBiasAttr.mul(uClusterBiasAmt)` in the brightness path with
    `aClusterBrightAttr.mul(uClusterBrightRange)`.
  - Replace in the speed path similarly.
  - Declare `vClusterHue = varying(float(), 'vClusterHue')` at builder scope.
  - Add `vClusterHue.assign(0.0)` to the unconditional defaults block.
  - Add `vClusterHue.assign(aClusterHueAttr)` in the vertex Fn (inside density-gate `If`).
  - In the fragment Fn, after the depth-tint `col2.assign(...)`:
    `col2.assign(hueRotateRGB(col2, vClusterHue.mul(uClusterHueRange)))`.

**Step 6** — In `matrix-rain-webgpu.js` handle methods:
  - Remove `setClusterBias`.
  - Add `setClusterHueRange`, `setClusterBrightRange`, `setClusterSpeedRange`.

**Step 7** — In `_geomParams` default object:
  - Remove `clusterBiasAmt`.

**Step 8** — In `matrix-3d.html`:
  - Replace 1 "Cluster bias" slider with 3 sliders.
  - Add/update `linkSlider` bindings.
  - Update `collectSettings` and `applySettings`.
  - Remove `lbl-cluster-bias` from topology visibility map if present.

**Step 9** — Update `CLAUDE.md` uniforms table and handle methods table.

**Step 10** — Update `PROGRESS.md`.

---

## New Uniforms Summary

| Uniform | Default | Range | Purpose |
|---|---|---|---|
| `uClusterHueRange` | `18.0` | 0–45 (degrees) | Max per-cluster hue rotation |
| `uClusterBrightRange` | `0.35` | 0–1 | Per-cluster brightness bias magnitude |
| `uClusterSpeedRange` | `0.30` | 0–1 | Per-cluster speed bias magnitude |

## New Attributes Summary

| Attribute | Replaces | Type | Range | Rebuild? |
|---|---|---|---|---|
| `aClusterHue` | `aClusterBias` (partial) | `float` | [−1, 1] | yes |
| `aClusterBright` | `aClusterBias` (partial) | `float` | [−1, 1] | yes |
| `aClusterSpeed` | `aClusterBias` (partial) | `float` | [−1, 1] | yes |

## Handle Methods Summary

| Method | Replaces | Description |
|---|---|---|
| `setClusterHueRange(v)` | `setClusterBias(v)` | Max hue rotation 0–45° (no rebuild) |
| `setClusterBrightRange(v)` | — | Brightness bias magnitude 0–1 (no rebuild) |
| `setClusterSpeedRange(v)` | — | Speed bias magnitude 0–1 (no rebuild) |

---

## Vertex Buffer Slot Count

| Before | After |
|---|---|
| 9 slots | 11 slots |

Max slots: 16. Headroom: 5 free slots.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `hueRotateRGB` TSL `Fn` signature error (wrong argument types) | Medium | Shader compile failure | Spec provides exact implementation; test with `uClusterHueRange = 0` first |
| `aClusterHue` attribute accessed before geometry rebuild fires | Low | Shader reads stale zero-filled buffer | Uniforms default to correct values; attribute default is 0 (neutral rotation) |
| Speed seed center mapping `cl.speed * 0.5 + 0.5` clips too many columns to min/max speed | Low | Cluster speed diversity reduced | Clamp is `Math.max(0, Math.min(1, ...))` — only extreme clusters are clipped at ±1 seeds |
| `Cluster._colCount` mutation shared across hot-reload of geometry | Very low | Squad assignment off by accumulated count | `buildGeometry()` always creates fresh `Cluster` instances — no cross-call state |
| Old `clusterBias` key in persisted settings breaks `applySettings` | Low | Silently ignored (key not in handle) | Note in edge cases; consider aliasing `setClusterBias` → `setClusterBrightRange` for one release |
| Hue rotation post-composition shifts head-white toward tint color | Low | Head looks tinted at high `uClusterHueRange` | Expected and desired — the cluster identity should be visible at the head. Acceptable at ≤45° |

---

## Test Plan

| Step | Action | Expected |
|---|---|---|
| 1 | Load demo with default settings | Clusters visually distinct — some columns shifted toward teal, some toward yellow-green. Subtle at 18°. |
| 2 | `setClusterHueRange(45)` | Strong hue variation between clusters. Each cluster's columns share the same hue shift. |
| 3 | `setClusterHueRange(0)` | All columns revert to standard Matrix green — no hue shift anywhere. |
| 4 | `setClusterBrightRange(1.0)` | Some clusters are distinctly brighter, others darker. |
| 5 | `setClusterBrightRange(0)` | All clusters visually equal brightness. |
| 6 | `setClusterSpeedRange(1.0)` | Visible speed difference between clusters — fast and slow groups. |
| 7 | `setClusterSpeedRange(0)` | No shader-time speed variation. Clusters may still differ slightly in baked speed (from `cl.speed * 0.5 + 0.5`), but the extra runtime multiplier is gone. |
| 8 | All three sliders at 0 | No hue, shader-brightness, or shader-speed variation. Clusters remain spatially and phase-coherent; geometry-baked speed differences persist. Visually: same color, same brightness, very similar speed groups. |
| 9 | Trigger geometry rebuild (change topology or nCols) | New clusters generate fresh hue/bright/speed seeds — different pattern appears. |
| 10 | Message reveal | Revealed message columns are not affected — message boost and lock-head override take priority as before. |
| 11 | Save/restore settings | `collectSettings()` captures all 3 values; `applySettings()` restores them. |
| 12 | Verify vertex buffer count | DevTools / WebGPU inspection shows ≤ 16 vertex buffer slots. |

---

## Interaction with Other Specs

- **SPEC-eol-effects**: No interaction. EOL flash and freeze operate on cycle phase — independent of cluster attributes.
- **SPEC-message-reveal**: Message lock-head and boost are independent of cluster hue/bright/speed. No conflict.
- **SPEC-ccp-mode-expansion**: CCP mode overrides the `uColor` uniform globally. Per-cluster hue rotation operates on top of the output color, so CCP color + cluster hue = tinted CCP. This is acceptable.
- **SPEC-effects-category-a**: That spec also includes `hueRotateRGB` as a utility. If SPEC-effects-category-a is implemented first, its helper should be promoted to module scope and reused here. If this spec is implemented first, the same helper can be reused by SPEC-effects-category-a.

---

## Review Checklist

- [ ] `Cluster` class: constructor sets `theta`, `hue`, `brightness`, `speed`, `burstSeed`, `yCenter`, `rSeed`, `phase`, `_colCount`; `squadPhases` and `squadTrailBiases` start `null` and are populated by `initSquads()`; `initSquads()` called before first `nextSquadIdx()`
- [ ] `buildGeometry()`: no remaining references to `clusterBiases`, `clusterBurstSeeds`, `clusterSpeedSeeds`, `clusterYCenters`, `clusterRSeeds`, `clusterPhases`, `clusterColCount`, `clusterThetas` (all old arrays removed)
- [ ] `squadPhases` and `squadTrailBiases` reads now go through `cl.squadPhases[...]` and `cl.squadTrailBiases[...]`
- [ ] Angular position uses `cl.theta` (replaces `clusterThetas[clusterIdx]`)
- [ ] Speed seed mapping uses `cl.speed * 0.5 + 0.5` as center (not `cl.speed` directly)
- [ ] Reserve pool reads from `clusters[nearestCluster]`; writes `clusterHueBuf`, `clusterBrightBuf`, `clusterSpeedBuf`, `clusterBurstSeedBuf`, `squadPhaseBuf` from the Cluster object
- [ ] Three new `Float32Array` buffers; three new `setAttribute` calls; `aClusterBias` setAttribute removed
- [ ] `aClusterBias` attribute declaration removed from `matrix-rain-tsl.js`; three new attribute declarations added
- [ ] `uClusterBiasAmt` removed from `makeUniforms()` and destructure; three new uniforms added
- [ ] Brightness path uses `aClusterBrightAttr.mul(uClusterBrightRange)` (not `aClusterBiasAttr`)
- [ ] Speed path uses `aClusterSpeedAttr.mul(uClusterSpeedRange)` (not `aClusterBiasAttr`)
- [ ] `DEG_TO_RAD = float(Math.PI / 180)` defined; no reference to `PI_OVER_180`
- [ ] `hueRotateRGB` TSL Fn defined; accepts `(rgb, angleDeg)` where `angleDeg` is in degrees
- [ ] `vClusterHue` varying declared at builder scope; `vClusterHue.assign(0.0)` in pre-gate defaults block; `vClusterHue.assign(aClusterHueAttr)` in vertex Fn
- [ ] Hue rotation in fragment Fn uses `vClusterHue` (not `aClusterHueAttr` directly); uses `col2.assign(...)` not `col2 = ...`; placed after depth-tint, before final `return`
- [ ] `setClusterBias` removed; `setClusterHueRange`, `setClusterBrightRange`, `setClusterSpeedRange` added
- [ ] `clusterBiasAmt` removed from `_geomParams`
- [ ] Demo: 1 slider replaced by 3; `linkSlider` bindings correct; `collectSettings`/`applySettings` updated
- [ ] CLAUDE.md handle methods and uniforms tables updated
- [ ] PROGRESS.md updated
