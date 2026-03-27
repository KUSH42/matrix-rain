# SPEC-3d-accuracy — Film-accurate 3D rain fixes

**Status**: Implemented
**Priority**: P1
**Reference**: `specs/AUDIT-analysis-vs-code.md` §2.1 (colour floor), §2.2 (speed distribution), §3.1 (flicker rates)

---

## Motivation

Three gaps between the film analysis and the current 3D implementation have the highest
perceptual impact and lowest implementation cost. This spec addresses all three together
since they touch related parts of the glyph material and column init loop:

1. **Position-based flicker rates** — deep-trail cells should be near-static; head cells
   should flip at ~15 Hz. Currently all cells use the same random `holdSec`, so deep-trail
   cells flicker as often as near-head ones. The "crystallised written text" feel is absent.

2. **Deep trail dark-green colour floor** — deep-trail cells should glow faintly at
   `#002D0A` (dark green), not fade to pure black. Currently the trail colour is
   `tintedColor * 1.6` at all depths; with additive blending + low alpha, deep cells read
   as black.

3. **Speed range + log-bias** — column speeds should span `[1.2, 8.0]` c/s with a
   log-biased distribution (most columns slow, a persistent handful fast). Currently the
   range is `[0.4, 2.27]` with linear random.

---

## Key variable semantics (prerequisite reading)

`vDist` is a varying written in the vertex shader as:
```js
const dist = cellY.sub(headY).div(cellStep);  // cell-count from head
vDist.assign(dist);
```
It is in **cell units**, not normalised [0, 1]. Head cell = 0; one cell behind = 1; etc.
It can reach `maxVisible = min(4.42 / aTrail, nRows * 1.2)` — roughly 88–295 cells
depending on the column's `aTrail` attribute.

`halfDist = ln(2) / vTrail` is already computed at line 286 (fragment shader) — it is the
cell distance at which `trail` decays to 0.5. It serves as the natural boundary between
"active trail" and "deep trail":

| Zone | Cell range | Approx. cells (aTrail=0.03 median) |
|---|---|---|
| Head | `d < 1` | cells 0 |
| Near-head | `1 ≤ d < 4` | cells 1–3 |
| Mid-trail | `4 ≤ d < halfDist` | cells 4–23 |
| Deep trail | `d ≥ halfDist` | cells 23+ |

---

## Implementation

### 1. Position-based flicker rates (`matrix-rain-tsl.js`)

Gate `holdSec` on cell-count zones using `vDist` and the already-computed `halfDist`.
Burst columns (`vBurst > 0.5`) override deep-trail static to keep the burst visually active.

**Change 1 — replace `holdSec` with a distance-gated version (line 305):**

```js
// Before:
const holdSec = float(0.45).add(h2(cellId.mul(0.29)).mul(7.15));

// After:
const holdRand   = float(0.45).add(h2(cellId.mul(0.29)).mul(7.15));
const isHead     = vDist.lessThan(1.0);
const isNearHead = vDist.lessThan(4.0);
const holdSec    = select(isHead,
  float(0.067),                            // head:      ~15 Hz
  select(isNearHead,
    float(2.0).add(holdRand.mul(0.3)),     // near-head: ~0.5 Hz ± jitter
    float(10.0).add(holdRand.mul(2.0))     // mid + deep trail: ~0.1 Hz ± jitter
  )
);
```

Three zones are enough: deep-trail cells are forced static by the `glyphIdx` change below,
so their `holdSec` value is never consulted. The fourth `select` branch in the draft was
dead code.

**Change 2 — deep-trail static: force `baseGlyph`, with burst override (line 327):**

```js
// Before:
const glyphIdx = select(stability.lessThan(0.30), baseGlyph, mutGlyph);

// After:
// Burst columns must override static: during a burst the whole column is "active".
const isDeepTrail = d.greaterThanEqual(halfDist).and(vBurst.lessThan(0.5));
const glyphIdx    = select(
  isDeepTrail.or(stability.lessThan(0.30)),
  baseGlyph,
  mutGlyph
);
```

`d = max(vDist, 0.0)` is already defined at line 285. `halfDist` is already defined at
line 286. Both are in scope here.

The `burstOffset` term already drives rapid `changeTick` increments for burst columns, so
`mutGlyph` changes rapidly even without a `holdSec` change — the static override just must
not suppress it.

The `msgActive` scramble boost (lines 307-315) derives from `holdSec` via `settledHold`
and is unaffected: message reveal operates via its own `msgHoldSec` path.

---

### 2. Deep trail dark-green colour floor (`matrix-rain-tsl.js`)

Add a second lerp stage keyed on normalised trail depth so deep-trail cells glow at a
dark-green floor rather than fading to black.

The film deep-trail value is `#002D0A`. Relative to peak `#00FF41`:
- Green channel ratio: `0x2D / 0xFF ≈ 0.176` — use `tintedColor * 0.18`

Normalise position using `halfDist` (already in scope) to make the transition independent
of per-column `aTrail`. `d / halfDist` goes 0 at head, 1 at the 50 % brightness point.

**Change — two-stage colour ramp (lines 347-353):**

```js
// Before:
const headFrac = float(1).sub(smoothstep(0.0, 0.8, vDist));
const col2 = mix(
  tintedColor.mul(1.6),
  tintedColor.mul(3.0).add(vec3(0.3)),
  headFrac
).add(grain).toVar('col2');

// After:
const headFrac      = float(1).sub(smoothstep(0.0, 0.8, vDist)); // unchanged
const normDist      = d.div(halfDist);                            // 0 = head, 1 = halfDist
const deepTrailFrac = smoothstep(0.5, 1.0, normDist);            // ramps in at 50–100 % of halfDist
const deepTrailCol  = tintedColor.mul(0.18);                     // ≈ #002D0A relative to uColor
const trailCol      = mix(tintedColor.mul(1.6), deepTrailCol, deepTrailFrac);
const col2 = mix(
  trailCol,
  tintedColor.mul(3.0).add(vec3(0.3)),
  headFrac
).add(grain).toVar('col2');
```

`d` and `halfDist` are both already defined above this block. `headFrac` is unchanged so
the bright head and transition band are unaffected.

---

### 3. Speed range + log-bias (`matrix-rain-webgpu.js`)

**Change — column init loop, line 107:**

```js
// Before:
const speed = 0.4 + Math.random() * 1.87;

// After:
const sr = Math.random();
const speed = 1.2 + sr * sr * 6.8;  // range [1.2, 8.0], biased toward slow end
```

`r * r` squaring concentrates mass at the slow end: mode ≈ 1.2 c/s, median ≈ 2.9 c/s,
mean ≈ 3.5 c/s, with a long tail reaching 8.0 c/s. A persistent handful of fast
"streakers" is always visible without requiring a burst.

No shader change needed; `aColA.z` already carries speed to the vertex shader unchanged.

---

## Files Changed

| File | Change |
|---|---|
| `matrix-rain-tsl.js` | Replace `holdSec` (line 305); update `glyphIdx` selection (line 327); two-stage colour ramp (lines 347-353) |
| `matrix-rain-webgpu.js` | Speed init (line 107) |

No new uniforms, no new attributes, no API surface changes, no `demo.html` changes.

---

## Verification

Manual browser test (no GPU unit tests possible):

1. **Flicker rates** — zoom into a column; deep-trail cells should hold their glyph for
   many seconds; head cells should flip rapidly (~15×/s); the trail should show a clear
   gradient from frantic → settled → frozen. Burst columns should remain fully animated
   along the entire column length.
2. **Deep trail colour** — reduce bloom / phosphor to minimum; deep-trail cells should show
   a faint dark-green tint rather than pure black.
3. **Speed distribution** — a handful of fast streaker columns (≥ 5 c/s) should be
   visible at all times without triggering burst mode; the majority of columns should move
   slowly.
4. **No regressions** — message reveal scramble rate, burst surge, presets, CRT mode, and
   all handle methods should behave as before.
