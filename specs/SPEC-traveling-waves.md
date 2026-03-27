# SPEC-traveling-waves — Inter-column phase correlation

**Status**: Implemented
**Priority**: Low
**Reference**: `specs/AUDIT-analysis-vs-code.md` §3.4

---

## Motivation

Currently every column's cycle start position is `aSeed * cycleH` — pure independent random.
The film shows subtle traveling waves sweeping around the shell: waves of activity pass from
one side to the other with a period of ~42 s, giving the rain an organic "weather system" feel.
The analysis describes this as a low-frequency noise field sampled at angular position.

---

## Key variable context

`cyclePos` (`matrix-rain-tsl.js`, near line 209 after SPEC-3d-feel landing):
```js
const cyclePos = mod(
  uTime.mul(aSpeed).mul(speedMul).add(aSeed.mul(cycleH)),
  cycleH
);
```

`aSeed.mul(cycleH)` is the per-column start phase in world units. Adding a slow wave term here
offsets which part of the cycle each column is currently in, without changing speed.

`aWX = aColAAttr.x` and `aWZ = aColAAttr.y` are the XZ world position of the column —
enough to derive the angular position `theta = atan(wz, wx)` in the vertex shader.
(`atan` in TSL is the two-argument form equivalent to GLSL `atan(y, x)`.)

`cycleH ≈ uWorldH + uNRows * cellStep ≈ 16 + 120 × 0.148 ≈ 33.8` world units. A phase
shift of `±4.0` world units is ±12 % of the cycle — visible but not jarring.

---

## Implementation

### `matrix-rain-tsl.js` — modify `cyclePos` expression

No new attributes. Compute `theta` inline from the existing `aWX` / `aWZ` values.

```js
// Before:
const cyclePos = mod(
  uTime.mul(aSpeed).mul(speedMul).add(aSeed.mul(cycleH)),
  cycleH
);

// After:
// Traveling wave: 3 crests sweep around the shell at ~42 s/revolution
const thetaWave  = atan(aWZ, aWX);                            // angular pos, -π..π
const wavePhase  = thetaWave.mul(3.0).add(uTime.mul(0.15));   // 3 crests, 0.15 rad/s
const waveOffset = sin(wavePhase).mul(4.0);                    // ±4 world units
const cyclePos = mod(
  uTime.mul(aSpeed).mul(speedMul).add(aSeed.mul(cycleH)).add(waveOffset),
  cycleH
);
```

Constants (hardcoded, no new uniforms):
- `3.0` — number of wave crests around the 2π shell circumference
- `0.15` rad/s — wave rotation speed → full revolution in `2π / 0.15 ≈ 42 s`
- `4.0` — amplitude in world units (≈ 27 rows at default spacing with `aScale = 1`; `cellStep` varies per-column)

`atan` is already in scope via `three/tsl`.

---

## Files Changed

| File | Change |
|---|---|
| `matrix-rain-tsl.js` | Replace `cyclePos` expression with wave-offset version |

No new uniforms, no attributes, no API, no `demo.html` changes.

---

## Verification

Manual browser test:

1. Watch the shell from above (zoom out, look down) for 30–60 s. A visible density wave
   should sweep around the ring — one side briefly "fuller" (heads near top of screen) while
   the opposite side is "emptier". Period ≈ 42 s.
2. From normal viewing angle: the rain should not look strobed or pulsed — the wave is slow
   enough to read as atmospheric variation, not a hard-cut.
3. No regressions — burst, breathing, flicker rates, colours unaffected.
