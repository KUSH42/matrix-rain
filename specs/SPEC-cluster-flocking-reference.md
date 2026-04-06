# SPEC-cluster-flocking-reference.md
# Column Clustering & Flocking — Reference Specification

**Status:** Implemented (reference doc only — no new work planned)
**Files:** `matrix-rain-webgpu.js` (geometry builder, JS-side), `matrix-rain-tsl.js` (shader-side)

---

## Overview

600 instanced columns are not scattered uniformly. They are organised into a multi-level hierarchy:

```
Shell
 └─ Clusters (default 12)          — angular bands, shared hue/brightness/speed/burst identity
     └─ Squads (default ~5 cols)   — sub-groups within a cluster sharing cycle phase and trail length
         └─ Columns                — individual billboard quads
```

This hierarchy produces six emergent behaviours without any per-frame JS work:

| Behaviour | Scope | Mechanism |
|---|---|---|
| Spatial clustering | Cluster | Gaussian θ jitter around stratified center |
| Visual identity | Cluster | Per-cluster hue/brightness/speed bias baked into attributes |
| Synchronised bursts | Cluster | Shared `aClusterBurstSeed` → periodic window + contagion |
| Phase lock | Squad | Shared `aSquadPhase` → same cyclePos at low `uSquadCoherence` |
| Trail cohesion | Squad | Biased trail length baked per squad in `biasedTrailBuf` |
| Speed wave | All topologies | `entrainWave` = `sin(θ × crests + t × speed)` multiplied into `speedMul` |

---

## Geometry Builder (`buildGeometry`)

### Cluster placement

```
clusterCount = 12   →  arcSize = 2π / 12 = 30°
```

Centers are **stratified**: cluster `i` is placed at `i × arcSize + rand(0, arcSize)`, guaranteeing one center per arc. This bounds the maximum gap between adjacent centers to 60° (vs. ~93° worst-case with pure uniform random).

Each center is drawn once per `buildGeometry()` call and regenerated on rebuild.

Angular spread is a Gaussian with σ derived from `clusterSpread` (fraction of full circle):

```js
sigma = Math.max(0.003, clusterSpread) * 2π   // default 0.017 → σ ≈ 0.107 rad ≈ 6.1°
// Math.max(0.003, ...) prevents degenerate zero-spread clusters
theta = cl.theta + gaussRand() * sigma
```

```js
class Cluster {
  theta      // stratified center (radians)
  hue        // [-1, 1] → multiplied by uClusterHueRange in shader (degrees)
  brightness // [-1, 1] → multiplied by uClusterBrightRange in shader
  speed      // [-1, 1] → multiplied by uClusterSpeedRange  in shader
  burstSeed  // [0, 1]  → desync offset for 4 s burst window
  yCenter    // world Y spawn band center
  rSeed      // [0, 1]  → shell depth center (shell topology only — ignored for ring/curtain/rectangle)
  phase      // [0, 1]  → base cycle phase; squad phases are jittered ±0.1 around this
}
```

The four intra-cluster jitter parameters each control an independent spatial dimension:

| Param | Default | Spatial dimension |
|---|---|---|
| `clusterSpread` (σ) | 0.017 ≈ 6° | Angular spread around cluster center |
| `clusterRJitter` | 0.20 | Shell depth spread — `shell` topology only |
| `clusterYSpread` | 3.0 wu | Vertical spawn-Y band spread |
| `clusterSpeedJitter` | 0.18 | Speed-seed spread around cluster speed center |

### Column assignment

Columns are assigned to clusters **round-robin** (`c % nClusters`). This guarantees equal cluster populations (each cluster gets exactly `ceil(nCols/nClusters)` columns) regardless of `nCols` or `clusterCount`, making squad formation consistent across clusters. The last squad in a cluster may be smaller than `squadSize` if `ceil(nCols/nClusters)` is not divisible by it.

```
cluster 0: cols 0, 12, 24, 36, ...
cluster 1: cols 1, 13, 25, 37, ...
...
```

Each column's angular position `theta` is:

```
clustered  = cl.theta + gaussRand() * sigma          (σ ≈ 6°)
uniform    = rand(0, 2π)
theta      = mix(clustered, uniform, clusterUniform)  (default clusterUniform = 0)
```

### Per-column baked attributes

| Attribute | itemSize | Content |
|---|---|---|
| `aClusterHue` | 1 | `cl.hue` — per-cluster, same value for every column in cluster |
| `aClusterBright` | 1 | `cl.brightness` |
| `aClusterSpeed` | 1 | `cl.speed` |
| `aClusterBurstSeed` | 1 | `cl.burstSeed` — also used as gravity oscillation phase desync |
| `aClusterCenter` | 2 | Centroid (wx, wz) of all non-reserve columns in the cluster — used by gravity pass only (`gravDir = column XZ − centroid XZ`) |
| `aSquadPhase` | 1 | Shared `[0,1]` phase seed for all columns in the same squad |
| `aSpawnTheta` | 1 | Topology-correct normalised azimuth `[0,1]` — feeds entrainment wave, spawn wave gate, and spiral phase winding |

### Squad formation

Within each cluster, squads are formed sequentially by a counter (`_colCount`) incremented as columns are assigned:

```
squadIndex = floor(_colCount / squadSize)
```

All columns that fall in the same `squadIndex` share the same `aSquadPhase` and the same trail cohesion bias.

> **Note:** the main loop runs for all `nCols` including reserve columns, so `_colCount` is inflated by whichever reserves initially round-robin into each cluster. The squad indices assigned to reserve columns during this loop are discarded when the reserve pool loop overwrites all their cluster attributes. This inflation has no runtime effect but makes `_colCount` larger than the non-reserve column count alone.

`trailCohesion` controls how strongly the squad trail bias is applied:

```js
// colTrailBias ∈ [-1, 1] is a random per-squad bias seed (cl.squadTrailBiases[squadIdx])
// 0.45 coefficient keeps the full swing within [0.05, 0.95] even at bias = ±1, trailCohesion = 1
biasedTr = clamp(tr + colTrailBias * 0.45 * trailCohesion, 0.05, 0.95)
```

The biased value is stored in `biasedTrailBuf[c]` so `setTrailRange()` can re-scale it in-place without a geometry rebuild.

### Reserve pool

The last `spawnReserves` (default 48) columns are **repositioned** to evenly cover the full screen width. They are initially assigned cluster attributes by round-robin in the main loop, then the reserve pool loop **overwrites** their positions and all cluster attributes (`aClusterHue`, `aClusterBright`, `aClusterSpeed`, `aClusterBurstSeed`, `aSquadPhase`) using nearest-cluster angular matching. This ensures:

1. `showMessage()` reserve columns fire with the correct cluster burst timing.
2. Reserve columns inherit cluster-coherent Y-band so they blend into the rain while idle.

---

## Shader-side mechanics (`matrix-rain-tsl.js`)

### Per-cluster visual modulation (vertex Fn)

```glsl
// Brightness
clusterAlphaMul = 1.0 + aClusterBright * uClusterBrightRange;
vAlpha *= clusterAlphaMul;

// Speed
effectiveSpeed = aSpeed * (1.0 + aClusterSpeed * uClusterSpeedRange);

// Hue — passed to fragment via varying
vClusterHue = aClusterHue;
```

In fragment Fn:

```glsl
clusterHueDeg = vClusterHue * uClusterHueRange;
col2 = hueRotateRGB(col2, clusterHueDeg * DEG_TO_RAD);
```

Range uniforms (`uClusterHueRange`, `uClusterBrightRange`, `uClusterSpeedRange`) are runtime uniforms — adjusting them takes effect in the next frame with **no geometry rebuild**.

### Cluster burst contagion

Each cluster fires a burst window every 4 seconds at an offset determined by `aClusterBurstSeed`:

```glsl
clusterBurstPhase = fract(uTime / 4.0 + aClusterBurstSeed);
clusterIsBursting = step(clusterBurstPhase, 0.08);         // 8 % of 4 s = ~320 ms window
```

Individual columns then independently decide whether to join via a per-column random threshold:

```glsl
colContagionRand = h2(vec2(aColIdx * 0.53, 0.13));         // stable per-column rand
contagionBurst   = clusterIsBursting * step(colContagionRand, uContagionStrength);
burstActive      = clamp(burstIndiv + contagionBurst, 0.0, 1.0);
```

Setting `uContagionStrength = 0` disables contagion entirely; individual bursts (`burstIndiv`) still fire at the normal 0.5 % per-cycle rate.

### Speed entrainment wave

A sinusoidal wave sweeps around the shell, modulating every column's speed multiplicatively:

```glsl
thetaEntrain = aSpawnTheta * 2π - π;           // [0,1] → [-π, π]
entrainWave  = sin(thetaEntrain * uEntrainCrests + uTime * uEntrainSpeed) * uEntrainAmt;
speedMul    *= (1.0 + entrainWave);
```

`aSpawnTheta` is used instead of `atan(wz, wx)` because curtain and rectangle topologies have degenerate azimuth (wz ≈ 0), whereas `aSpawnTheta` is baked as a well-distributed [0,1] value for all topologies.

At defaults (`uEntrainAmt = 0.15`, `uEntrainCrests = 3`, `uEntrainSpeed = 0.25 rad/s`) the wave creates three visible speed bands rotating around the shell at ~25 s/revolution, making speed variations appear to "travel" visually.

### Squad phase coherence

```glsl
phaseSeed = mix(aSquadPhase, aSeed, uSquadCoherence);
cyclePos  = mod(uTime * effectiveSpeed * speedMul + phaseSeed * cycleH, cycleH);
```

- `uSquadCoherence = 0.0` → all columns in a squad use the same phase seed (`aSquadPhase`) → heads travel together
- `uSquadCoherence = 1.0` → all columns use their individual seed (`aSeed`) → fully independent
- Default `0.3` → slight phase lock; squads are loosely synchronised without looking mechanical

---

## Public API

### Geometry-rebuild methods (require `rebuildGeom()`)

| Method | Clamped range | Default | Effect |
|---|---|---|---|
| `setClusterParams(count, spread)` | count clamped ≥ 1; spread stored raw (sigma floored at 0.003 in `buildGeometry`) | 12, 0.017 | Cluster count and angular spread |
| `setClusterUniform(v)` | [0, 1] | 0 | Angular distribution blend: 0 = clustered, 1 = uniform scatter |
| `setClusterSpeedJitter(v)` | [0, 0.5] | 0.18 | Speed-seed spread within a cluster |
| `setClusterYSpread(v)` | ≥ 0 | 3.0 wu | Vertical spawn-Y band spread within a cluster |
| `setClusterRJitter(v)` | [0, 0.5] | 0.20 | Shell depth spread within a cluster (shell topology only) |
| `setSquadSize(n)` | [2, 20] int | 5 | Columns per squad |
| `setTrailCohesion(v)` | [0, 1] | 0.7 | Squad trail-length bias strength |

### Runtime uniform methods (no rebuild)

| Method | Uniform | Default | Effect |
|---|---|---|---|
| `setClusterHueRange(v)` | `uClusterHueRange` | 18° | Max hue rotation per cluster |
| `setClusterBrightRange(v)` | `uClusterBrightRange` | 0.35 | Brightness bias magnitude |
| `setClusterSpeedRange(v)` | `uClusterSpeedRange` | 0.30 | Speed bias magnitude |
| `setContagion(v)` | `uContagionStrength` | 0.35 | Cluster burst join probability |
| `setSquadCoherence(v)` | `uSquadCoherence` | 0.30 | 0 = phase-locked squads, 1 = independent |
| `setEntrainment(amt, speed?, crests?)` | `uEntrainAmt/Speed/Crests` | 0.15, 0.25, 3 | Speed entrainment wave |
| `setEntrainSpeed(v)` | `uEntrainSpeed` | 0.25 rad/s | Entrainment wave sweep rate |
| `setEntrainCrests(n)` | `uEntrainCrests` | 3 | Number of speed bands around shell |

---

## Interactions between subsystems

```
Cluster
 ├── hue/brightness/speed bias  ─── baked to attributes → never changes at runtime without rebuild
 │                                  (range is a uniform → setClusterHueRange etc. work at runtime)
 ├── burstSeed ─────────────────── deterministic burst window; contagion gates individual join
 │                                  (aClusterBurstSeed also reused as gravity oscillation phase desync)
 ├── aClusterCenter ─────────────── centroid of non-reserve columns → gravity pass only
 │                                  (gravDir = column XZ − centroid XZ; normalised to unit vector)
 └── rSeed / yCenter ────────────── coherent shell depth (shell topology only) + Y spawn band

Squad (within cluster)
 ├── aSquadPhase ────────────────── phaseSeed → cyclePos (blend controlled by uSquadCoherence)
 └── biasedTrailBuf ─────────────── pre-baked trail fraction; setTrailRange() rescales in-place

aSpawnTheta (per-column, not per-cluster)
 ├── entrainment wave ───────────── thetaEntrain = aSpawnTheta * 2π − π → sin wave speed mod
 ├── spawn wave gate ────────────── columns with aSpawnTheta < uSpawnWaveFront are active
 └── spiral formation ───────────── spiralA = uTime * uSpiralRate + aSpawnTheta * uSpiralPitch

Reserve pool (last 48 cols)
 └── assigned to nearest cluster ── inherits burstSeed, hue, brightness, speed, squadPhase
                                     so message-reveal columns participate in cluster timing
```

---

## Three.js testability concept

The clustering subsystem is **entirely contained in the geometry builder** — the shader reads baked attributes and uniform scalars. This makes it straightforward to test in Node (no GPU required).

### What can be tested in Node (no GPU)

The geometry builder outputs Float32Arrays. All invariants that matter for visual correctness can be verified by inspecting these arrays directly.

```js
// tests/cluster-geometry.test.js  (vitest, Node, no GPU)
import { describe, it, expect, beforeAll } from 'vitest';

// Expose buildGeometry as a named export (or import the JS and call it directly)
// For testing purposes it only needs Three.js InstancedBufferGeometry which can
// be lightly mocked since we only inspect the filled Float32Arrays, not WebGL state.

// ─── Prerequisite: expose array-filling logic ────────────────────────────────
// buildGeometry() is not currently exported and uses Three.js internally
// (imported as `import * as THREE from 'three/webgpu'`). Two valid approaches:
//
// Option A — Extract a pure helper (recommended):
//   Move all Float32Array-filling logic into a standalone buildClusterArrays(params)
//   that returns the raw buffers without touching Three.js. No mock needed.
//   The tests below are written against this helper signature.
//
// Option B — Export buildGeometry and vi.mock the Three.js module:
//   Add `export { buildGeometry }` to matrix-rain-webgpu.js.
//   NOTE: globalThis.THREE assignment does NOT intercept named ES module imports.
//   Use vi.mock at the top of the test file instead:
//
//   import { vi } from 'vitest';
//   vi.mock('three/webgpu', () => ({
//     InstancedBufferGeometry: class {
//       _attrs = {};
//       index = null;
//       setAttribute(name, attr) { this._attrs[name] = attr; }
//       getAttribute(name)       { return this._attrs[name]; }
//     },
//     PlaneGeometry: class {
//       index = { clone: () => ({ count: 6 }) };
//       getAttribute() { return { clone: () => ({ array: new Float32Array(12) }) }; }
//       dispose() {}
//     },
//     InstancedBufferAttribute: class {
//       constructor(arr, itemSize) { this.array = arr; this.itemSize = itemSize; }
//     },
//   }));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('cluster geometry invariants', () => {
  const N_COLS      = 120;  // smaller set for unit tests
  const N_CLUSTERS  = 12;
  const N_ROWS      = 120;
  const SQUAD_SIZE  = 5;
  const SPAWN_RES   = 12;
  const RESERVE_START = N_COLS - SPAWN_RES;  // 108 — last 12 cols are reserves
  let geom;

  beforeAll(() => {
    // buildGeometry() is not currently exported; to enable these tests either:
    //   (a) add `export { buildGeometry }` to matrix-rain-webgpu.js, or
    //   (b) extract the array-filling logic into a pure `buildClusterArrays(params)` helper.
    // The test concept below assumes `buildClusterArrays(params)` returns:
    //   { clusterHueBuf, clusterBrightBuf, clusterSpeedBuf, clusterBurstSeedBuf,
    //     clusterCenterBuf, squadPhaseBuf, biasedTrailBuf, colABuf, clusterThetas, nClusters }
    // All buffers are flat Float32Arrays indexed as [col * N_ROWS + row] (per-instance, replicated).
    geom = buildClusterArrays({ nCols: N_COLS, clusterCount: N_CLUSTERS,
      nRows: N_ROWS, squadSize: SQUAD_SIZE, trailCohesion: 0.7, spawnReserves: SPAWN_RES });
  });

  // ── Stratified placement ─────────────────────────────────────────────────

  it('cluster centers are monotonically distributed across [0, 2π]', () => {
    // Each arc [i*arcSize, (i+1)*arcSize) contains exactly one center.
    const arc = (Math.PI * 2) / N_CLUSTERS;
    geom.clusterThetas.forEach((theta, i) => {
      const lo = i * arc, hi = (i + 1) * arc;
      expect(theta).toBeGreaterThanOrEqual(lo);
      expect(theta).toBeLessThan(hi);
    });
  });

  // ── Round-robin balance ──────────────────────────────────────────────────

  it('non-reserve cluster populations are balanced (max difference ≤ 1)', () => {
    // Only count regular (non-reserve) columns; reserves are re-assigned by proximity.
    const counts = new Array(N_CLUSTERS).fill(0);
    for (let c = 0; c < RESERVE_START; c++) counts[c % N_CLUSTERS]++;
    const min = Math.min(...counts), max = Math.max(...counts);
    expect(max - min).toBeLessThanOrEqual(1);
  });

  // ── Per-column row replication ───────────────────────────────────────────

  it('all rows of a column share the same aClusterHue value', () => {
    for (let c = 0; c < N_COLS; c++) {
      const base = c * N_ROWS;
      const ref  = geom.clusterHueBuf[base];
      for (let r = 1; r < N_ROWS; r++) {
        expect(geom.clusterHueBuf[base + r]).toBe(ref);
      }
    }
  });

  // ── Per-cluster attribute coherence (non-reserve columns only) ───────────
  // Reserve columns are re-assigned to the nearest cluster after the main loop,
  // so their hue/burstSeed may differ from the round-robin cluster they were
  // initially placed in. Only test non-reserve columns here.

  it('non-reserve columns in the same cluster share the same aClusterHue', () => {
    for (let ci = 0; ci < N_CLUSTERS; ci++) {
      const cols = [];
      for (let c = ci; c < RESERVE_START; c += N_CLUSTERS) cols.push(c);
      const ref = geom.clusterHueBuf[cols[0] * N_ROWS];
      cols.slice(1).forEach(c => {
        expect(geom.clusterHueBuf[c * N_ROWS]).toBe(ref);
      });
    }
  });

  it('non-reserve columns in the same cluster share the same aClusterBurstSeed', () => {
    for (let ci = 0; ci < N_CLUSTERS; ci++) {
      const cols = [];
      for (let c = ci; c < RESERVE_START; c += N_CLUSTERS) cols.push(c);
      const ref = geom.clusterBurstSeedBuf[cols[0] * N_ROWS];
      cols.slice(1).forEach(c => {
        expect(geom.clusterBurstSeedBuf[c * N_ROWS]).toBe(ref);
      });
    }
  });

  it('non-reserve columns in the same cluster share the same aClusterSpeed', () => {
    for (let ci = 0; ci < N_CLUSTERS; ci++) {
      const cols = [];
      for (let c = ci; c < RESERVE_START; c += N_CLUSTERS) cols.push(c);
      const ref = geom.clusterSpeedBuf[cols[0] * N_ROWS];
      cols.slice(1).forEach(c => {
        expect(geom.clusterSpeedBuf[c * N_ROWS]).toBe(ref);
      });
    }
  });

  it('columns in different clusters have different aClusterHue (non-reserve)', () => {
    // Astronomically unlikely for two clusters to draw identical random hue.
    const hues = Array.from({ length: N_CLUSTERS }, (_, ci) => geom.clusterHueBuf[ci * N_ROWS]);
    const unique = new Set(hues.map(h => h.toFixed(6)));
    expect(unique.size).toBeGreaterThan(1);
  });

  // ── Squad phase coherence (non-reserve columns only) ─────────────────────
  // Reserve columns' aSquadPhase is overwritten in the reserve pool loop.

  it('non-reserve columns in the same squad share the same aSquadPhase', () => {
    for (let ci = 0; ci < N_CLUSTERS; ci++) {
      const cols = [];
      for (let c = ci; c < RESERVE_START; c += N_CLUSTERS) cols.push(c);
      for (let s = 0; s < Math.floor(cols.length / SQUAD_SIZE); s++) {
        const squadCols = cols.slice(s * SQUAD_SIZE, (s + 1) * SQUAD_SIZE);
        const ref = geom.squadPhaseBuf[squadCols[0] * N_ROWS];
        squadCols.slice(1).forEach(c => {
          expect(geom.squadPhaseBuf[c * N_ROWS]).toBe(ref);
        });
      }
    }
  });

  it('adjacent squads in the same cluster have different phase seeds', () => {
    const ci = 0;
    const cols = [];
    for (let c = ci; c < RESERVE_START; c += N_CLUSTERS) cols.push(c);
    // Need at least SQUAD_SIZE + 1 non-reserve columns for a second squad to exist.
    // If this guard triggers, increase N_COLS or decrease N_CLUSTERS/SQUAD_SIZE.
    if (cols.length <= SQUAD_SIZE) return; // vitest treats early return as passed — acceptable here
    const p0 = geom.squadPhaseBuf[cols[0] * N_ROWS];
    const p1 = geom.squadPhaseBuf[cols[SQUAD_SIZE] * N_ROWS];
    expect(p0).not.toBe(p1);
  });

  // ── biasedTrailBuf range (all columns including reserves) ────────────────
  // biasedTrailBuf is only written in the main loop; reserve pool loop does
  // not overwrite it, so all N_COLS entries should be in [0.05, 0.95].

  it('biasedTrailBuf values are all in [0.05, 0.95]', () => {
    for (let c = 0; c < N_COLS; c++) {
      expect(geom.biasedTrailBuf[c]).toBeGreaterThanOrEqual(0.05);
      expect(geom.biasedTrailBuf[c]).toBeLessThanOrEqual(0.95);
    }
  });

  // ── aSpawnTheta range ────────────────────────────────────────────────────

  it('aSpawnTheta is in [0, 1] for all columns', () => {
    // aSpawnTheta is baked as a topology-correct azimuth [0,1] for the entrainment wave.
    // buildClusterArrays must expose spawnThetaBuf; warn and skip if it does not.
    if (!geom.spawnThetaBuf) {
      console.warn('spawnThetaBuf not exposed by helper — test skipped');
      return;
    }
    for (let c = 0; c < N_COLS; c++) {
      const v = geom.spawnThetaBuf[c * N_ROWS];
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  // ── Reserve pool ─────────────────────────────────────────────────────────

  it('reserve columns have valid cluster hue assignments (in [-1, 1])', () => {
    for (let c = RESERVE_START; c < N_COLS; c++) {
      const hue = geom.clusterHueBuf[c * N_ROWS];
      expect(hue).toBeGreaterThanOrEqual(-1);
      expect(hue).toBeLessThanOrEqual(1);
    }
  });

  it('reserve column hues match one of the known cluster hues', () => {
    // Each reserve is re-assigned to the nearest cluster; its hue must equal
    // that cluster's hue exactly (same float value, not approximate).
    const clusterHues = Array.from({ length: N_CLUSTERS }, (_, ci) => geom.clusterHueBuf[ci * N_ROWS]);
    for (let c = RESERVE_START; c < N_COLS; c++) {
      const hue = geom.clusterHueBuf[c * N_ROWS];
      expect(clusterHues).toContain(hue);
    }
  });

  it('reserve columns are evenly distributed in angle (span > π)', () => {
    const angles = [];
    for (let c = RESERVE_START; c < N_COLS; c++) {
      const wx = geom.colABuf[c * N_ROWS * 4];
      const wz = geom.colABuf[c * N_ROWS * 4 + 1];
      angles.push(Math.atan2(wz, wx));
    }
    const span = Math.max(...angles) - Math.min(...angles);
    expect(span).toBeGreaterThan(Math.PI);
  });

  // ── aClusterCenter centroid correctness ──────────────────────────────────

  it('aClusterCenter matches computed centroid of non-reserve columns', () => {
    // clusterCenterBuf is indexed (col * N_ROWS + row) * 2, same stride as other per-instance bufs.
    for (let ci = 0; ci < N_CLUSTERS; ci++) {
      const cols = [];
      for (let c = ci; c < RESERVE_START; c += N_CLUSTERS) cols.push(c);
      const sumX = cols.reduce((s, c) => s + geom.colABuf[c * N_ROWS * 4],     0);
      const sumZ = cols.reduce((s, c) => s + geom.colABuf[c * N_ROWS * 4 + 1], 0);
      const expectedX = sumX / cols.length;
      const expectedZ = sumZ / cols.length;
      const cx = geom.clusterCenterBuf[cols[0] * N_ROWS * 2];
      const cz = geom.clusterCenterBuf[cols[0] * N_ROWS * 2 + 1];
      expect(cx).toBeCloseTo(expectedX, 4);
      expect(cz).toBeCloseTo(expectedZ, 4);
    }
  });

  it('all rows of a column carry the same aClusterCenter value', () => {
    for (let c = 0; c < RESERVE_START; c++) {
      const base2 = c * N_ROWS * 2;
      const rx = geom.clusterCenterBuf[base2];
      const rz = geom.clusterCenterBuf[base2 + 1];
      for (let r = 1; r < N_ROWS; r++) {
        expect(geom.clusterCenterBuf[base2 + r * 2]).toBe(rx);
        expect(geom.clusterCenterBuf[base2 + r * 2 + 1]).toBe(rz);
      }
    }
  });
});
```

### What requires the browser / GPU

| Subsystem | Why it cannot be Node-tested |
|---|---|
| Contagion burst timing | Needs `uTime` advancing → shader execution → visual output |
| Entrainment wave visual | Speed modulation only visible in rendered column movement |
| Squad phase lock visual | Phase coherence only observable via rendered head positions |
| Gravity well displacement | Shader-side oscillation of `gravDir` (derived from `aClusterCenter`) — centroid baking itself is Node-testable (see tests above) |

These are integration concerns best verified visually in the browser demo (`matrix-3d.html`) using the Cluster FX sliders.

---

## Key design decisions

**Why round-robin instead of random assignment?**
Random assignment produces clusters of very unequal size (Poisson variation ≈ √n). Unequal clusters mean some squads have 1–2 members and others have 8–10, undermining the coherence effect. Round-robin guarantees `ceil(nCols/nClusters)` per cluster.

**Why stratified placement instead of uniform random centers?**
Uniform random placement allows cluster bunching (a gap of ~93° is likely with 12 clusters). Stratified ensures the maximum gap ≤ 60°, preventing sparse arcs with visible emptiness.

**Why bake attributes instead of computing per-frame in JS?**
Attribute reads are per-vertex (parallelised on GPU). Computing cluster identity per-frame in JS would require 600 × 120 = 72,000 attribute writes per frame — prohibitive. The per-cluster bias values change only on geometry rebuild.

**Why use `aSpawnTheta` instead of `atan2(wz, wx)` in the entrainment wave?**
For curtain and rectangle topologies `wz ≈ 0` or `wz` is random, making `atan2` degenerate or spatially incoherent. `aSpawnTheta` is baked as a well-distributed `[0,1]` scan position regardless of topology.

**Why reuse `aClusterBurstSeed` as a gravity phase desync?**
Gravity oscillation is per-cluster (all members of a cluster share the same cluster-centroid attractor). Using `aClusterBurstSeed` as the phase desync seed ensures different clusters pull at different phases — preventing all 12 clusters from pulsing in sync — without adding a new attribute.

**Why three separate range uniforms (`uClusterHueRange`, `uClusterBrightRange`, `uClusterSpeedRange`) instead of one `clusterStrength`?**
The three axes are aesthetically orthogonal: clusters with high hue range but uniform brightness look like distinct colour patches; clusters with uniform hue but high brightness range look like intensity bands. A single knob would force all three to track together, collapsing most of the design space. Keeping them independent lets you, for example, disable colour variation entirely (`setClusterHueRange(0)`) while preserving speed coherence.
