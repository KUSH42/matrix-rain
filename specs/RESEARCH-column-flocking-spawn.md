# Research: Column Flocking & Spawn Helpers

**Status:** Research / pre-spec
**Date:** 2026-03-28
**Context:** Explore richer inter-column group behavior ("flocking") and a reliable spawn-helper
system for use cases like message reveal.

---

## 1 — Background & Constraints

Current column state is fully baked at `buildGeometry()` time into instanced attributes:

| Attribute | Content |
|-----------|---------|
| `aColA` (vec4) | `(wx, wz, speed, seed)` |
| `aColB` (vec4) | `(yOff, scale, alpha, trail)` |
| `aClusterBias` (float) | per-cluster speed bias `[−1, 1]` |
| `aLockState` (vec4) | `(lockY, lockGlyph, lockTime, spawnActive)` |

**No GPU↔CPU feedback loop.** Any "flocking" that requires reading neighbor state on the
GPU each frame is not supported (no compute shader, no SSBO). Everything must be either:
- baked into attributes at geometry build time (static group metadata), or
- driven by a single shared JS-side uniform updated each frame (global wave fronts), or
- driven by CPU reads/writes of individual per-column attributes (works for ≤600 columns).

---

## 2 — Flocking Ideas

### 2A. Squad Phase Coherence ★★★ (recommended)

**Concept.** Assign columns to "squads" of 3–6 at geometry-build time. All squad members
share the same initial `cyclePos` phase offset, so their heads arrive at similar Y elevations
simultaneously. Because each column has an independent `aSpeed`, they gradually drift out of
sync, then the faster ones lap the slower ones and they re-align periodically — like birds
that glide together then diverge and reform.

**Implementation.**

Add one new float attribute `aSquadPhase` (per-instance, same for all rows of a column):

```
cyclePos = mod( uTime × aSpeed × speedMul + aSquadPhase × cycleH, cycleH )
```

Replace the current `aSeed × cycleH` phase seed with `aSquadPhase`. Keep `aSeed` for the
glyph-selection hash (unrelated).

Squad assignment during `buildGeometry()`:
```
const nSquads = Math.ceil(nCols / squadSize)   // squadSize ≈ 4
const squadPhases = Array.from({length: nSquads}, () => Math.random())
// Assign columns round-robin (or by proximity) to squads
// aSquadPhase[c] = squadPhases[squadIdx[c]]
```

**Trade-offs.**
- Zero runtime cost — single attribute lookup in vertex shader.
- Doesn't require a geometry rebuild to update (squad phases can be hot-patched post-build).
- Visible effect is subtle: heads cluster in Y bands, then drift. Strength controlled by
  how tight the speed range is. Narrow speed range → long coherence. Wide → quick scatter.
- Squad assignment by cluster index (same cluster → same squad) reinforces existing
  angular clustering with temporal coherence.

**Controls to expose:**
- `setSquadSize(n)` — triggers geometry rebuild (changes squad assignment).
- `setSquadCoherence(v)` — blends each column's phase between squad-shared (0) and fully
  random (1). Cheap: `phase = mix(squadPhase, colSeed, coherence)` at build time; baked.

---

### 2B. Cluster Burst Contagion ★★★ (recommended)

**Concept.** Currently each column bursts independently with probability `uBurstProb`.
With contagion, when one column in a cluster bursts, its neighbors are more likely to burst
within ~0.3 s, creating a "pulse wave" through the cluster.

**Implementation (GPU-only, no CPU reads).**

Add attribute `aClusterBurstSeed` (float, per-column, same for all rows). This is the
cluster's scheduled burst time modulo a cycle period:

```glsl
// Shader:
const clusterPeriod = 4.0   // seconds between cluster bursts (matches existing 4s cycle)
const clusterBurstPhase = frac( uTime / clusterPeriod + aClusterBurstSeed )
const clusterBurstWindow = 0.08   // 8% of the cycle = ~0.32 s
const clusterIsBursting = step(clusterBurstPhase, clusterBurstWindow)
// Per-column: burst if cluster is bursting AND column's own random seed < contagionStrength
const contagionBurst = clusterIsBursting * step( aRandSeed, uContagionStrength )
```

`uContagionStrength` (0–1) controls how many cluster members pick up the burst — 0 = no
contagion, 1 = whole cluster bursts simultaneously.

Existing per-column burst logic still fires independently. Contagion is additive.

**Trade-offs.**
- No CPU writes needed; fully GPU.
- Cluster bursts are periodic (every 4 s per cluster) rather than stochastic — feels more
  rhythmic. Could add per-cluster phase jitter via `aClusterBurstSeed` ∈ [0, 1] to
  desync clusters from each other.
- Could integrate with the existing `burstActive` / `burstFrac` variables in `matrix-rain-tsl.js`.

**New uniform:** `uContagionStrength` (float, default 0.0 = off).
**New control:** `setContagion(v)`.

---

### 2C. Speed Entrainment Wave ★★ (interesting, heavier)

**Concept.** A slow "attractor wave" sweeps through the column field; columns whose angular
position aligns with the wave crest temporarily accelerate (or decelerate), producing a
visible "tide" that passes through the rain.

**Implementation.**

No new attributes needed. Extend the existing wave system:

```glsl
// Existing wave (displaces glyph position in world Y):
waveOffset = sin( thetaWave × uWaveCrests + uTime × uWaveSpeed ) × uWaveAmt × 4.0

// New: speed entrainment (modulates aSpeed by a second wave)
speedEntrainment = sin( thetaWave × uEntrainCrests + uTime × uEntrainSpeed )
                   × uEntrainAmt  // amplitude [-1, 1] → speed multiplier [1-amt, 1+amt]
speedMul = speedMul × (1.0 + speedEntrainment)
```

`uEntrainAmt` at 0.3–0.5 creates noticeable tidal speed fluctuations while keeping columns
from reversing or stopping. Different from `uWaveAmt` (which moves glyphs) — this changes
how fast columns fall.

**Trade-offs.**
- Very cheap; reuses `thetaWave` already in the shader.
- Adds three uniforms; easy to expose.
- At high `uEntrainAmt` + low `uSpeedRange`, the tidal effect is dramatic. At wide speed
  range, it blends into the noise.
- Could replace or complement `uBreathAmt` (global speed oscillation) with a spatially
  varying version. In fact this is the spatially-structured analogue of `uBreathAmt`.

**New uniforms:** `uEntrainAmt`, `uEntrainSpeed`, `uEntrainCrests`.
**New controls:** `setEntrainment(amt, speed, crests)`.

---

### 2D. Trail Cohesion within Squads ★★ (visual complement to 2A)

**Concept.** Squad members share a trail-length bias (narrow vs wide trail), so visually
their "thickness" is consistent within a group. A squad of thin columns looks like a tight
stream; a squad of thick columns looks like a dense burst.

**Implementation.** During `buildGeometry()`, assign each squad a `squadTrailBias` ∈ [−1, 1].
Each column's trail = `tMin + (tr + squadTrailBias × 0.5) × (tMax − tMin)`, clamped to
`[tMin, tMax]`. No shader changes needed — baked into `aColB.w`.

Pairs naturally with **2A** (same squad structure, no extra attribute needed).

---

### 2E. "Droplet" Dense Column Micro-Groups ★★ (niche, nice for rain texture)

**Concept.** Some columns are placed in very tight spatial groups of 2–4 (angular separation
< 0.5°), creating the visual impression of a single thick rain column that has fine internal
structure — like a real water droplet spreading into rivulets. These micro-groups have nearly
identical speed and phase, so they travel as a unit.

**Implementation.** Post-placement pass in `buildGeometry()`:
1. Select `nDroplets` columns (e.g., 10% of total).
2. For each droplet leader, snap 2–3 follower columns to its angular position ± tiny jitter
   (0.01–0.02 rad), copy its speed (± 2% noise), and set its `aSquadPhase` to the same value.
3. Followers get a small radial offset (r ± 0.15) so they aren't exactly coplanar.

No new attributes; uses `aSquadPhase` from 2A + modifies existing `aColA.xy`.
Expose as `buildGeometry({ dropletFraction: 0.1, dropletSize: 3 })`.

---

## 3 — Spawn Helper Ideas

### 3A. Spawn Reserve Pool ★★★ (recommended for message reveal)

**Concept.** Pre-designate N "reserve" columns whose `aColA.xy` (world XZ) can be
CPU-patched at runtime to place them at an exact world position. Reserve columns are
density-culled (invisible) until activated via `aLockState.w = 1`.

**Why.** Message reveal currently searches for the nearest active column to each character
slot. If no column is close enough, a "fallback spawn" fires at 75% of reveal duration —
too late for clean presentation. With a reserve pool, every character slot gets a column
placed *exactly* where it's needed.

**Implementation.**

`buildGeometry()` accepts a new option `spawnReserves = 20` (default). The last N columns in
the buffer are flagged:
```js
// Per-reserve column c, mark density hash = 2.0 (> uDensity) so it's always culled by default
colABuf[c * 4 + 3] = reserveSeed   // special seed value in [2.0, 3.0] → always density-culled
```

A new JS-side lookup `geom._reserves = { free: [indices...], used: Map<slotId→colIdx> }`.

**API:**
```js
// Acquire a reserve column at a specific world position:
const colIdx = handle._claimReserve(worldX, worldZ)
// → patches aColA.xy on the GPU buffer, marks spawnActive=1
// Release back to pool:
handle._releaseReserve(colIdx)
```

Message reveal (`showMessage`) calls `_claimReserve` for each character slot before it fires,
then `_releaseReserve` at the end of the fade phase. No more nearest-neighbor fallback needed.

**Buffer update mechanism.** Since `aColA` is an `InstancedBufferAttribute`, patching a
column means:
```js
const attr = geom.getAttribute('aColA')
const base = colIdx * N_ROWS
for (let r = 0; r < N_ROWS; r++) {
  attr.setXY((base + r), worldX, worldZ)
}
attr.needsUpdate = true
```
With 20 reserves × 120 rows = 2 400 floats — perfectly acceptable.

---

### 3B. Spawn Wave ★★★ (recommended for dramatic entrances)

**Concept.** A wave front sweeps across the column field, activating (or deactivating)
columns in sequence. Columns ahead of the front are off; behind it they're on. Creates a
dramatic rain "curtain" sliding across the screen.

**Implementation.**

New float attribute `aSpawnThreshold` baked at build time. Value = the column's angular
or spatial position in the wave's sweep direction (normalized [0, 1]).

New uniform `uSpawnWaveFront` (float, default −1 = everything off, 2 = everything on):

```glsl
const spawnPasses = aSpawnThreshold < uSpawnWaveFront
const densityPasses = ... // existing check
const isVisible = (densityPasses || isSpawnActive) && spawnPasses
```

JS drives `uSpawnWaveFront` from 0 → 1 over a configurable duration:

```js
handle.spawnWave({ duration: 2.0, direction: 'left-to-right', easing: 'ease-in' })
// → animates uSpawnWaveFront from 0 to 1 over 2s
handle.despawnWave({ duration: 1.5, direction: 'right-to-left' })
```

`aSpawnThreshold` is computed from the column's `theta` projected onto the wave direction.
Different `direction` values map to different projections:
- `'left-to-right'`: `threshold = (theta + π) / (2π)` → wrap-safe
- `'top-down'`: `threshold = (yOff + worldH/2) / worldH`
- `'radial-out'`: `threshold = (r − inner) / (outer − inner)`
- `'angular'` from a center: shortest angular distance

The attribute only needs to be baked once; the wave *direction* is encoded in which attribute
component to use (could bake 2–3 directions as separate floats: `aSpawnThreshXZ`, `aSpawnThreshY`).

---

### 3C. Column Group API ★★ (general-purpose group management)

**Concept.** A lightweight JS-side abstraction over sets of column indices, exposing shared
state updates and lifecycle management. The GPU side doesn't change — the API is just a
convenient way to batch-update per-column attributes from JS.

```js
// Create a group of columns in a world-space region:
const grp = handle.createGroup({
  worldX: [−2, 2], worldZ: [−2, 2],  // bounding box filter
  count: 8                              // pick 8 closest columns
})

// Update group state:
grp.setSpeed(2.5)           // patches aColA.z for all members
grp.setTrail(0.08)          // patches aColB.w for all members
grp.setLock(worldY, glyph)  // writes aLockState for all members
grp.burst()                 // temporarily boost speed via aClusterBias patch
grp.release()               // restore original per-column values and free
```

Backed by a simple JS object `{ cols: Int32Array, origColA: Float32Array, ... }` that
caches original values for restore. No new shader code.

Most useful for message reveal variants and scripted effects.

---

### 3D. Scripted Spawn Sequence (message reveal enhancement) ★★

**Concept.** An ordered activation timeline: columns activate at specified times relative to
a start trigger. Used to "type" the rain — columns appear one by one left-to-right like
a typewriter, or in a random-but-dense burst, etc.

```js
handle.spawnSequence([
  { colIdx: 42, delay: 0.0,  worldX: −3.5, worldZ: 4.2 },
  { colIdx: 17, delay: 0.1,  worldX: −2.1, worldZ: 3.8 },
  // ...
], { onComplete: () => { /* all columns active */ } })
```

JS drives activation via the existing `_writeLockRows()` mechanism, scheduled with a
priority queue sorted by `delay`. Each frame, pop entries whose `startTime + delay ≤ now`.

This is the pattern `showMessage()` already uses internally but exposed as a lower-level API,
so callers can compose their own activation patterns without reimplementing the scheduler.

---

## 4 — Interaction Matrix

| Feature | Depends on | Conflicts with | Amplifies |
|---------|-----------|----------------|-----------|
| 2A Squad Phase | buildGeometry rebuild | none | 2D Trail Cohesion |
| 2B Cluster Contagion | new attribute + uniform | uBurstProb (overlap) | 2A (same squad) |
| 2C Speed Entrainment | new uniforms only | uBreathAmt (cumulative) | wave system |
| 2D Trail Cohesion | 2A squads | none | 2A |
| 2E Droplets | 2A squads + geom rebuild | clusterSpread (competes) | density |
| 3A Spawn Reserve | N_ROWS, buffer writes | message reveal (replaces fallback) | 3D sequence |
| 3B Spawn Wave | new attribute + uniform | uDensity (multiplicative) | 3C groups |
| 3C Group API | JS only | none | 3A + 3B |
| 3D Spawn Sequence | 3C groups | none | message reveal |

---

## 5 — Recommended Implementation Order

**Phase 1 — Low-risk, high-value (no geometry rebuild API change):**
1. **2B Cluster Contagion** — new attribute + 1 uniform; pure shader addition; impressive visual.
2. **2C Speed Entrainment Wave** — uniforms only; zero attribute change; reuses wave system.
3. **3A Spawn Reserve Pool** — JS-side; fixes message reveal fallback; no new shader code.

**Phase 2 — Geometry rebuild (requires `setSquadSize` / `setDroplets` controls):**
4. **2A Squad Phase Coherence** — geometry rebuild; adds `aSquadPhase`; enables 2D.
5. **2D Trail Cohesion** — free once squads exist; baked at geometry build.
6. **3B Spawn Wave** — new attribute `aSpawnThreshold`; compelling entrance/exit effect.

**Phase 3 — Optional/niche:**
7. **2E Droplets** — interesting texture; may fight with existing cluster placement.
8. **3C/3D Group API + Spawn Sequence** — JS plumbing; useful if scripted scenes become common.

---

## 6 — Open Questions

1. **Squad size vs cluster count.** Squads should subdivide clusters (not cross cluster
   boundaries) for best visual coherence. With 12 clusters and ~50 columns/cluster, squads
   of 4–6 gives 8–12 squads/cluster. Is that granularity right for the effect?

2. **Reserve pool size.** Message reveal currently uses up to ~30 characters. Reserves =
   N_CHARS × 1.2 (safety margin) ≈ 36–40 slots. Should reserves be a fixed config or grow
   dynamically? Dynamic is complex (requires buffer resize); fixed pool of 48 seems fine.

3. **Spawn wave vs sector mask.** `uSectorStrength` already fades columns outside an angular
   sector. A spawn wave that operates in the same angular space may feel redundant unless
   the wave is time-animated (sector mask is static). Ensure API is clearly differentiated.

4. **Contagion and burst probability interaction.** At `uBurstProb = 1.0` and
   `uContagionStrength = 1.0`, every column is always bursting. Probably want soft clamping
   or make them mutually exclusive modes.
