# SPEC-cluster-improvements — Cluster mechanic improvements

**Status**: Implemented
**Priority**: P2 — polish; no dependencies on unimplemented specs

---

## Motivation

The column-clustering mechanic was implemented in SPEC-column-clustering.md (3D) and
SPEC-2d-organic.md §3 (2D). Both are functional but have specific weaknesses that reduce
the organic, rainfall-rivulet quality the mechanic exists to create:

**3D positioning:**
- Cluster centers are placed with `Math.random() * 2π`. Centers can themselves cluster
  together, leaving large empty arcs and dense patches — "clusters of cluster centers"
  that the Gaussian per-column spread cannot fix.
- All columns inside a cluster look identical to columns outside it. There is no shared
  visual identity per cluster (clusters lack personality).

**2D temporal activation:**
- The bucket-to-bucket transition uses `smoothstep(0.7, 1.0, bucketFrac)` — smoothing
  occurs only in the last 30% of each bucket. The transition is *asymmetric*: fading
  out toward the next state is gradual, but arriving at the new state is instantaneous.
  From the viewer's perspective: segments snap on and gradually fade off, rather than
  cross-fading smoothly through state boundaries.

---

## Change 1 — 3D: Stratified cluster center placement

### Problem

```js
// current (buildGeometry in matrix-rain-webgpu.js, line ~211)
const clusterThetas = Array.from({ length: nClusters }, () => Math.random() * Math.PI * 2);
```

With 12 clusters and pure `Math.random()`, cluster centers follow a Poisson process on the
circle. The expected maximum inter-center gap is ~93° (= 360° × H₁₂/12 where H₁₂ ≈ 3.1),
meaning a gap of 60°+ is likely on most builds. The probability that at least one pair of
centers lands within 5° of each other (effectively merged, wasting a cluster) is ~83%.
Both artefacts defeat the purpose of clustering: merged cluster centers waste column
budget, and large empty arcs create obvious asymmetry on the shell.

### Fix

Divide the circle into `nClusters` equal arcs; place exactly one cluster center per arc
with uniform random jitter within that arc:

```js
const arcSize = (Math.PI * 2) / nClusters;
const clusterThetas = Array.from({ length: nClusters }, (_, i) =>
  i * arcSize + Math.random() * arcSize
);
```

**Effect**: The gap between consecutive cluster centers is bounded to `(0, 2 × arcSize)`.
No pair of centers can collapse to the same position, and no inter-center gap can exceed
`2 × arcSize`. For 12 clusters (`arcSize = 30°`), the maximum gap is capped at 60° vs.
the current uncapped distribution where the expected maximum gap is ~93°.

**No API change.** Same `clusterCount`/`clusterSpread`/`clusterUniform` params.

### Files changed

| File | Change |
|---|---|
| `matrix-rain-webgpu.js` | Replace `clusterThetas` array initialisation in `buildGeometry()` |

---

## Change 2 — 3D: Per-cluster speed and brightness bias

### Problem

Columns within a cluster are visually indistinguishable from non-cluster columns — there
is no shared identity that lets the eye "group" nearby columns into a rivulet. The cluster
patches are a spatial distribution artefact only, not a visual one.

### Fix

At geometry build time, assign each cluster a bias value in `[-1, +1]`. Columns inherit
their cluster's bias as a new instanced attribute `aClusterBias`. The shader uses it to
slightly shift per-column brightness in the vertex stage, giving each cluster a coherent
personality.

Speed bias is also baked into the geometry buffer so that cluster columns share a
coherent speed — faster or slower as a group.

Default `uClusterBiasAmt = 0.25`. This produces a ~±25% brightness variation per cluster
and a ~±25% speed variation (before the log-bias speed curve), which is within the
existing perceptual range but adds a grouping cue.

### Implementation

**`buildGeometry()` — JS column loop (replace and extend):**

The existing line:
```js
const clustered = clusterThetas[Math.floor(Math.random() * nClusters)] + _gaussRand() * sigma;
```
must be split to save the cluster index — the same index is used for both the theta lookup
and the bias lookup:

```js
// Split the existing clustered line to save clusterIdx:
const clusterIdx = Math.floor(Math.random() * nClusters);
const clustered  = clusterThetas[clusterIdx] + _gaussRand() * sigma;
const colBias    = clusterBiases[clusterIdx];
```

Speed is baked with the bias applied and clamped to `[sMin, sMax]` (prevents unbounded
values at `clusterBiasAmt = 1`):

```js
// Replace the existing speed line:
// Before: const speed = sMin + sr * sr * (sMax - sMin);
// After:
const speed = Math.min(sMax,
  Math.max(sMin, sMin + sr * sr * (sMax - sMin) * (1.0 + colBias * clusterBiasAmt))
);
```

The bias value is broadcast into the new buffer across all rows of the column:

```js
// Inside the existing for (let row = 0; row < N_ROWS; row++) inner loop:
clusterBiasBuf[idx] = colBias;
```

**`buildGeometry()` — preamble (add before column loop):**

```js
// After clusterThetas is built, generate one bias per cluster:
const clusterBiases = Array.from({ length: nClusters }, () => Math.random() * 2 - 1);

// New buffer — one float per instance (same layout as colBuf/rowBuf):
const clusterBiasBuf = new Float32Array(total);
```

**`buildGeometry()` — attribute registration (add alongside existing sets):**

```js
geom.setAttribute('aClusterBias', new THREE.InstancedBufferAttribute(clusterBiasBuf, 1));
```

**`buildGeometry()` — function signature (add parameter):**

```js
function buildGeometry({
  // ... existing params ...
  clusterBiasAmt = 0.25,    // ← add this
} = {}) {
```

**`_geomParams` in `initMatrixRain` (add field):**

```js
const _geomParams = {
  // ... existing fields ...
  clusterBiasAmt: 0.25,
};
```

**`matrix-rain-tsl.js` — `makeUniforms()` (add uniform):**

```js
uClusterBiasAmt: uniform(0.25),   // 0 = no bias, 1 = ±full bias
```

**`matrix-rain-tsl.js` — `buildGlyphMaterial()` destructure (add to existing list):**

```js
const {
  // ... existing uniforms ...
  uClusterBiasAmt,   // ← add this line
} = uniforms;
```

**`matrix-rain-tsl.js` — vertex stage, apply bias to `vAlpha`:**

The bias is applied in the `vertexNode` Fn, exactly where `vAlpha` is assigned (currently
line 268). `attribute()` nodes must be consumed in the vertex stage — reading them in the
fragment stage is not valid in WebGPU.

```js
// Add attribute read near the existing aColAAttr / aColBAttr reads (line ~146):
const aClusterBiasAttr = attribute('aClusterBias', 'float');

// Replace the existing vAlpha assignment (line 268):
// Before:
//   vAlpha.assign(aAlpha.mul(alphaJitter).mul(zoneBrightBias));
// After:
const clusterAlphaMul = float(1.0).add(aClusterBiasAttr.mul(uClusterBiasAmt).mul(0.4));
vAlpha.assign(aAlpha.mul(alphaJitter).mul(zoneBrightBias).mul(clusterAlphaMul));
```

The `0.4` factor keeps the alpha bias subtler than the speed bias. At `uClusterBiasAmt=1`
and `aClusterBias=1`, alpha is multiplied by 1.4 — noticeable but not clipping.
At `aClusterBias=-1`, alpha is multiplied by 0.6 — dimmer but not invisible.

**Handle method (add to 3D rain handle in `initMatrixRain`):**

```js
setClusterBias(v) {
  _geomParams.clusterBiasAmt = Math.max(0, Math.min(1, v));
  uniforms.uClusterBiasAmt.value = _geomParams.clusterBiasAmt;
  rebuildGeom();   // rebuilds speed baking; also re-randomises cluster bias values
},
```

Note: `rebuildGeom()` regenerates `clusterBiases` from scratch (new random `[-1,1]` per
cluster), so calling `setClusterBias` also re-randomises which cluster is fast/slow.
This is consistent with existing behaviour: all `rebuildGeom()` calls already re-randomise
cluster center positions via `clusterThetas`. The bias slider effectively changes the
*magnitude* of cluster personality, not its spatial layout.

### Files changed

| File | Change |
|---|---|
| `matrix-rain-webgpu.js` | Split `clustered` line; add `clusterBiases` array; add `clusterBiasBuf` + attribute; add `clusterBiasAmt` to function signature and `_geomParams`; add `setClusterBias` handle method |
| `matrix-rain-tsl.js` | Add `uClusterBiasAmt` to `makeUniforms()`; add to destructure in `buildGlyphMaterial()`; add `aClusterBias` attribute read; replace `vAlpha.assign()` line |
| `matrix-3d.html` | Add "Cluster bias" slider (0–1, step 0.01, default 0.25) under Distribution panel |

---

## Change 3 — 2D: Symmetric bucket transition

### Problem

Current code in `getStreamNodes()` (`matrix-rain-2d-tsl.js`):

```js
const smoothed = mix(segActive, nextActive, smoothstep(float(0.7), float(1.0), bucketFrac));
```

When `bucketFrac` is in `[0.0, 0.7]`, `smoothed = segActive` exactly — no transition.
When `bucketFrac` reaches `0.7`, the blend begins and reaches `nextActive` at `bucketFrac = 1.0`.

At the instant the next bucket starts (`bucketFrac = 0.0`), the new `segActive` equals
the old `nextActive`, so there is no numerical snap. However, the *shape* of the transition
is lopsided: the fade-*out* of the current state is gradual (30% of bucket duration), but
the fade-*in* of the new state is instantaneous. A cluster appears in one frame and
gradually disappears — not a cross-fade.

### Fix

Replace the entire clustering block in `getStreamNodes()` (from `const seg =` through
`const smoothed =`) with the following. Existing declarations for `seg`, `segSeed`,
`bucketDur`, `bucketPhase`, `bucketIdx`, `segActive`, `bucketFrac`, `nextIdx`,
`nextActive` are retained verbatim; only `smoothed` is replaced, and two new lines
(`prevIdx`, `prevActive`, `fadeIn`, `fadeOut`) are added before it:

```js
// §3 — Column clustering: segment-based activation probability
const seg         = floor(col.div(uClusterWidth));
const segSeed     = h21(vec2(seg.mul(7.31), float(2.11)));
const bucketDur   = segSeed.mul(2.0).add(2.0);                      // 2–4 s per state
const bucketPhase = t.div(bucketDur).add(segSeed.mul(31.0));
const bucketIdx   = floor(bucketPhase);
const segActive   = h21(vec2(seg.mul(3.73), bucketIdx.mul(0.17)));
const bucketFrac  = fract(bucketPhase);
const nextIdx     = bucketIdx.add(1.0);
const nextActive  = h21(vec2(seg.mul(3.73), nextIdx.mul(0.17)));

// Symmetric cross-fade: fade in from prev state (first 15%), stable (70%), fade out (last 15%)
const prevIdx     = bucketIdx.sub(1.0);
const prevActive  = h21(vec2(seg.mul(3.73), prevIdx.mul(0.17)));
const fadeIn      = smoothstep(float(0.0),  float(0.15), bucketFrac);
const fadeOut     = smoothstep(float(0.85), float(1.0),  bucketFrac);
const withFadeIn  = mix(prevActive, segActive, fadeIn);
const smoothed    = mix(withFadeIn, nextActive, fadeOut);
```

**Effect**: each bucket boundary is a symmetric cross-fade lasting 15% of the bucket
duration on each side (total transition time 30%, same as before but symmetric). Clusters
now smoothly appear AND smoothly disappear. At startup (`t ≈ 0`), `prevIdx` resolves to
`floor(segSeed × 31) - 1` — a valid integer; `h21` handles all integer inputs correctly.

**No API change.** No new uniforms, no handle method changes.

### Visual comparison

| Metric | Before | After |
|---|---|---|
| Fade-in duration | 0% of bucket | 15% of bucket |
| Fade-out duration | 30% of bucket | 15% of bucket |
| Stable duration | 70% of bucket | 70% of bucket |
| Total transition time | 30% | 30% (symmetric) |
| Snap artefact on arrival | yes | none |

### Files changed

| File | Change |
|---|---|
| `matrix-rain-2d-tsl.js` | Replace clustering block in `getStreamNodes()` — add `prevIdx`, `prevActive`, `fadeIn`, `fadeOut`; replace `smoothed` line |

---

## Out of scope

- 3D temporal cluster animation (positions are baked; runtime drift would require a
  different architecture)
- 2D inter-segment contagion / sweeping wave-front activation (the existing
  `uPhaseCorrelation` wave already provides spatial sweep at the column level; a
  segment-level sweep would duplicate that at a coarser scale — low marginal gain)
- Cluster size variation in 2D (varying-width segments break `floor(col/segW)` —
  requires a segment-boundary LUT texture, significant complexity for subtle gain)
- Hysteresis near the density threshold (the smooth transition already prevents
  rapid flickering; hard hysteresis adds state that is difficult to represent in TSL)

---

## Tasks

1. **3D stratified placement** — replace `clusterThetas` array init in `buildGeometry()`.
   Two-line change, no shader work. Verify visually: reload 10× and confirm no large
   empty arcs appear consistently.

2. **3D per-cluster bias** — add `clusterBiases` array and `clusterBiasBuf`; split the
   `clustered` line; add `clusterBiasAmt` to function signature and `_geomParams`; add
   `aClusterBias` attribute; update `makeUniforms()`, `buildGlyphMaterial()` destructure,
   and `vAlpha.assign()` in vertex stage; add `setClusterBias` handle method and
   demo slider. Verify: at `clusterBias = 1.0`, some clusters are perceptibly faster
   and brighter than others. At `clusterBias = 0.0`, behaviour is identical to pre-change.

3. **2D symmetric transition** — replace the clustering block in `getStreamNodes()`.
   Six-line change. Verify: a cluster segment at `uClusterWidth = 8` and
   `uClusterStrength = 1.0` fades in gradually, holds, then fades out gradually — no
   instantaneous appearance.

4. **Regression check** — confirm `uClusterStrength = 0.0` (Bernoulli mode) is
   unaffected, `uDensity` slider behaves correctly across modes, and no visual artefact
   appears in any preset.

---

## Verification

| Check | Pass condition |
|---|---|
| 3D reload × 10 | No build has an obviously empty 90°+ arc |
| 3D `clusterBias = 0` | Visually identical to pre-change |
| 3D `clusterBias = 1` | Clusters perceptibly faster/brighter than gaps |
| 2D transition | Segments fade in AND fade out; no pop-in artefact |
| 2D `clusterStrength = 0` | Pure Bernoulli — no change vs pre-spec |
| All presets | No regressions in default/matrix1999/ghost/overdrive |
