# SPEC-3d-feel — Speed micro-oscillation + scale-R correlation

**Status**: Implemented
**Priority**: P2
**Reference**: `specs/AUDIT-analysis-vs-code.md` §3.3 (micro-oscillation), §3.6 (scale-R)

---

## Motivation

Two remaining medium-priority gaps from the audit, bundled because both are small and
neither justifies a standalone spec:

1. **Speed micro-oscillation ("breathing")** — every column should gently accelerate and
   decelerate with its own slow sinusoidal rhythm (`fv ∈ [0.1, 0.5]` Hz, amplitude 15 %).
   Currently only the burst surge provides speed variation; between bursts all columns run
   at a fixed speed. The continuous organic "breathing" quality of the film is absent.

2. **Scale-R correlation** — closer columns (smaller shell radius R) should render larger
   cells, matching the film's foreground/background depth layers. Currently `aScale` is
   pure random, so there is no systematic size variation with depth.

---

## Key variable context

Vertex shader `speedMul` (line 196):
```js
const speedMul = float(1).add(burstActive.mul(burstFrac).mul(2)).mul(uSpeedMul);
```
`speedMul` is the combined speed multiplier applied to `aSpeed` in `cyclePos`. The
micro-oscillation multiplies into this expression.

`aSeed` (line 154) is a per-column random float `[0, 1)` available throughout the vertex
shader — it is the only per-column random seed we have for deriving `fv` and `φv` without
new attributes.

Column init loop (matrix-rain-webgpu.js, line 103):
```js
const r     = R_MIN + Math.random() * (R_MAX - R_MIN);  // shell radius [3.5, 8.0]
const scale = 0.5 + Math.random() * 1.0;                // currently random [0.5, 1.5]
```
`R_MIN = 3.5`, `R_MAX = 8.0`.

---

## Implementation

### 1. Speed micro-oscillation (`matrix-rain-tsl.js`, line 196)

Derive per-column frequency `fv` and phase `φv` from `aSeed` using `h2()`. Replace the
existing `speedMul` line with a version that includes the sinusoidal breath factor.

```js
// Before (line 196):
const speedMul = float(1).add(burstActive.mul(burstFrac).mul(2)).mul(uSpeedMul);

// After:
// Per-column breathing: fv ∈ [0.1, 0.5] Hz, random phase — derived from aSeed
const breathFreq  = float(0.1).add(h2(vec2(aSeed.mul(13.7), float(0.1))).mul(0.4));
const breathPhase = h2(vec2(aSeed.mul(7.3), float(0.5))).mul(6.2832);
const breathMul   = float(1).add(
  sin(uTime.mul(breathFreq).mul(6.2832).add(breathPhase)).mul(0.15)
);
const speedMul = breathMul
  .mul(float(1).add(burstActive.mul(burstFrac).mul(2)))
  .mul(uSpeedMul);
```

`uTime` is in seconds, so `uTime * breathFreq * 2π` gives the correct angular frequency.
`breathMul` ranges `[0.85, 1.15]` — a ±15 % modulation centred on 1. The burst factor
still stacks multiplicatively on top.

No new uniforms or attributes needed — `aSeed`, `uTime`, `h2`, and `sin` are all already
in scope at this location.

---

### 2. Scale-R correlation (`matrix-rain-webgpu.js`, line 110)

Replace the random `scale` with a value that decreases linearly from inner shell
(foreground, large) to outer shell (background, small), with a small random jitter to
prevent uniformity.

```js
// Before (line 110):
const scale = 0.5 + Math.random() * 1.0;

// After:
const t     = (r - R_MIN) / (R_MAX - R_MIN);           // 0 = inner (close), 1 = outer (far)
const scale = (1.45 - t * 0.95) + (Math.random() - 0.5) * 0.2;
```

Distribution at shell extremes:
- Inner `r = R_MIN` (t = 0): `scale ≈ [1.35, 1.55]` — large foreground cells
- Outer `r = R_MAX` (t = 1): `scale ≈ [0.40, 0.60]` — small background cells
- Mean across uniform r: `≈ 0.975` — close to the previous mean of `1.0`
- Full range: `≈ [0.40, 1.55]` — similar span to the original `[0.5, 1.5]`

No shader change needed; `aColB.y` already carries `scale` to the vertex shader.

---

## Files Changed

| File | Change |
|---|---|
| `matrix-rain-tsl.js` | Replace `speedMul` (line 196) with breathing version |
| `matrix-rain-webgpu.js` | Replace `scale` init (line 110) with R-correlated version |

No new uniforms, no new attributes, no API surface changes, no `demo.html` changes.

---

## Verification

Manual browser test:

1. **Breathing** — watch a single slow column for ~10 s; its descent rate should visibly
   oscillate slowly (not rhythmically surge — the burst is rare; this is a gentle ±15 %
   wobble with a period of 2–10 s depending on column).
2. **Scale-R** — rotate or zoom the camera; columns close to the viewport should appear
   noticeably larger than distant ones in the background shell. The size gradient should
   feel systematic, not random.
3. **No regressions** — burst behaviour, flicker rates, colour floor, message reveal,
   presets, and CRT mode unaffected.
