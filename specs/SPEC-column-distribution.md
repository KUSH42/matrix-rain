# SPEC-column-distribution

**Status**: Approved
**Priority**: P1

---

## Motivation

The 600 columns are permanently scattered at build time using a single fixed strategy:
12 angular clusters with σ=6° Gaussian jitter, uniform radial spread across
[R_MIN=3.5, R_MAX=8.0], depth-based scale gradient. This produces a convincing
rivulet look but there is no way to change the spatial character of the rain —
tight curtains vs wide scatter, cylindrical vs spherical shell, sparse outer halo
vs dense inner cage.

This spec adds a set of distribution controls covering:
- column count
- shell topology (spherical / cylindrical / flat curtain)
- clustering behaviour (count, spread)
- radial depth bias
- uniform-vs-clustered blend
- runtime-only controls that need no geometry rebuild (radial density taper,
  angular sector density, height fade)

---

## Current System (baseline)

```
buildGeometry() — matrix-rain-webgpu.js
  N_COLS = 600, N_ROWS = 120
  N_CLUSTERS = 12 random cluster centers (uniformly placed around full circle)
  Per column:
    theta = clusterCenter[rand] + _gaussRand() × (6° in radians)   // σ = 6°
    r     = R_MIN + rand()  × (R_MAX − R_MIN)                       // uniform [3.5, 8.0]
    wx    = cos(theta) × r
    wz    = sin(theta) × r
    yOff  = (rand() − 0.5) × WORLD_H                                // uniform [−8, +8]
    scale = (1.45 − t × 0.95) + jitter                              // depth-based, t=(r−R_MIN)/4.5
    alpha = 0.18 + rand() × 0.72                                    // uniform [0.18, 0.90]
    speed = sMin + sr² × (sMax − sMin)                              // log-biased
    trail = tMin + rand() × (tMax − tMin)
```

---

## Options Analysis

### Option A — Shell topology  ★★★ high impact, rebuild

Four meaningfully distinct shapes for (wx, wz):

| Mode | Formula | Character |
|------|---------|-----------|
| `'shell'` | polar: `r ∈ [shellInner, shellOuter]`, `θ` random | current — radial depth volume |
| `'ring'` | `r = (shellInner + shellOuter) / 2` (fixed), `θ` random | cylindrical wall, uniform depth |
| `'curtain'` | `wx ∈ [−shellOuter, +shellOuter]`, `wz = 0` | flat wall facing +Z, minimal parallax |
| `'cube'` | `wx,wz ∈ [−shellOuter, +shellOuter]` uniform 2D scatter | box volume, fills XZ plane |

`'shell'` has rich parallax and depth variation. `'ring'` gives a cleaner
surround-sound feel. `'curtain'` is the classic flat rain wall — good for
backdrops and HUD use. `'cube'` fills a square volume for a dense box effect.

**Radial extent parameters** apply within each topology:
- `shellInner` (default 3.5) — inner bound (shell/ring only)
- `shellOuter` (default 8.0) — outer bound / spread width / box half-extent
- For `'ring'`: `r = (shellInner + shellOuter) / 2`
- For `'curtain'`: spread across `±shellOuter` on X; Z fixed at 0
- For `'cube'`: scatter across `±shellOuter` on both X and Z

All require geometry rebuild.

---

### Option B — Cluster count + spread  ★★★ high impact, rebuild

Two parameters that together control the rivulet/curtain continuum:

```
clusterCount  int   1–36    default 12
clusterSpread float 0–1.0   default 0.017  (σ as fraction of full circle; 0.017 ≈ 6° = current default)
```

- `clusterCount=1, spread=0.02` → single tight waterfall
- `clusterCount=3, spread=0.05` → 3 distinct curtains (The Matrix scene structure)
- `clusterCount=12, spread=0.017` → current default: loose rivulets
- `clusterCount=36, spread=0.10` → visually uniform ring (clusters overlap)

`spread=0` is degenerate (all columns at exactly the cluster angle) so clamp to
`0.003` (≈ 1° σ). At very high spread the cluster count becomes irrelevant; both
knobs together cover the full range from needle-tight to uniform curtain.

Note: `clusterCount`, `clusterSpread`, and `radialBias` are inapplicable in
`'curtain'` and `'cube'` topologies — positions are placed by pure uniform random
regardless of these parameters. They are still stored in `_geomParams` but have no
effect and do not need special-casing in `buildGeometry()`.

Geometry rebuild required.

---

### Option C — Uniform blend  ★★ medium impact, rebuild

A single blend parameter that fades from clustered to fully uniform without touching
clusterCount or spread:

```
clusterUniform  float  0–1  default 0   (0 = pure cluster, 1 = uniform ring)
```

Implementation: lerp between the cluster-jittered angle and a purely random angle.
```
theta = lerp(clusterTheta + gaussRand() × spread × 2π,
             rand() × 2π,
             clusterUniform)
```

This gives a single dial for "how ringed is the rain" independent of cluster count,
useful when animating presets.

Geometry rebuild required.

---

### Option D — Radial bias  ★★★ high impact, rebuild

Controls how columns are distributed between inner and outer shell. Currently uniform.
Uses power-law distribution:

```
radialBias  float  −1–+1  default 0
  −1 → heavily inner-concentrated (cage-like)
   0 → uniform (current)
  +1 → heavily outer-concentrated (thin halo)
```

Implementation: `r = R_MIN + rand()^exp × (R_MAX − R_MIN)` where
`exp = 2^(-radialBias)`:
- `bias=0` → `exp=1` → uniform (current)
- `bias=-1` → `exp=2` → quadratic bias toward inner, approx 75% of columns in
  inner half of the shell
- `bias=+1` → `exp=0.5` → square-root bias toward outer, approx 75% of columns
  in outer half

The depth-based scale is computed from `t=(r−shellInner)/(shellOuter−shellInner)`
as now, so visual scale still adapts correctly regardless of bias.

Geometry rebuild required.

---

### Option E — Column count  ★★★ high impact, rebuild

```
nCols  int  50–1200  default 600
```

Currently hardcoded. Exposing it changes both density and performance budget.
Low values (50–150) create sparse, individually-readable columns; high values
(800–1200) create a dense fog.

`nCols` feeds directly into `buildGeometry()` as a parameter replacing the
`N_COLS` constant. The instanced geometry `count` and all per-instance buffers
resize accordingly.

`_geomParams` (the existing rebuild-trigger object) gains `nCols`.

---

### Option F — Radial density taper  ★★ medium impact, no rebuild

Extends the existing zone system to include density. Currently density is a flat
uniform scalar (`uDensity`). Two new uniforms bias the per-column cull threshold
by radial position:

```
uDensityInner  float  0.0–2.0  default 1.0   (multiplier on inner columns)
uDensityOuter  float  0.0–2.0  default 1.0   (multiplier on outer columns)
```

Effective density for a column at radial factor `t_zone`:
```
effectiveDensity = uDensity × mix(uDensityInner, uDensityOuter, t_zone)
```

Clamp to [0, 1] before comparison.

- `inner=2, outer=0` → outer columns culled, inner cage prominent
- `inner=0, outer=2` → inner columns culled, thin outer halo only
- `inner=1, outer=1` → current flat density (no effect)

No geometry rebuild. Replaces the flat `uDensity` threshold at the density cull
gate with a radially-modulated threshold — see Implementation Plan §3.

---

### Option G — Angular sector density  ★★ medium impact, no rebuild

Concentrate or thin columns in a directional arc. Useful for "rain visible in
front only" or "side curtain" effects:

```
uSectorCenter  float  −π–π    default 0      (angle in XZ plane, 0 = +Z axis)
uSectorWidth   float  0.1–π   default π      (half-angle of the active sector; π = full circle = off)
uSectorStrength float 0–1     default 0      (0 = off, 1 = full mask outside sector)
```

Effective density modifier:
```js
// TSL — atan2 = atan(y, x); wrap via fract to avoid platform fmod issues
const colAngle  = atan(aColAAttr.y, aColAAttr.x);   // aWZ, aWX
const wrapped   = fract(colAngle.sub(uSectorCenter).div(TWO_PI).add(0.5)).mul(TWO_PI).sub(Math.PI);
const angleDist = abs(wrapped);
const sectorMask = float(1).sub(
  uSectorStrength.mul(smoothstep(uSectorWidth.mul(0.85), uSectorWidth, angleDist))
);
// effectiveDensity = zonedDensity × sectorMask (at cull gate)
```

- `strength=1, width=0.5` (≈28°) → narrow front curtain
- `strength=1, width=1.57` (90°) → front hemisphere only
- `strength=0` → no effect (default)

No geometry rebuild. Extends the vertex shader density cull.

---

### Option H — Height fade  ★ low–medium impact, no rebuild

Fade column density toward the top and bottom of the vertical extent:

```
uHeightFade  float  0–1  default 0   (0 = off, 1 = full cosine fade)
```

```js
// TSL — aYOff = aColBAttr.x; use uWorldH uniform (WORLD_H is a JS constant)
const normY      = aColBAttr.x.add(uWorldH.mul(0.5)).div(uWorldH); // [0, 1]
const heightMask = mix(float(1), sin(normY.mul(Math.PI)), uHeightFade);
// effectiveDensity = zonedDensity × heightMask (at cull gate)
```

Columns near Y = ±8 become increasingly sparse. Creates a natural "cylinder cap"
vignette. Low priority since the vertical extent is already large and yOff is
uniform — the effect is subtle unless `uHeightFade > 0.5`.

No geometry rebuild.

---

## Options Verdict

| Option | Impact | Rebuild | Priority |
|--------|--------|---------|----------|
| A — Shell topology | ★★★ | yes | P1 |
| B — Cluster count + spread | ★★★ | yes | P1 |
| C — Uniform blend | ★★ | yes | P2 |
| D — Radial bias | ★★★ | yes | P1 |
| E — Column count | ★★★ | yes | P1 |
| F — Radial density taper | ★★ | no | P1 |
| G — Angular sector density | ★★ | no | P2 |
| H — Height fade | ★ | no | P3 |

**Implement in this spec**: A, B, D, E (all rebuild-based, high impact) and F (no-rebuild,
medium impact, extends existing zone system cleanly). Defer C, G, H — see §Deferred Options.

---

## Implementation Plan

### 1. `_geomParams` extension  (matrix-rain-webgpu.js)

Add new fields with defaults:

```js
const _geomParams = {
  // existing
  speedMin, speedMax, trailMin, trailMax,
  // new
  nCols:          600,
  topology:       'shell',    // 'shell' | 'ring' | 'curtain' | 'cube'
  shellInner:     3.5,
  shellOuter:     8.0,
  clusterCount:   12,
  clusterSpread:  0.017,
  radialBias:     0.0,
};
```

`buildGeometry()` accepts and destructures these. All constants `N_COLS`,
`N_CLUSTERS`, `R_MIN`, `R_MAX` become local derived values from the params.

---

### 2. `buildGeometry()` changes  (matrix-rain-webgpu.js)

#### Column count
```js
const nCols = params.nCols;
// N_ROWS stays 120; total = nCols × N_ROWS
```

#### Cluster generation
```js
const nClusters = Math.max(1, Math.round(params.clusterCount));
const sigma     = Math.max(0.003, params.clusterSpread) * 2 * Math.PI; // σ in radians
const clusterThetas = Array.from({ length: nClusters }, () => Math.random() * 2 * Math.PI);
```

#### Per-column theta
```js
const theta = clusterThetas[Math.floor(Math.random() * nClusters)] + _gaussRand() * sigma;
```

#### Radial bias
```js
const exp = Math.pow(2, -params.radialBias);   // bias=0→exp=1 (uniform)
let r     = shellInner + Math.pow(Math.random(), exp) * (shellOuter - shellInner);
```

#### Topology branching
```js
let wx, wz;
switch (params.topology) {
  case 'ring': {
    const r_ring = (shellInner + shellOuter) / 2;
    wx = Math.cos(theta) * r_ring;
    wz = Math.sin(theta) * r_ring;
    break;
  }
  case 'curtain': {
    wx = (Math.random() * 2 - 1) * shellOuter;
    wz = 0;
    break;
  }
  case 'cube': {
    wx = (Math.random() * 2 - 1) * shellOuter;
    wz = (Math.random() * 2 - 1) * shellOuter;
    break;
  }
  default: // 'shell'
    wx = Math.cos(theta) * r;
    wz = Math.sin(theta) * r;
}
```

After the switch, unify `r` for scale computation:
```js
if (params.topology === 'ring')    r = (shellInner + shellOuter) / 2;
if (params.topology === 'curtain') r = (shellInner + shellOuter) / 2;
if (params.topology === 'cube')    r = Math.min(shellOuter, Math.max(shellInner, Math.sqrt(wx*wx + wz*wz)));
const t     = (r - shellInner) / (shellOuter - shellInner);
const scale = (1.45 - t * 0.95) + (Math.random() - 0.5) * 0.2;
```

This ensures `t` is always in [0, 1] regardless of topology.

Geometry rebuild is triggered by `setColumnCount`, `setTopology`, `setShellRadii`,
`setClusterParams`, and `setRadialBias` via the existing `rebuildGeom()` function
(defined at line 721 in matrix-rain-webgpu.js; assigns to `mesh.geometry` and
`s.geom`).

---

### 3. New uniforms for Option F  (matrix-rain-tsl.js + matrix-rain-webgpu.js)

Two new uniforms in `makeUniforms()`:
```js
uDensityInner: uniform(1.0),
uDensityOuter: uniform(1.0),
```

`t_zone` is currently computed **inside** the density cull block (after the recent
WGSL early-return fix). For Option F it must be moved **before** the density gate
so it is available to compute the zoned threshold. `t_zone` only needs
`aColAAttr.xy` (baked world XZ position), so moving it is safe:

```js
// Move t_zone computation before the density cull:
const r_zone = sqrt(aColAAttr.x.mul(aColAAttr.x).add(aColAAttr.y.mul(aColAAttr.y)));
const t_zone = r_zone.sub(float(3.5)).div(float(4.5)).clamp(0.0, 1.0);

// Replace the flat uDensity comparison with a zoned threshold:
const zonedDensity = uDensity.mul(mix(uDensityInner, uDensityOuter, t_zone)).clamp(0.0, 1.0);
If(h2(vec2(aColIdxAttr.mul(0.137).add(0.5), float(42.7))).lessThanEqual(zonedDensity), () => {
  // ... existing placement block (boot cull, t_zone still available here too) ...
});
```

The `t_zone` computation that was previously inside the cull block is now at the
outer scope and shared by both the gate and the placement block below.

**Hardcoded shell constants in `t_zone`**: The values `3.5` (R_MIN) and `4.5`
(R_MAX − R_MIN) are hardcoded. When `shellInner`/`shellOuter` change, `t_zone`
will be outside [0, 1] but the `clamp(0, 1)` keeps it valid — zone biasing
degrades gracefully to the nearest extreme rather than breaking. A future
improvement (out of scope here) would add `uShellInner`/`uShellRange` uniforms.
Document this limitation in a code comment.

---

### 4. Handle methods  (matrix-rain-webgpu.js)

```js
setColumnCount(n)             // triggers rebuild; clamps to [50, 1200]
setTopology(name)             // 'sphere'|'cylinder'|'curtain'; triggers rebuild
setShellRadii(inner, outer)   // triggers rebuild; clamps inner < outer
setClusterParams(count, spread) // triggers rebuild
setRadialBias(v)              // triggers rebuild; clamps to [−1, +1]
setRadialDensityTaper(inner, outer) // no rebuild; sets uDensityInner/uDensityOuter
```

All rebuild methods mutate `_geomParams` and call `rebuildGeom()`. No guard for
redundant calls needed — the build is cheap enough and the existing `setSpeedRange`/
`setTrailRange` methods also rebuild unconditionally.

---

### 5. Demo controls  (demo.html)

New "Distribution" section in the controls panel:

```
Topology       [select: sphere / cylinder / curtain]
Columns        [range: 50–1200, step 50, default 600]
Shell inner    [range: 1.0–6.0, step 0.5, default 3.5]
Shell outer    [range: 4.0–12.0, step 0.5, default 8.0]
Clusters       [range: 1–36, step 1, default 12]
Cluster spread [range: 0.003–0.5, step 0.001, default 0.017]
Radial bias    [range: −1.0–+1.0, step 0.05, default 0.0]
Density inner  [range: 0–2, step 0.05, default 1.0]
Density outer  [range: 0–2, step 0.05, default 1.0]
```

Debounce rebuild controls (column count, radii, clusters, radial bias) with a
150 ms `setTimeout`/`clearTimeout` delay to avoid thrashing on continuous slider
drag. Topology select triggers immediately (discrete value, single event).
This is a new pattern in demo.html; existing speed/trail controls do not debounce.

---

## Edge Cases

- `shellInner >= shellOuter`: clamp so `shellOuter = shellInner + 0.1`
- `clusterCount = 1`: legal — all columns cluster around one random angle
- `nCols` change disposes old geometry and reallocates all buffers; the existing
  `_geomParams`-based rebuild path handles this
- `topology = 'curtain'`: `t_zone` is computed from `aColAAttr.xy` (wx, wz) in
  the vertex shader; for the curtain `wz=0`, so `r_zone = abs(wx)` and `t_zone`
  represents lateral distance from center rather than radial depth — still
  meaningful for zone speed/brightness effects
- `topology = 'cube'`: `t_zone = sqrt(wx²+wz²)` clamped — columns near the box
  centre are inner-zone, corners are outer-zone; zone controls remain useful
- Radial density taper: `zonedDensity > 1` is legal — it simply makes those
  columns more likely to survive the cull (behaves like density > 1, i.e. always
  active)

---

## Deferred Options

### Option C — Uniform blend  (P2)

A single `clusterUniform` float [0–1] that fades from clustered to fully uniform
without touching clusterCount or spread:

```js
// lerp is pseudocode — JS: a + (b - a) * t
const clustered  = clusterTheta + gaussRand() * sigma;
const uniform_   = Math.random() * 2 * Math.PI;
const theta      = clustered + (uniform_ - clustered) * clusterUniform;
```

Deferred because Options B (cluster spread) + A (topology) already cover this
space. Setting `clusterCount=36, clusterSpread=0.10` achieves a visually uniform
ring; a dedicated blend knob adds a marginal UX improvement only.

---

### Option G — Angular sector density  (P2)

Concentrate or thin columns in a directional arc. Three new uniforms:

```
uSectorCenter   float  −π–π  default 0    (angle in XZ plane, 0 = +Z)
uSectorWidth    float  0–π   default π    (half-angle; π = full circle = disabled)
uSectorStrength float  0–1   default 0    (0 = off, 1 = full mask outside sector)
```

Density modifier in vertex shader:
```js
// TSL — atan2 = atan(y, x) in three/tsl
const colAngle   = atan(aColAAttr.y, aColAAttr.x);   // aWZ, aWX
const rawDiff    = colAngle.sub(uSectorCenter);
const wrapped    = fract(rawDiff.div(TWO_PI).add(0.5)).mul(TWO_PI).sub(Math.PI); // [−π, π]
const angleDist  = abs(wrapped);
const sectorMask = float(1).sub(
  uSectorStrength.mul(smoothstep(uSectorWidth.mul(0.85), uSectorWidth, angleDist))
);
// multiply into zonedDensity at the cull gate
```

Examples:
- `strength=1, width=0.5 (≈28°)` → narrow front curtain
- `strength=1, width=1.57 (90°)` → front hemisphere only
- `strength=0` → no effect

No geometry rebuild. Deferred because it interacts with camera orientation in
non-obvious ways — users rotating the camera expect the sector to stay world-fixed,
but a "face-camera" sector mode is also useful. Needs UX design before implementation.

---

### Option H — Height fade  (P3)

Fade column density toward the top and bottom of the vertical extent:

```
uHeightFade  float  0–1  default 0   (0 = off, 1 = full cosine fade)
```

```js
// TSL — aYOff = aColBAttr.x; WORLD_H not available; use uWorldH uniform
const normY      = aColBAttr.x.add(uWorldH.mul(0.5)).div(uWorldH); // [0, 1]
const heightMask = mix(float(1), sin(normY.mul(Math.PI)), uHeightFade);
```

No rebuild. Low priority: the effect is subtle unless `uHeightFade > 0.5` because
`yOff` is already uniformly spread across the full vertical extent.

---

## Out of Scope

- **Vertical distribution controls** (yOff range): low visual impact, deferred indefinitely
- **Alpha/trail distribution shaping**: covered by existing `setTrailRange`

---

## Related changes already implemented

### Max yaw control (replaces `setYawAligned`)

`uYawAligned` (0–1 blend between converge-to-target and face-camera) was replaced
with `uMaxYaw` (max angular deviation from camera direction, in radians). The new
handle method is `setMaxYaw(degrees)` which converts to radians internally.

The shader now computes a proper angular clamp instead of a linear blend:
```js
// Normalise target→camera delta to [−π, π] to handle wrap-around
const delta      = fract(rawDelta / (2π) + 0.5) × 2π − π
const blendedAngle = camAngle + clamp(delta, −uMaxYaw, +uMaxYaw)
```

- `maxYaw = 0°` → all columns forced to face camera exactly
- `maxYaw = 180°` → unconstrained (columns face their natural inward target)

Demo control changed from checkbox to range slider (0–180°, default 180°).
