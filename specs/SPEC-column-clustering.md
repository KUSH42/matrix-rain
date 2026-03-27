# SPEC-column-clustering — Angular cluster placement

**Status**: Implemented
**Priority**: Low
**Reference**: `specs/AUDIT-analysis-vs-code.md` §3.2

---

## Motivation

All 600 columns are placed with `Math.random() * 2π` — uniform Poisson distribution with no
spatial grouping. In the film, active columns tend to form rivulets: clusters of 2–4 adjacent
streams separated by gaps. This is what makes rain look like *rainfall*, not evenly-spaced
perforations. The clustering should be felt as "patches of density" when looking at the shell.

---

## Key variable context

Column init loop (`matrix-rain-webgpu.js`, line 102):
```js
const theta = Math.random() * Math.PI * 2;
const r     = R_MIN + Math.random() * (R_MAX - R_MIN);
const wx    = Math.cos(theta) * r;
const wz    = Math.sin(theta) * r;
```

Only `theta` changes. `wx`/`wz` derivation is unchanged — `Math.cos/sin` handle any angle.

---

## Implementation

### `matrix-rain-webgpu.js` — replace theta sampling in `buildGeometry()`

Add a Box-Muller Gaussian helper near the other scene constants (with `N_COLS`, `N_ROWS` etc.):

```js
function _gaussRand() {
  // Box-Muller: u ∈ (0,1] avoids log(0)
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
```

Also add near other scene constants:
```js
const N_CLUSTERS = 12;   // angular cluster count — see clustering section in SPEC-column-clustering.md
```

At the **top of `buildGeometry()`**, before the column loop, generate per-call cluster centers:

```js
// Per-instance cluster centers — generated inside buildGeometry so each
// initMatrixRain() call gets its own independent cluster pattern.
const clusterThetas = Array.from({ length: N_CLUSTERS },
  () => Math.random() * Math.PI * 2);
```

Replace the theta line inside the `for (let c = 0; c < N_COLS; c++)` loop:

```js
// Before (line 102):
const theta = Math.random() * Math.PI * 2;

// After:
const theta = clusterThetas[Math.floor(Math.random() * N_CLUSTERS)]
              + _gaussRand() * (6 * Math.PI / 180);   // σ = 6°
```

### Parameter rationale

`N_CLUSTERS = 12` with σ = 6° gives:
- Angular spacing between cluster centers: `360° / 12 = 30°`
- 95 % of each cluster's columns fall within `±2σ = ±12°` of the center
- Gap between cluster bands: `30° − 24° = 6°` — visible on the sphere
- Average columns per cluster: `600 / 12 = 50`; actual sizes vary ~20–80 (Poisson variance)

At middle shell radius R = 5.75, the total 24° (±2σ) cluster arc spans
`5.75 × (24° × π/180) ≈ 2.4` world units ≈ 20 cell-widths — wide enough to read as a
dense rivulet, narrow enough to leave the 6° gap visible.

N_CLUSTERS = 24 with the same σ = 6° was rejected: 15° spacing − 24° cluster width = −9°
(negative gap) meaning adjacent clusters fully blur together, defeating the purpose.

---

## Files Changed

| File | Change |
|---|---|
| `matrix-rain-webgpu.js` | Add `_gaussRand()` helper and `N_CLUSTERS` constant near scene constants; add `clusterThetas` local array at top of `buildGeometry()`; replace `theta` line |

No shader changes. No API surface. No `demo.html` changes.

---

## Verification

Manual browser test:

1. Zoom the camera out to see the full sphere. There should be visibly denser arcs
   alternating with sparser arcs — not a uniform ring of evenly-spaced columns.
2. Rotate the camera slowly; the clusters should remain spatially fixed (they are init-time
   random, not animated). They will look like rivulets pouring down specific "channels".
3. Full reload several times — each load produces different cluster positions (per-call
   random seed), confirming the placement is not deterministic.
4. Create two `initMatrixRain()` instances — they should show different cluster patterns
   since `clusterThetas` is generated inside `buildGeometry()`, not at module load.
5. No regressions — speed, colours, burst, flicker rates, traveling waves unaffected.
