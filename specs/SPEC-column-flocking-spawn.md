# SPEC-column-flocking-spawn — Column Flocking & Spawn Helpers

**Status**: Implemented
**Priority**: P2 — polish / capability; no hard dependencies on unimplemented specs
**Research**: `RESEARCH-column-flocking-spawn.md`

---

## Motivation

The column system currently has no inter-column coupling beyond static spatial clustering.
Each column bursts, speeds, and cycles completely independently. This spec adds:

1. **Cluster Burst Contagion** — when a cluster's periodic burst fires, neighbouring
   columns in the same cluster are pulled along, creating rhythmic group pulses.
2. **Speed Entrainment Wave** — a second angular wave (independent of the existing
   position wave) modulates `speedMul` across the shell, producing visible tidal sweeps.
3. **Spawn Reserve Pool** — a pre-allocated set of columns that can be teleported to any
   world position at runtime, eliminating the 75%-fallback problem in message reveal.
4. **Squad Phase Coherence + Trail Cohesion** — columns within a squad share a cycle-phase
   seed so their heads arrive at similar elevations simultaneously; squads also share a
   trail-length bias for visual identity.
5. **Spawn Wave** — a wave front sweeps around the shell activating columns in sequence,
   enabling cinematic entrance and exit effects.

---

## Constraints

- No compute shaders, no SSBO. Inter-column communication on the GPU is not available.
- All group behaviour must be either: baked into attributes at `buildGeometry()` time, or
  driven by a per-frame JS uniform, or resolved by CPU writes to individual column rows.
- CPU attribute writes are acceptable for ≤ 600 columns × 120 rows given the write path
  (`Float32Array` + `needsUpdate = true`), used sparingly.

---

## Scope

| File | Changes |
|---|---|
| `matrix-rain-tsl.js` | New uniforms in `makeUniforms()`; new attributes + shader logic in `buildGlyphMaterial()` |
| `matrix-rain-webgpu.js` | New `buildGeometry()` params; new handle methods; spawn reserve pool; spawn wave animation |
| `matrix-3d.html` | New sliders / controls per change |

**Not changed**: `matrix-rain-passes-tsl.js`, `matrix-rain-presets.js`, `demo.html`

---

## Change 1 — Cluster Burst Contagion

### Problem

Burst events fire per-column with probability `uBurstProb`. Clusters have no shared burst
identity — visually they are a spatial clustering only, with no temporal coherence.

### Fix

Add a float attribute `aClusterBurstSeed` per column (same value for all rows of a column;
same value for all columns in the same cluster). In the shader, each cluster has a periodic
burst window (4 s cycle, matching the existing `burstCycle`). When the cluster's window is
open, columns within it fire a "contagion burst" with probability `uContagionStrength`.

### Implementation

**`buildGeometry()` — preamble (alongside existing `clusterBiases`):**

```js
// Add alongside clusterBiases:
const clusterBurstSeeds = Array.from({ length: nClusters }, () => Math.random());

// New buffer alongside clusterBiasBuf:
const clusterBurstSeedBuf = new Float32Array(total);
```

**`buildGeometry()` — column loop (alongside `colBias` assignment):**

```js
// Alongside: const colBias = clusterBiases[clusterIdx];
const colBurstSeed = clusterBurstSeeds[clusterIdx];
```

**`buildGeometry()` — inner row loop (alongside `clusterBiasBuf[idx] = colBias`):**

```js
// Alongside: clusterBiasBuf[idx] = colBias;
clusterBurstSeedBuf[idx] = colBurstSeed;
```

**`buildGeometry()` — attribute registration (alongside `aClusterBias`):**

```js
// Alongside: geom.setAttribute('aClusterBias', ...);
geom.setAttribute('aClusterBurstSeed', new THREE.InstancedBufferAttribute(clusterBurstSeedBuf, 1));
```

**`makeUniforms()` in `matrix-rain-tsl.js` (add after `uBurstProb`):**

```js
uContagionStrength: uniform(0.0),   // fraction of cluster members joining a cluster burst 0–1
```

**`buildGlyphMaterial()` — destructure (add after `uBurstProb`):**

```js
uContagionStrength,
```

**`buildGlyphMaterial()` — attribute reads (add after `aClusterBiasAttr` line ~153):**

```js
const aClusterBurstSeedAttr = attribute('aClusterBurstSeed', 'float');
```

**`buildGlyphMaterial()` — vertex stage, after `burstFrac` is computed (~line 309):**

Existing block to extend (lines ~303–320):
```js
const burstCycle  = float(4.0);
const burstBucket = floor(uTime.div(burstCycle));
const burstH      = h2(vec2(aColIdxAttr.mul(0.41), burstBucket.mul(0.19)));
const burstActive = step(float(1).sub(uBurstProb), burstH);
const burstPhase  = fract(uTime.div(burstCycle));
const burstFrac   = smoothstep(0.0, 0.1, burstPhase)
  .mul(float(1).sub(smoothstep(0.25, 0.35, burstPhase)));
```

Replace `const burstActive = ...` line with:

```js
const burstIndiv  = step(float(1).sub(uBurstProb), burstH);
// Cluster contagion: all columns in a cluster fire when its periodic window is open
const clusterBurstPhase  = fract(uTime.div(burstCycle).add(aClusterBurstSeedAttr));
const clusterIsBursting  = step(clusterBurstPhase, float(0.08));
const colContagionRand   = h2(vec2(aColIdxAttr.mul(0.53), float(0.13)));
const contagionBurst     = clusterIsBursting.mul(step(colContagionRand, uContagionStrength));
const burstActive        = burstIndiv.add(contagionBurst).clamp(0.0, 1.0);
```

The cluster window is 8 % of the 4 s cycle = 320 ms. Each cluster's window fires at a
different time, offset by `aClusterBurstSeed ∈ [0, 1)`. Clusters desync from each other
automatically. `uContagionStrength = 0` → pure per-column stochastic (unchanged).
`uContagionStrength = 1` → every cluster member bursts during the window.

**Handle method (add to handle in `initMatrixRain`):**

```js
setContagion(v) {
  uniforms.uContagionStrength.value = Math.max(0, Math.min(1, v));
},
```

### Files changed

| File | Change |
|---|---|
| `matrix-rain-webgpu.js` | `clusterBurstSeeds` array; `clusterBurstSeedBuf`; column loop assignment; attribute registration |
| `matrix-rain-tsl.js` | `uContagionStrength` in `makeUniforms()`; attribute read; replace `burstActive` line |
| `matrix-3d.html` | "Contagion strength" slider (0–1, step 0.01, default 0) under Clusters panel |

---

## Change 2 — Speed Entrainment Wave

### Problem

`uBreathAmt` oscillates every column's speed uniformly (global). `uWaveAmt` displaces glyph
*positions* in world Y. Neither creates a spatially-structured speed variation that sweeps
visibly through the rain field.

### Fix

A second angular wave modulates `speedMul`, independent of `uWaveAmt`. Same `thetaWave`
already computed; no new attributes. Three new uniforms.

### Implementation

**`makeUniforms()` — add after `uWaveCrests`:**

```js
uEntrainAmt:    uniform(0.0),   // speed-entrainment wave amplitude — 0 = off, range 0–0.8
uEntrainSpeed:  uniform(0.25),  // entrainment wave angular speed rad/s
uEntrainCrests: uniform(3.0),   // entrainment crests around shell (integer 1–12)
```

**`buildGlyphMaterial()` — destructure (add after `uWaveCrests`):**

```js
uEntrainAmt, uEntrainSpeed, uEntrainCrests,
```

**`buildGlyphMaterial()` — vertex stage, before the `burstCycle` block (~line 303):**

`thetaWave` already exists at line 326 (used for `waveOffset`) but is needed earlier for
`entrainWave`. Since it only depends on per-column position (`aWZ`, `aWX`) which are
available from the start of the vertex function, add it — and `entrainWave` — immediately
before `speedMul` so there is no forward reference:

```js
// Add before the burstCycle / breathAdd block:
// Speed entrainment wave — computed here so it is in scope for speedMul below.
// thetaWave mirrors the declaration at ~line 326; the duplicate is harmless in TSL
// (same node expression, no extra GPU cost).
const thetaEntrain  = atan(aWZ, aWX);   // −π..π, same as later thetaWave
const entrainWave   = sin(
  thetaEntrain.mul(uEntrainCrests).add(uTime.mul(uEntrainSpeed))
).mul(uEntrainAmt);
```

Then extend the existing `speedMul` line (~line 317) — it immediately follows the burst /
breath block — adding the entrainment factor at the end:

```js
// Before:
const speedMul = max(float(0.01), uSpeedMul.add(breathAdd))
  .mul(float(1).add(burstActive.mul(burstFrac).mul(2)))
  .mul(zoneSpeedBias);

// After:
const speedMul = max(float(0.01), uSpeedMul.add(breathAdd))
  .mul(float(1).add(burstActive.mul(burstFrac).mul(2)))
  .mul(zoneSpeedBias)
  .mul(float(1).add(entrainWave));
```

`entrainWave ∈ [−uEntrainAmt, +uEntrainAmt]`. At `uEntrainAmt = 0.5`, speedMul varies
±50 % as the crest passes. Because `max(0.01, ...)` is applied before the entrainment
multiply, columns cannot stop or reverse.

The existing `thetaWave` / `waveOffset` declarations at ~line 326 are left in place —
they use the same expression and TSL's node deduplication ensures no extra GPU computation.

**Handle method:**

```js
setEntrainment(amt, speed = 0.25, crests = 3) {
  uniforms.uEntrainAmt.value    = Math.max(0, Math.min(0.8, amt));
  uniforms.uEntrainSpeed.value  = speed;
  uniforms.uEntrainCrests.value = Math.round(Math.max(1, Math.min(12, crests)));
},
```

### Files changed

| File | Change |
|---|---|
| `matrix-rain-tsl.js` | 3 new uniforms; destructure; `entrainWave` expression; extend `speedMul` |
| `matrix-3d.html` | "Entrainment" slider (0–0.8, step 0.01, default 0) under Distribution panel |

---

## Change 3 — Spawn Reserve Pool

### Problem

`showMessage()` projects columns to screen space and assigns the nearest column to each
character slot. If no column is close enough, a "fallback spawn" fires at 75 % of
`revealDuration` — too late for a clean reveal. The nearest-column search is also fragile
when density is low or columns are spread unevenly.

### Fix

Pre-allocate N "reserve" columns in the geometry, spread at regular angular intervals
around the shell. They render as normal rain until claimed — no special invisibility
mechanism is needed or attempted. When claimed for a message slot, the reserve's `aYOff`
is adjusted to bring its head to `worldY` (the same `aYOff` manipulation used by the
existing spawn-below mechanism), and `aLockState.w = 1` is set so the shader's
`isSpawnActive` bypass keeps it visible regardless of density or frustum cull. On release,
`aYOff` is restored and `aLockState` is cleared.

The advantage over the current approach: the reserve pool is a dedicated set of columns
that can always be claimed for message reveal without competing with the existing
nearest-column search. Since they are spread evenly around the shell, at least one reserve
will always project to a screen X close to any character slot.

**No new shader code.** The existing `isSpawnActive` bypass (`aLockState.w = 1`) is all
that is needed.

### Implementation

**`buildGeometry()` — function signature (add parameter):**

```js
function buildGeometry({
  // ... existing params ...
  spawnReserves = 48,   // ← add: number of pre-allocated reserve columns
} = {}) {
```

**`buildGeometry()` — after the column loop, before attribute registration:**

The last `spawnReserves` columns are the reserve pool. Overwrite their `aColA.xy` to
place them at evenly-spaced angles on the inner shell (`r = shellInner`), so they project
to predictable screen X positions from any camera angle. Store each column's original
`aYOff` (needed for release), the reserved angular positions (for screen-projection during
matching), and the `reserveStart` index.

```js
const reserveStart = nCols - spawnReserves;
const reserveOrigYOff = new Float32Array(spawnReserves);  // original aYOff per reserve
for (let i = 0; i < spawnReserves; i++) {
  const c     = reserveStart + i;
  const angle = (i / spawnReserves) * Math.PI * 2;        // evenly spaced
  const rwx   = Math.cos(angle) * inner;
  const rwz   = Math.sin(angle) * inner;
  const base  = c * N_ROWS;
  reserveOrigYOff[i] = colBBuf[base * 4];                 // save original aYOff
  for (let r = 0; r < N_ROWS; r++) {
    const i4 = (base + r) * 4;
    colABuf[i4]     = rwx;
    colABuf[i4 + 1] = rwz;
  }
}
geom._reservePool = {
  reserveStart,
  free:         Array.from({ length: spawnReserves }, (_, i) => reserveStart + i),
  used:         new Set(),
  origYOff:     reserveOrigYOff,
};
```

**JS module scope — add two helper functions alongside `_writeLockRows`:**

```js
/**
 * Claim the best-matching free reserve column for a message slot.
 * "Best" = closest by screen X projection to slotScreenX.
 * Adjusts aYOff so the head reaches worldY (spawn-below mechanism).
 * Sets spawnActive=1 to bypass density+frustum cull.
 * Returns the column index, or -1 if pool is empty.
 */
function _claimReserve(pool, slotScreenX, worldY, colABuf, colBBuf, lockData,
                        colAAttr, colBAttr, lockAttr, nRows, vpMat) {
  if (!pool || pool.free.length === 0) return -1;
  // Project free reserves to screen X; pick closest to slotScreenX
  const tmpV = new THREE.Vector4();
  let bestDist = Infinity, bestFreeIdx = -1;
  for (let fi = 0; fi < pool.free.length; fi++) {
    const c    = pool.free[fi];
    const base = c * nRows * 4;
    const wx   = colABuf[base];
    const wz   = colABuf[base + 1];
    tmpV.set(wx, worldY, wz, 1.0).applyMatrix4(vpMat);
    if (tmpV.w <= 0) continue;
    const sx   = (tmpV.x / tmpV.w + 1.0) * 0.5;
    const dist = Math.abs(sx - slotScreenX);
    if (dist < bestDist) { bestDist = dist; bestFreeIdx = fi; }
  }
  if (bestFreeIdx < 0) return -1;

  const c = pool.free.splice(bestFreeIdx, 1)[0];
  pool.used.add(c);

  // Mark spawnActive=1 so isSpawnActive bypasses density+frustum cull
  for (let r = 0; r < nRows; r++) {
    lockData[(c * nRows + r) * 4 + 3] = 1.0;
  }
  lockAttr.needsUpdate = true;
  return c;
  // NOTE: aYOff adjustment is done at the call site — see snippet below.
}

/**
 * Release a reserve column; restore its aYOff and clear lock state.
 */
function _releaseReserve(pool, colIdx, colBBuf, lockData, colBAttr, lockAttr, nRows) {
  if (!pool) return;
  const origIdx  = colIdx - pool.reserveStart;
  const origYOff = pool.origYOff[origIdx];
  const base     = colIdx * nRows;
  for (let r = 0; r < nRows; r++) {
    colBBuf[(base + r) * 4]     = origYOff;
    lockData[(base + r) * 4 + 0] = -9999;
    lockData[(base + r) * 4 + 1] = -1;
    lockData[(base + r) * 4 + 2] = 0;
    lockData[(base + r) * 4 + 3] = 0;
  }
  colBAttr.needsUpdate  = true;
  lockAttr.needsUpdate  = true;
  pool.used.delete(colIdx);
  pool.free.push(colIdx);
}
```

The `aYOff` adjustment inside `_claimReserve` is left as a note above because it uses
`uniforms.uTime.value` which is a closure variable inside `initMatrixRain`. In practice,
the implementation should inline the `aYOff` write at the call site (same pattern as the
existing spawn-below code at lines 1195–1204):

```js
// At call site, after _claimReserve returns colIdx ≥ 0:
const cs   = uniforms.uCellH.value * colBBuf[colIdx * nRows * 4 + 1] * 1.85;
const ch   = uniforms.uWorldH.value + nRows * cs;
const cp   = ((t * colABuf[colIdx * nRows * 4 + 2] * Math.max(0.01, uniforms.uSpeedMul.value)
               + colABuf[colIdx * nRows * 4 + 3] * ch) % ch + ch) % ch;
const newYOff = worldY - uniforms.uWorldH.value / 2 + cp;
for (let r = 0; r < nRows; r++) colBBuf[(colIdx * nRows + r) * 4] = newYOff;
colBAttr.needsUpdate = true;
```

**`tick()` — per-slot recruitment (lines ~1171–1189):**

The per-tick slot recruitment is where new columns are assigned during the `'revealing'`
phase. Search the reserve pool **first**, before the regular column scan:

```js
// ── Recruit a column for unassigned slots ─────────────────────────────
if (slot.colIdx < 0) {
  // Try reserve pool first
  let bestCol = _claimReserve(geomNow._reservePool, slot.screenX, _msgWorldY,
    colABuf, colBBuf, lockData, colAAttr, colBAttr, lockAttr, nRows, vpMat2);
  if (bestCol >= 0) {
    // aYOff adjustment (inline at call site — see above)
    // ...
    slot.colIdx = bestCol;
    _msgAssigned.set(bestCol, si);
    _writeLockRows(lockData, nRows, bestCol, _msgWorldY, slot.glyph, 0, 0);
    lockDirty = true;
  } else {
    // Pool exhausted — fall through to existing nearest-column search
    // (existing for-loop over all columns, unchanged)
  }
}
```

**`_clearAllLocks()` — release all reserves on clear:**

`_clearAllLocks()` currently only fetches `aLockState`. Extend it to also fetch `aColB`
for the `_releaseReserve` call:

```js
// Add after existing const lockData = lockAttr.array; line:
const colBAttr2 = geomNow.getAttribute('aColB');
const colBBuf2  = colBAttr2?.array;

// After the existing _msgLockedCols / _msgSpawnCols / _msgAssigned loops:
const pool = geomNow._reservePool;
if (pool && colBBuf2) {
  for (const c of [...pool.used]) {
    _releaseReserve(pool, c, colBBuf2, lockData, colBAttr2, lockAttr, nRows);
  }
}
```

(`[...pool.used]` copies the set before iterating since `_releaseReserve` calls `pool.used.delete`.)

**`_geomParams` — add field:**

```js
const _geomParams = {
  // ... existing ...
  spawnReserves: 48,
};
```

No handle method exposed — internal infrastructure. Reserve count changed by modifying
`_geomParams.spawnReserves` before `rebuildGeom()`.

### Files changed

| File | Change |
|---|---|
| `matrix-rain-webgpu.js` | `spawnReserves` param; reserve position overwrite + `_reservePool` on geom; `_claimReserve` / `_releaseReserve` helpers; tick slot-recruitment checks reserve pool first; `_clearAllLocks()` releases used reserves |

---

## Change 4 — Squad Phase Coherence + Trail Cohesion

### Problem

Columns within a cluster share speed bias and angular position, but their fall cycle is
phase-randomised independently. There is no temporal grouping — cluster members cannot be
perceived as "moving together".

### Fix

Assign columns to "squads" of `squadSize` within their cluster. All squad members share
a cycle-phase seed (`aSquadPhase`). A runtime uniform `uSquadCoherence` blends between
full squad coherence (0) and full individual randomness (1), so the effect is tunable
without a geometry rebuild.

Trail cohesion is added at the same time: each squad gets a shared `squadTrailBias`
applied when baking `aColB.w` — visually tighter squads (narrow trails) vs looser ones
(wide trails).

### Implementation

**`buildGeometry()` — function signature:**

```js
function buildGeometry({
  // ... existing params ...
  squadSize      = 5,     // columns per squad; squads are formed within clusters
  trailCohesion  = 0.5,   // 0 = no trail cohesion, 1 = full squad trail bias
} = {}) {
```

**`buildGeometry()` — preamble (after `clusterBiases`):**

```js
// Build squad structure — one squad per ⌈cluster_size / squadSize⌉ within each cluster.
// squadPhases[clusterId][squadSubIdx] = shared phase seed [0, 1]
// squadTrailBiases[clusterId][squadSubIdx] = trail bias [-1, 1]
//
// Size per cluster: worst case ALL nCols land in one cluster, needing ceil(nCols/squadSize)
// squad entries. Use that as the upper bound (+2 safety) to avoid any out-of-bounds access
// regardless of how random cluster assignment distributes columns.
const maxSquadsPerCluster = Math.ceil(nCols / squadSize) + 2;
const squadPhases      = Array.from({ length: nClusters }, () =>
  Array.from({ length: maxSquadsPerCluster }, () => Math.random())
);
const squadTrailBiases = Array.from({ length: nClusters }, () =>
  Array.from({ length: maxSquadsPerCluster }, () => Math.random() * 2 - 1)
);
// Column counter per cluster — used to assign squad sub-index round-robin
const clusterColCount = new Int32Array(nClusters);

// New buffer — one float per instance
const squadPhaseBuf = new Float32Array(total);
```

**`buildGeometry()` — column loop, alongside `colBias` assignment:**

```js
const squadSubIdx  = Math.floor(clusterColCount[clusterIdx] / squadSize);
const colSquadPhase = squadPhases[clusterIdx][squadSubIdx];
const colTrailBias  = squadTrailBiases[clusterIdx][squadSubIdx];
clusterColCount[clusterIdx]++;
```

**`buildGeometry()` — column loop, trail line (~line 291):**

```js
// Before (actual code order):
rawTrailBuf[c] = tr;
const trail = tMin + tr * (tMax - tMin);
// After:
const biasedTr = Math.max(0, Math.min(1, tr + colTrailBias * 0.5 * trailCohesion));
rawTrailBuf[c] = biasedTr;   // store biasedTr so setTrailRange preserves relative cohesion
const trail    = tMin + biasedTr * (tMax - tMin);
```

Storing `biasedTr` rather than `tr` in `rawTrailBuf[c]` ensures that `setTrailRange()`
— which recomputes `trail = tMin + rawTrailBuf[c] * (tMax - tMin)` for each column —
scales the biased values uniformly. The relative trail-length differences between squads
are preserved across range changes. (Analogous to how `aClusterBias` permanently shifts
speed identity: cohesion is baked into the column's raw value.)

**`buildGeometry()` — inner row loop, alongside `clusterBiasBuf[idx]` line:**

```js
squadPhaseBuf[idx] = colSquadPhase;
```

**`buildGeometry()` — attribute registration:**

```js
geom.setAttribute('aSquadPhase', new THREE.InstancedBufferAttribute(squadPhaseBuf, 1));
```

**`_geomParams` — add fields:**

```js
const _geomParams = {
  // ... existing ...
  squadSize:     5,
  trailCohesion: 0.5,
};
```

**`makeUniforms()` in `matrix-rain-tsl.js` (add after `uClusterBiasAmt`):**

```js
uSquadCoherence: uniform(1.0),  // 0 = full squad phase lock, 1 = individual random (default)
```

**`buildGlyphMaterial()` — destructure (add):**

```js
uSquadCoherence,
```

**`buildGlyphMaterial()` — attribute reads (add after `aClusterBurstSeedAttr`):**

```js
const aSquadPhaseAttr = attribute('aSquadPhase', 'float');
```

**`buildGlyphMaterial()` — vertex stage, `cyclePos` line (~line 330):**

```js
// Before:
const cyclePos  = mod(
  uTime.mul(aSpeed).mul(speedMul).add(aSeed.mul(cycleH)),
  cycleH
);

// After:
const phaseSeed = mix(aSquadPhaseAttr, aSeed, uSquadCoherence);
const cyclePos  = mod(
  uTime.mul(aSpeed).mul(speedMul).add(phaseSeed.mul(cycleH)),
  cycleH
);
```

`aSeed` continues to be used as-is for breath-phase hash, glyph-selection scramble, etc.
The blend only affects the cycle-position phase seed.

At `uSquadCoherence = 1.0` (default): `phaseSeed = aSeed` → behaviour identical to
pre-spec.  At `uSquadCoherence = 0.0`: all squad members share the same `aSquadPhase`,
so their heads travel in sync. The mix produces a smooth parameter between these extremes.

**Handle methods:**

```js
setSquadCoherence(v) {
  uniforms.uSquadCoherence.value = Math.max(0, Math.min(1, v));
},
setSquadSize(n) {
  _geomParams.squadSize = Math.max(2, Math.min(20, Math.round(n)));
  rebuildGeom();
},
setTrailCohesion(v) {
  _geomParams.trailCohesion = Math.max(0, Math.min(1, v));
  rebuildGeom();
},
```

### Files changed

| File | Change |
|---|---|
| `matrix-rain-webgpu.js` | `squadSize` + `trailCohesion` params; squad struct arrays + counter; `colSquadPhase` / `colTrailBias` per column; biased trail bake; `squadPhaseBuf` + attribute; `_geomParams` fields; 3 handle methods |
| `matrix-rain-tsl.js` | `uSquadCoherence` uniform; attribute read; replace `cyclePos` line |
| `matrix-3d.html` | "Squad coherence" slider (0–1, step 0.01, default 1.0); "Trail cohesion" slider (0–1, step 0.01, default 0.5) under Clusters panel |

---

## Change 5 — Spawn Wave

### Problem

There is no way to animate the appearance or disappearance of rain as a sweeping front.
`uDensity` changes density globally and uniformly. `uSectorStrength` carves a static
angular window. Neither produces the cinematic "rain curtain sweeping in" effect.

### Fix

Bake a per-column angular threshold `aSpawnTheta` ∈ [0, 1] at geometry time (column's
normalised position on the [0, 2π] circle). A uniform `uSpawnWaveFront` acts as a
gatekeeper: columns with `aSpawnTheta < uSpawnWaveFront` are allowed to proceed through
the density+frustum gate; others are suppressed. Animating `uSpawnWaveFront` from 0 → 1
sweeps the rain in around the shell.

### Implementation

**`buildGeometry()` — preamble:**

```js
const spawnThetaBuf = new Float32Array(total);
```

**`buildGeometry()` — column loop, after `wx` / `wz` are determined:**

```js
// Normalise angular position to [0, 1] — constant regardless of topology.
// For non-shell topologies wx/wz may not represent a true angle; fall back to theta.
const colTheta   = topology === 'shell' || topology === 'ring'
  ? ((Math.atan2(wz, wx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)
  : ((theta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);
```

**`buildGeometry()` — inner row loop:**

```js
spawnThetaBuf[idx] = colTheta;
```

**`buildGeometry()` — attribute registration:**

```js
geom.setAttribute('aSpawnTheta', new THREE.InstancedBufferAttribute(spawnThetaBuf, 1));
```

**`makeUniforms()` (add after `uSectorStrength`):**

```js
uSpawnWaveFront: uniform(2.0),   // wave-front gate: columns with aSpawnTheta < front are active
                                  // 2.0 = all active (default); < 0 = all suppressed
```

**`buildGlyphMaterial()` — destructure:**

```js
uSpawnWaveFront,
```

**`buildGlyphMaterial()` — attribute reads (add after `aFrustumVisAttr`):**

```js
const aSpawnThetaAttr = attribute('aSpawnTheta', 'float');
```

**`buildGlyphMaterial()` — vertex stage, density gate (~line 275):**

Add `spawnGatePasses` check. The gate only suppresses normal density rendering; `isLocked`
and `isSpawnActive` columns (message reveal, reserves) always bypass it.

```js
// After zonedDensity computation, before the isLocked / isSpawnActive reads:
const spawnGatePasses = aSpawnThetaAttr.lessThan(uSpawnWaveFront);

// Modify the existing If() condition — add .and(spawnGatePasses) to the density branch:
// Before:
If(densityPasses.and(aFrustumVisAttr.greaterThan(float(0.5))).or(isLocked).or(isSpawnActive), () => {
// After:
If(densityPasses.and(aFrustumVisAttr.greaterThan(float(0.5))).and(spawnGatePasses).or(isLocked).or(isSpawnActive), () => {
```

**JS animation helper — add to `initMatrixRain` state:**

```js
let _spawnWaveAnim = null;   // { startTime, endTime, startFront, endFront } or null
```

Add to the RAF `animate(ts)` loop (alongside burst-bloom animation, breath updates, etc.):

```js
// Spawn wave animation
if (_spawnWaveAnim) {
  const { startTime, endTime, startFront, endFront, easing } = _spawnWaveAnim;
  const elapsed  = (ts / 1000) - startTime;
  const duration = endTime - startTime;
  let t = Math.max(0, Math.min(1, elapsed / duration));
  if (easing === 'ease-in')  t = t * t;
  if (easing === 'ease-out') t = 1 - (1 - t) * (1 - t);
  if (easing === 'ease')     t = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  uniforms.uSpawnWaveFront.value = startFront + (endFront - startFront) * t;
  if (elapsed >= duration) _spawnWaveAnim = null;
}
```

**Handle methods:**

```js
spawnWave({ duration = 2.0, easing = 'ease', startAngle = 0 } = {}) {
  // startAngle: starting fraction of the circle [0, 1] (default 0 = -X axis)
  const now = performance.now() / 1000;
  uniforms.uSpawnWaveFront.value = startAngle;
  _spawnWaveAnim = { startTime: now, endTime: now + duration,
    startFront: startAngle, endFront: startAngle + 1.0, easing };
},
despawnWave({ duration = 1.5, easing = 'ease' } = {}) {
  const now     = performance.now() / 1000;
  const current = uniforms.uSpawnWaveFront.value;
  _spawnWaveAnim = { startTime: now, endTime: now + duration,
    startFront: current, endFront: -1.0, easing };
},
setSpawnWaveFront(v) {
  _spawnWaveAnim = null;
  uniforms.uSpawnWaveFront.value = v;
},
```

### Notes on `startAngle`

The wave sweeps counterclockwise from `startAngle` (fraction of circle). `startAngle = 0`
begins at the -X axis and sweeps to the +X → +Z side. Any `startAngle` value shifts the
sweep origin. For a "left screen to right screen" appearance from the default camera angle,
`startAngle ≈ 0.25` (near the +Z axis, which faces the camera).

### Files changed

| File | Change |
|---|---|
| `matrix-rain-webgpu.js` | `spawnThetaBuf`; `colTheta` per column; inner row write; attribute registration; `uSpawnWaveFront` uniform; `_spawnWaveAnim` state; animation tick logic; 3 handle methods |
| `matrix-rain-tsl.js` | `uSpawnWaveFront` uniform; attribute read; `spawnGatePasses`; modify `If()` condition |
| `matrix-3d.html` | "Spawn wave front" slider (−0.1–1.1, step 0.01, default 2.0 = all visible); "Spawn wave in / out" buttons |

---

## Uniform Summary

| Uniform | Default | Range | Change |
|---|---|---|---|
| `uContagionStrength` | 0.0 | 0–1 | Change 1 |
| `uEntrainAmt` | 0.0 | 0–0.8 | Change 2 |
| `uEntrainSpeed` | 0.25 | 0.01–2.0 | Change 2 |
| `uEntrainCrests` | 3.0 | 1–12 | Change 2 |
| `uSquadCoherence` | 1.0 | 0–1 | Change 4 |
| `uSpawnWaveFront` | 2.0 | −0.1–1.1 (+) | Change 5 |

(+) values outside [0, 1] mean "all suppressed" (< 0) or "all active" (> 1).

---

## Attribute Summary

| Attribute | itemSize | Built in | Change |
|---|---|---|---|
| `aClusterBurstSeed` | 1 | `buildGeometry()` | Change 1 |
| `aSquadPhase` | 1 | `buildGeometry()` | Change 4 |
| `aSpawnTheta` | 1 | `buildGeometry()` | Change 5 |

---

## Handle Method Summary

| Method | Signature | Change |
|---|---|---|
| `setContagion` | `(v: 0–1)` | 1 |
| `setEntrainment` | `(amt, speed?, crests?)` | 2 |
| `setSquadCoherence` | `(v: 0–1)` | 4 |
| `setSquadSize` | `(n: 2–20)` → rebuild | 4 |
| `setTrailCohesion` | `(v: 0–1)` → rebuild | 4 |
| `spawnWave` | `({duration?, easing?, startAngle?})` | 5 |
| `despawnWave` | `({duration?, easing?})` | 5 |
| `setSpawnWaveFront` | `(v: −0.1–1.1)` | 5 |

Internal only (no public API):
| `_claimReserve` | — | 3 |
| `_releaseReserve` | — | 3 |

---

## Interaction Notes

- **Change 1 + 4**: If squads share speed bias (via `aClusterBias`) AND share burst timing
  (`aClusterBurstSeed`), contagion fires across the squad simultaneously. This is the
  intended "pulse" effect. They amplify each other.

- **Change 2 + existing `uBreathAmt`**: Both are multiplicative on `speedMul`. At
  `uEntrainAmt = 0.5` and `uBreathAmt = 1.0`, maximum combined speedMul is ≈ 2.3×.
  There is no clamping — avoid running both at high values. Document the interaction in
  demo panel.

- **Change 4 + existing `uWaveAmt`**: The phase wave (change 4) makes heads travel at
  similar heights. The position wave (existing `uWaveAmt`) then offsets all glyphs
  vertically. Combined: squad heads cluster AND oscillate together in Y — visually coherent.

- **Change 5 + `uSectorStrength`**: Both gate column visibility. Sector mask is a static
  angular window; spawn wave is a time-animated front. They are AND-ed: a column must
  pass both. This is correct for e.g. "rain sweeps in, then fades outside sector".
  If the intent is "spawn wave replaces sector", set `uSectorStrength = 0`.

- **Change 3 + `showMessage()`**: Reserve pool eliminates the 75 %-fallback. Ensure
  `spawnReserves ≥ max_message_length × 1.25` (default 48 handles ~38-char messages).
  If the pool is exhausted mid-reveal (very long message), the existing nearest-column
  fallback still fires for remaining slots.

---

## Implementation Order

These changes are independent; implement in this order to keep changesets minimal:

1. **Change 2** (Speed Entrainment) — uniforms only, zero attribute impact, easiest test.
2. **Change 1** (Burst Contagion) — new attribute; integrates into existing burst code.
3. **Change 3** (Spawn Reserve Pool) — JS only; fixes message reveal immediately.
4. **Change 4** (Squad Phase + Trail) — new attribute; requires geometry rebuild path.
5. **Change 5** (Spawn Wave) — new attribute; add last since it modifies the density gate.

---

## Tasks

1. **Change 2 — Entrainment uniforms**: Add `uEntrainAmt/Speed/Crests` to `makeUniforms()`,
   destructure. Add `thetaEntrain` + `entrainWave` computation before the `burstCycle`
   block (before `speedMul`). Extend `speedMul`. Add `setEntrainment` handle method and
   demo slider. Verify at `uEntrainAmt = 0.5`: visible tidal speed variation sweeping the
   shell. Verify at `uEntrainAmt = 0`: identical to pre-spec.

2. **Change 1 — Contagion attribute**: Add `clusterBurstSeeds` + `clusterBurstSeedBuf` +
   `colBurstSeed` assignment + inner-row write + attribute registration in
   `buildGeometry()`. Add `uContagionStrength` uniform; replace `burstActive` line. Add
   `setContagion` handle method. Verify at `uContagionStrength = 1`: visible cluster-wide
   burst pulses every ~4 s, staggered across clusters. At `uContagionStrength = 0`:
   identical to pre-spec.

3. **Change 3 — Reserve pool**: Add `spawnReserves` param. After column loop, overwrite
   the last `spawnReserves` columns' `aColA.xy` to evenly-spaced inner-shell positions;
   build `_reservePool` with `reserveStart`, `free`, `used`, `origYOff`. Add
   `_claimReserve` / `_releaseReserve` helpers. In tick's per-slot recruitment (`slot.colIdx
   < 0` branch), search reserves first; fall through to existing column scan only if pool
   exhausted. In `_clearAllLocks()`, call `_releaseReserve` for all `pool.used` entries.
   Verify: message reveals without the 75%-fallback delay for slots the reserve covers.
   Verify: `pool.free.length` returns to `spawnReserves` after each message fade.

4. **Change 4 — Squad phase + trail**: Add `squadSize` + `trailCohesion` params;
   `maxSquadsPerCluster`; `squadPhases` + `squadTrailBiases` arrays; `clusterColCount`
   counter; `colSquadPhase` / `colTrailBias` / `clusterColCount[clusterIdx]++` per column.
   Replace trail bake: store `biasedTr` in both `trail` calculation and `rawTrailBuf[c]`.
   Add `squadPhaseBuf` + attribute. Add `uSquadCoherence` uniform + `phaseSeed` mix in
   vertex stage. Add 3 handle methods. Verify at `uSquadCoherence = 1.0`: identical to
   pre-spec. Verify at `uSquadCoherence = 0`: columns in same squad arrive at similar Y
   bands. Verify `setTrailRange` after `trailCohesion = 1`: relative trail spread preserved.

5. **Change 5 — Spawn wave**: Add `spawnThetaBuf`; `colTheta` per column; inner-row write;
   attribute registration. Add `uSpawnWaveFront` to `makeUniforms()`; attribute read;
   `spawnGatePasses`; modify `If()` condition. Add `_spawnWaveAnim` state; tick animation
   logic. Add 3 handle methods. Verify: `spawnWave({duration:3})` sweeps rain in over 3 s.
   Verify at `uSpawnWaveFront = 2.0` (default): identical to pre-spec. Verify: locked and
   spawn-active columns always render regardless of `uSpawnWaveFront`.

6. **Regression check**: All presets (`default/matrix1999/ghost/overdrive`) unchanged at
   new-uniform defaults. `showMessage()` works with and without available reserves.
   No visual artefacts when all new uniforms are at their defaults.

---

## Verification

| Check | Pass condition |
|---|---|
| `uContagionStrength = 0` | No visual change vs pre-spec |
| `uContagionStrength = 1` | Visible cluster-wide burst pulses, ~12 clusters staggered |
| `uEntrainAmt = 0` | No visual change vs pre-spec |
| `uEntrainAmt = 0.5` | Visible tidal sweep through rain (some columns fast, others slow) |
| `uSquadCoherence = 1.0` | No visual change vs pre-spec |
| `uSquadCoherence = 0.0` | Heads cluster in Y bands within squads; drift and re-align |
| `setTrailRange` after `trailCohesion = 1` | Relative trail-length differences between squads preserved |
| Reserve pool after message fade | `pool.free.length === spawnReserves` (all released) |
| Message reveal with reserves | Slots covered by reserves reveal without 75%-fallback delay |
| `spawnWave({duration:2})` | Rain sweeps in over 2 s, front moves counterclockwise |
| `uSpawnWaveFront = 2.0` (default) | Fully visible — identical to pre-spec |
| `uSpawnWaveFront = -0.1` | All columns suppressed (blank scene) |
| Locked columns during wave suppression | Always render regardless of `uSpawnWaveFront` |
| All presets | No regressions |

---

## Out of Scope

- **Droplet micro-groups (2E)**: Formation of 2–4 closely-packed columns that share exact
  positions. Deferred — fights with cluster placement and adds complexity for subtle gain.
- **Column Group API (3C/3D)**: JS abstraction for batching attribute writes to arbitrary
  column groups. Deferred — useful for scripted scenes but no current use case driving it.
- **Top-down / radial-out spawn wave directions**: `aSpawnTheta` only encodes the angular
  (XZ) direction. Vertical sweep (`aYOff`-based) or radial sweep could be baked as a
  second attribute in a follow-up spec if needed.
- **Runtime squad re-assignment**: Changing squad membership without a full geometry rebuild
  would require a second pass over the buffer. Not needed given `setSquadSize` triggers rebuild.
