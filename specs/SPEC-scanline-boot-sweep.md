# SPEC — Scanline Boot Sweep

**Status**: Approved
**Priority**: P2
**Depends on**: —
**Goal**: Add a synchronized horizontal scanline sweep that locks all rain column heads to the same world-Y and advances them in lockstep before dissolving into natural per-column movement.

---

## Problem

The project has two boot animation modes:

- `setStartupCascade` — staggered per-column alpha fade-in; columns appear individually
- `spawnWave` — angular arc gate around the sphere; columns activate by angular position

Neither produces the classic "CRT initialization" visual: a bright horizontal band scanning
from top to bottom of the display before handing off to independent rain. This is the
defining boot effect from 2D matrix rain implementations and is missing from the 3D path.

Reference: [KUSH42/playground `matrix.component.ts`](https://github.com/KUSH42/playground/blob/master/src/app/components/matrix/matrix.component.ts)

The Angular 2D implementation does three things:
```
Phase 1 SWEEPING  — drops[x] = 1 for all x; random forced to 1 → lockstep advance
Phase 2 DISSOLVING — scanlinesDone=true after (height/font_size)*34 ms → natural speeds
Phase 3 CLEANUP   — scanlineInitDone=true 2 s later → opaque rects erase trail artefacts
```

---

## Goals

1. A `triggerScanlineSweep(opts)` handle method animates a horizontal band across the
   sphere from top to bottom, then blends all columns back to natural movement.
2. `setScanlineSync(v)` and `setScanlinePhase(v)` allow manual/scrubbing control.
3. An `opts.bootSweep` option auto-triggers the sweep immediately after renderer init.
4. The effect is orthogonal to — and safe with — `setStartupCascade`, `spawnWave`, and
   message reveal (locked columns are unaffected).
5. When `uScanSyncAmt = 0` (default) the feature is a complete no-op: zero GPU cost.

---

## Non-Goals

- No 2D canvas fallback — WebGPU/WebGL2 path only.
- No per-column phase randomisation during sweep — synchronisation is the point.
- No equivalent of the Angular Phase 3 "cleanup rect" — the phosphor decay pass
  handles any lingering persistence naturally; a separate erase step would fight it.

---

## Design

### Core idea

The shader computes `headY = aYOff + worldH/2 − cyclePos`. When all columns share the
same `cyclePos`, all heads share the same world-Y — forming the horizontal band.

Two new uniforms control a `mix()` blend on `cyclePos`:

```
cyclePos_final = mix(natural_cyclePos, mod(uScanPhase, cycleH), uScanSyncAmt)
```

- `uScanSyncAmt = 1` → perfect scanline; all heads at the same Y.
- `uScanSyncAmt = 0` → vanilla rain; `mix` identity, zero overhead.
- JS drives `uScanPhase` from 0 → `cycleH` at a fixed speed.

### State machine (3 states)

```
IDLE ──triggerScanlineSweep()──► SWEEPING ──phase reaches cycleH──► DISSOLVING ──tw=1──► IDLE
      ◄──setScanlineSync(0)────────────────────────────────────────────────────────────
```

- **IDLE**: `uScanSyncAmt = 0`, `_scanAnim = null`
- **SWEEPING**: `uScanSyncAmt = 1`, `uScanPhase` advances at `sweepSpeed` units/s
- **DISSOLVING**: `uScanPhase` holds at `cycleH`, `uScanSyncAmt` fades 1 → 0 with ease-out

`setScanlineSync(0)` cancels animation and immediately sets `uScanSyncAmt = 0` (true IDLE).
`setScanlinePhase(v)` cancels animation but preserves the current `uScanSyncAmt` — intended
for scrubbing/manual control, not for returning to IDLE (call `setScanlineSync(0)` for that).

### `cycleH` approximation and band thickness

Shader `cycleH = uWorldH + uNRows * cellStep` where `cellStep` varies per column:

- Inner-sphere columns (large `aScale ≈ 1.45`): `cycleH ≈ 42.5`
- Outer-sphere columns (small `aScale ≈ 0.50`): `cycleH ≈ 25.1`

This means a single `uScanPhase` cannot be perfectly synchronised for all columns
simultaneously. The sync band has inherent thickness: columns near median `cycleH`
are tightly grouped; columns at the extremes diverge by up to ~½ a screen height.
The effect reads as a soft bright sweep rather than a razor-sharp line — which is
actually more visually cohesive for the 3D sphere context.

JS-side approximation computed inline at trigger time using current uniform values:

```js
const cycleHApprox = uniforms.uWorldH.value
                   + uniforms.uNRows.value * uniforms.uCellH.value * 1.9;
// At defaults: 16 + 120 * 0.08 * 1.9 = 34.24 (mean between 25.1 and 42.5)
```

Computed at trigger time (not as a static constant) so `setCellSize()` changes
are reflected automatically. `cycleHApprox` targets the mean `cycleH`, maximising
the fraction of columns whose heads are near the bottom when the sweep transitions
to dissolve.

### Safety with existing systems

| Feature | Interaction |
|---|---|
| `setStartupCascade` | Independent — `vBootFade` computed before `cyclePos`; scanline affects head position, cascade affects alpha |
| `spawnWave` | Independent — spawn gate operates on `aSpawnTheta`, not `cyclePos` |
| `setDensity` / density cull | Independent — density cull operates before the column placement block |
| Message reveal (`isLocked`) | Safe — locked columns override `headY` via `aLockStateAttr.x` downstream of `cyclePos`; scan phase lock is bypassed for them automatically |
| `setReverseChance` | Partial — `revCyclePos = select(isRev, cycleH − cyclePos, cyclePos)` still applies after the mix; reversed columns sweep upward during sync, consistent with the 2D reverse analogue |
| `setBreathAmt` / `setEntrainment` | Suppressed during sweep — both modify the natural `cyclePos` branch which has weight 0 when `uScanSyncAmt = 1`; intentional |

---

## Design Decisions

**`mix(natural, sync, amt)` over attribute-based phase reset**

Alternative: reset all `aYOff` or bake a common `aSeed=0` for sync. Rejected because:
- Attribute writes require `TypedArray` mutation and `needsUpdate = true` every frame.
- Resetting `aYOff` changes persistent geometry state; restoring it on dissolve is fragile.
- `mix()` adds one TSL node to the shader graph, costs a single float MAD per vertex,
  and the dissolve is smooth by construction (no discontinuity at sync→natural boundary).

**Ease-out dissolve (slow then fast diverge)**

Columns that are close to each other in natural phase will diverge slowly at first; then
scatter rapidly. This mirrors the subjective perception of the original effect: the
scanline "holds together" momentarily then suddenly breaks apart.

**`cycleH` approximation at trigger time vs. exact computation**

Exact `cycleH` is per-column (depends on `aScale ∈ [0.5, 1.45]` and per-column
`spacingFactor ∈ [1.85, 1.95]`). The JS-side approximation targets the mean cycleH using
`spacingFactor ≈ 1.9` and `aScale ≈ 0.975` (mean of range), giving ≈34.24. This maximises
the fraction of columns whose heads are near the bottom when the sweep ends. Inner columns
(large cycleH ≈ 42) will be at ~81% of their cycle; outer columns (small cycleH ≈ 25) will
have already wrapped once and be at ~37%. See "band thickness" note in Design above.

---

## Files Changed

| File | Change |
|---|---|
| `matrix-rain-tsl.js` | 2 new uniforms in `makeUniforms()`; 2 entries in `buildGlyphMaterial` destructure; 1-line `cyclePos` blend in vertex Fn |
| `matrix-rain-webgpu.js` | `let _scanAnim`; per-tick block; 3 handle methods (`triggerScanlineSweep`, `setScanlineSync`, `setScanlinePhase`); `opts.bootSweep` in `renderer.init().then()` callback |
| `demo.html` | "Scanline Boot" row in Controls panel: trigger button + speed slider + dissolve-time slider |

---

## Implementation Plan

### Step 1 — New uniforms (`matrix-rain-tsl.js`)

In `makeUniforms()`, add to the return object:

```js
uScanSyncAmt: uniform(0.0),  // blend toward synchronised cyclePos [0=off, 1=full sync]
uScanPhase:   uniform(0.0),  // shared cyclePos value driven by JS [0 → cycleH]
```

In `buildGlyphMaterial`, add both to the destructure block (alongside `uSquadCoherence`):

```js
uScanSyncAmt, uScanPhase,
```

### Step 2 — Vertex shader (`matrix-rain-tsl.js`)

Replace the existing `cyclePos` declaration (lines ~370–373) with:

```js
// Existing natural phase:
const naturalCyclePos = mod(
  uTime.mul(effectiveSpeed).mul(speedMul).add(phaseSeed.mul(cycleH)),
  cycleH
);
// Scanline sync: blend toward a shared phase when uScanSyncAmt > 0
const cyclePos = mix(
  naturalCyclePos,
  mod(uScanPhase, cycleH),
  uScanSyncAmt
).toVar('cyclePos');
```

All downstream references (`cyclePhase`, `revCyclePos`, `headY`) are unchanged — they
reference the JS variable `cyclePos` which now points to the `mix()` node.

### Step 3 — JS state variable (`matrix-rain-webgpu.js`)

Add alongside `let _spawnWaveAnim = null`:

```js
let _scanAnim = null;
// shape when active: { state: 'sweeping'|'dissolving',
//                      startTime, endTime,  // seconds (performance.now()/1000)
//                      sweepSpeed,          // cyclePos units/s (sweeping only; carried for restart)
//                      dissolveTime }        // seconds for sync→0 fade
```

### Step 4 — Per-tick animation block (`matrix-rain-webgpu.js`)

Inside the RAF loop, after the `_spawnWaveAnim` block:

```js
// ── Scanline sweep animation ──────────────────────────────────────────────
if (_scanAnim) {
  const { state, startTime, endTime, sweepSpeed, dissolveTime } = _scanAnim;
  const elapsed  = t - startTime;
  const duration = endTime - startTime;
  const tw = Math.max(0, Math.min(1, elapsed / duration));

  if (state === 'sweeping') {
    uniforms.uScanPhase.value = elapsed * sweepSpeed;
    if (tw >= 1.0) {
      _scanAnim = { state: 'dissolving',
                    startTime: t, endTime: t + dissolveTime,
                    sweepSpeed, dissolveTime };
    }
  } else {
    // ease-out: slow then fast diverge (1 - tw² gives slow start, fast finish)
    uniforms.uScanSyncAmt.value = 1 - tw * tw;
    if (tw >= 1.0) {
      uniforms.uScanSyncAmt.value = 0.0;
      _scanAnim = null;
    }
  }
}
```

### Step 5 — Handle methods (`matrix-rain-webgpu.js`)

```js
/**
 * Trigger an animated scanline boot sweep.
 * @param {object} [opts]
 * @param {number} [opts.speed=4.0]        - cyclePos units/s for the sweep (~world-units/s)
 * @param {number} [opts.dissolveTime=1.5] - seconds for sync→natural dissolve
 */
triggerScanlineSweep({ speed = 4.0, dissolveTime = 1.5 } = {}) {
  const cycleHApprox = uniforms.uWorldH.value
                     + uniforms.uNRows.value * uniforms.uCellH.value * 1.9;
  const now       = performance.now() / 1000;
  const sweepTime = cycleHApprox / speed;
  uniforms.uScanPhase.value   = 0.0;
  uniforms.uScanSyncAmt.value = 1.0;
  _scanAnim = { state: 'sweeping',
                startTime: now, endTime: now + sweepTime,
                sweepSpeed: speed, dissolveTime };
},

/**
 * Set scanline phase lock manually [0=off, 1=full sync]. Cancels any animation.
 * Call setScanlineSync(0) to return to full IDLE (sync off, animation stopped).
 */
setScanlineSync(v) {
  _scanAnim = null;
  uniforms.uScanSyncAmt.value = Math.max(0, Math.min(1, v));
},

/**
 * Set scanline phase manually (0→cycleH≈34). Cancels animation but preserves
 * current uScanSyncAmt — use for scrubbing. Call setScanlineSync(0) separately
 * to turn sync off.
 */
setScanlinePhase(v) {
  _scanAnim = null;
  uniforms.uScanPhase.value = v;
},
```

### Step 6 — `opts.bootSweep` (`matrix-rain-webgpu.js`)

Inside `renderer.init().then(async () => { ... })`, after the `handle?.applyPreset(preset)`
call (line ~1630) and before `animRef.id = requestAnimationFrame(animate)`:

```js
if (opts.bootSweep) {
  handle.triggerScanlineSweep(
    typeof opts.bootSweep === 'object' ? opts.bootSweep : {}
  );
}
```

### Step 7 — Demo controls (`demo.html`)

In the Controls panel, add a "Scanline Boot" row:

```
[Trigger Scanline Sweep]   Speed [slider 1–12, default 4]   Dissolve [slider 0.5–4 s, default 1.5]
```

Also expose `setScanlineSync` and `setScanlinePhase` as debug sliders (Sync 0–1, Phase 0–40).

---

## Parameters

| Param | Range | Default | Notes |
|---|---|---|---|
| `speed` | 1–12 cyclePos u/s | 4.0 | 4.0 ≈ one full screen in 8.6 s at defaults |
| `dissolveTime` | 0.5–4.0 s | 1.5 | Duration of the sync→natural ease-out blend |

---

## Error Conditions

| Condition | Behaviour |
|---|---|
| `triggerScanlineSweep()` called during a running sweep | Restarts from phase=0, sync=1 — previous sweep discarded cleanly |
| `triggerScanlineSweep()` called during dissolve | Restarts sweep; `uScanSyncAmt` snaps back to 1.0 |
| `speed = 0` | Division by zero in `sweepTime = cycleHApprox / speed`; caller responsibility to pass speed > 0 (no guard needed — range is 1–12) |
| `message reveal` active during sweep | Safe — locked columns use `aLockStateAttr.x` for headY regardless of cyclePos |
| `renderer.init()` fails | `opts.bootSweep` code never reached; no orphan animation state |

---

## Backward Compatibility

Both new uniforms default to `0.0`. When neither `triggerScanlineSweep` nor `setScanlineSync`
is called, the `mix()` node evaluates to `mix(natural, _, 0) = natural` — identical to the
pre-feature shader output. Existing callers, presets, and demos are unaffected.

---

## Test Plan

Manual browser tests only (GPU required — no headless path for shader verification):

| # | Test | Focus |
|---|---|---|
| 1 | `triggerScanlineSweep()` with defaults | Horizontal bright band visible sweeping top→bottom, then natural diverge |
| 2 | `speed=1` (slow) | Band clearly visible for ~34 s; no visual artefacts |
| 3 | `speed=12` (fast) | Band flashes across in ~2.8 s; dissolve follows cleanly |
| 4 | `dissolveTime=0.5` | Rapid scatter immediately after sweep |
| 5 | `dissolveTime=4` | Columns stay cohesive for 4 s then scatter |
| 6 | `setScanlineSync(0)` mid-sweep | Instant return to natural rain; no sync residue |
| 7 | `setScanlineSync(0)` mid-dissolve | Immediate cut to natural; no lingering band |
| 8 | `setScanlinePhase(v)` scrub | Phase changes visually; `uScanSyncAmt` unchanged |
| 9 | `triggerScanlineSweep()` during dissolve | Restarts from top cleanly |
| 10 | Message reveal + sweep | Locked glyphs stay pinned; rain around them sweeps normally |
| 11 | `opts.bootSweep: true` | Sweep fires on page load; fires after `applyPreset` not before |
| 12 | `opts.bootSweep: { speed: 8 }` | Sweep fires with custom speed |
| 13 | `setStartupCascade(true)` + sweep simultaneously | Both active; cascade alpha and sweep position independent |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `mix()` node duplicates GPU computation | Low | Low | TSL deduplicates DAG nodes; `naturalCyclePos` sub-graph is emitted once |
| JS `cycleHApprox` diverges from per-column `cycleH` | Low | Low | ~1% error at median cycleH; band thickness across full range is a documented design property, not a defect. Sweep endpoint timing error is <0.1 s at default speed |
| Dissolve ease-out leaves residual sync at tw=1 edge | Low | Low | Explicit `uScanSyncAmt.value = 0.0` on final frame guards this |
| `triggerScanlineSweep` called before `renderer.init()` | Possible | Medium | `uniforms` is available immediately; `_scanAnim` won't tick until RAF starts — no crash, sweep fires on first frame after init |
