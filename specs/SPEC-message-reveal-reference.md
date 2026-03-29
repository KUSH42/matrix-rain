# SPEC-message-reveal-reference — Message Reveal System (Reference)

**Status:** Implemented
**Files:** `matrix-rain-webgpu.js` (state machine, JS-side column assignment), `matrix-rain-tsl.js` (shader, `aLockState` attribute, lock-head glyph override, band suppression, scramble-settle, fade)

---

## 1. Overview

The message reveal system displays arbitrary text (ASCII/katakana/any charset) as locked-glyph characters crystallising organically out of the rain. Column heads that naturally fall through the target world-Y band "claim" a character slot; once claimed the head glyph is frozen to the target character and brightened. When every slot is claimed the message holds, then fades.

The system works entirely within the existing 600-column instanced mesh — no separate geometry is created at reveal time. A pre-allocated reserve pool of 48 columns (placed at screen-spread positions) guarantees reliable coverage regardless of camera angle.

---

## 2. Public API

```js
// Show a message — starts immediately if idle, replaces the active one otherwise.
handle.showMessage(text, {
  yFrac          = 0.5,    // vertical centre 0–1 of the whole block in screen UV
  lineSpacing    = 0.12,   // UV gap between line centres for multi-line
  revealDuration = 2.0,    // seconds allowed for organic reveal
  holdDuration   = 4.0,    // seconds message is held frozen
  fadeDuration   = 1.0,    // seconds for opacity fade-out
  boost          = 2.0,    // brightness multiplier applied to locked-head glyphs
  trackCamera    = false,  // follow camera.y drift during hold
});

// Cancel an active message, jump to fading.
handle.clearMessage({
  fadeDuration = 0.5,
});

// Rebuild geometry with a different reserve-pool size (no-op while message active).
handle.setMessageReserves(n);  // integer, capped to nCols/4
```

`text` may be a single `string` or `string[]` (one element per line).

---

## 3. State Machine

```
idle ──showMessage()──► revealing ──all claimed or timer expired──► holding ──t >= holdEnd──► fading ──fadeT >= 1──► idle
                                                                                    ↑                       │
                                                                             clearMessage()─────────────────┘
```

| State | Uniforms active |
|---|---|
| `idle` | `uMsgRevealProgress = 0`, `uMsgRevealActive = 0` |
| `revealing` | `uMsgRevealProgress = 1.0`, `uMsgRevealActive = 1.0` (once first glyph locks) |
| `holding` | same |
| `fading` | `uMsgRevealProgress` decreases `1 → 0`, `uMsgRevealActive = 0` (band cleared immediately) |

---

## 4. Data Structures

### 4.1 Slot array (`_msgSlots`)

One entry per character (sum of all characters across all lines):

```js
{
  screenX,     // normalised screen-X of character centre [0, 1]
  halfUV,      // half-width of one character in screen UV units
  glyph,       // atlas glyph index (integer)
  lineIdx,     // which line this character belongs to (index into _msgWorldYs)
  colIdx,      // assigned column index, -1 = unassigned
  claimed,     // true once head has passed through target Y
  fallbackTriggered, // true once force-lock has fired at 92% of revealDuration
}
```

`_msgWorldYs` holds one world-Y value per line (derived from `yFrac`, `lineSpacing`, and `_msgUVToLocalY` at call time). For `trackCamera = true` these are updated each tick by `camera.position.y` delta.

`_msgClaimedCount` is an integer mirror of `_msgSlots.filter(s => s.claimed).length` — avoids an O(n) scan every frame.

### 4.2 Column tracking

| Map/Set | Key | Value | Purpose |
|---|---|---|---|
| `_msgAssigned` | colIdx | slotIdx | Columns recruited, head not yet at target Y |
| `_msgLockedCols` | colIdx | — | Columns whose head has locked and claimed a slot |
| `_msgSpawnCols` | colIdx | worldY | Spawn-below columns (forced just below the message band to densify rain) |

### 4.3 `aLockState` attribute (vec4, per cell)

Written by `_writeLockRows(lockData, nRows, c, lockY, lockGlyph, lockTime, spawnActive)` — fills every row of column `c` with the same value so the vertex shader gets the correct per-column data through the varying system.

| Component | Meaning |
|---|---|
| `.x` — `lockY` | World Y of the target message band; `-9999` = unlocked |
| `.y` — `lockGlyph` | Atlas glyph index the head should crystallise to; `-1` = none |
| `.z` — `lockTime` | `uTime` value at lock moment; `0` = pending (assigned, not yet locked) |
| `.w` — `spawnActive` | `1.0` = force-visible regardless of density/frustum cull (reserve + spawn-below); `0` = normal |

---

## 5. Column Recruitment (revealing phase, per-tick)

For each unclaimed slot in order:

1. **Reserve pool first** — call `_claimReserve(pool, slot.screenX, targetWorldY, ...)`: finds the closest-X unoccupied reserve column, teleports its head to arrive at `targetWorldY` via `_yOffForHead()`, writes `lockTime = 0, spawnActive = 1` to `aLockState`. Column tracked in `_msgAssigned`.

2. **Pool exhausted fallback** — project every non-reserve column through the VP matrix; pick the one with minimum `|sx - slot.screenX|` distance. Write `lockTime = 0, spawnActive = 0`.

3. **Head proximity check** (for all assigned columns each tick) — compute JS-side head Y via `_headYjs()`:
   ```
   cycleH = worldH + nRows * cellStep
   cyclePos = (t * speed * speedMul + seed * cycleH) mod cycleH
   headY = aYOff - worldH/2 + cyclePos
   ```
   Tolerance scales linearly from `tolMultMin = 4` (at reveal start) to `tolMultMax = 18` (at reveal end) × `cellH * aScale * 1.85`. When `|headY - targetWorldY| < tol` the column is locked:
   - Wrap `cyclePos` to `[0, nRows * cellStep)` to ensure the lock-head row index is always valid.
   - Write `lockTime = t` to `aLockState` → scramble-settle animation starts.
   - Mark slot `claimed = true`, add to `_msgLockedCols`, delete from `_msgAssigned`.
   - Clear any other columns assigned to the same slot (duplicates from pool fallback).
   - **Spawn-below**: recruit up to 4 nearby same-X columns, set `spawnActive = 1`, track in `_msgSpawnCols`. These fall toward targetY creating a brief rain density boost.

4. **Fallback force-lock** at `t >= msgRevealFallbackT` (92% of revealDuration): any slot with `colIdx >= 0` but `!claimed` is directly locked without waiting for the head.

5. **Transition to holding**: when `_msgClaimedCount >= _msgSlots.length || t >= msgRevealEnd`.

---

## 6. Shader Side

### 6.1 Varyings

| Varying | Type | Written in vertex | Read in fragment |
|---|---|---|---|
| `vLockState` | `vec4` | `= aLockState` (pass-through) | glyph override, scramble-settle, POM disable |
| `vCellWorldY` | `float` | world Y of this cell's quad centre | band suppression, scanline glow |
| `vColCenterX` | `float` | world X of column centre (baked, const) | scramble-settle coin seed |

### 6.2 Lock-head glyph override (fragment)

```glsl
lockGlyph  = vLockState.y
lockActive = vLockState.z > 0.0
isLockHead = lockActive && vDist >= -0.5 && vDist < 0.5  // within ±0.5 rows of head

lockAge   = uTime - vLockState.z          // seconds since lock
settleT   = clamp(lockAge * uMsgSettleSharpness, 0, 1)   // 0 → 1 over 1/sharpness seconds
settleCoin = fract(sin(lockTime * 31.7 + colCenterX * 47.3) * 43758.5)  // stable per-lock
useLockGlyph = (settleCoin < settleT) && (lockGlyph >= 0)

glyphIdx = isLockHead ? (useLockGlyph ? lockGlyph : mutGlyph) : glyphIdx
```

Scramble-settle is probabilistic: each frame a stable per-lock random number `settleCoin` is compared to a linearly growing `settleT`. When `settleCoin < settleT` the target glyph wins; otherwise the current random mutation wins. This produces a smooth statistical crystallisation rather than a single instantaneous flip.

### 6.3 Band suppression

Discards non-locked fragments inside the message Y-band × X-extent, gated by `uMsgBandSuppress` (user toggle) AND `uMsgRevealActive` (only active once first glyph has locked — prevents a black bar during the approach phase):

```glsl
if (uMsgBandSuppress > 0 && uMsgRevealActive > 0 && !lockActive) {
  inY = |cellWorldY - uMsgRevealY| < uMsgRevealBand   // 0.35 world units half-height
  inX = screenUV.x > uMsgXMin && screenUV.x < uMsgXMax
  if (inY && inX) discard;
}
```

### 6.4 Lock-head brightness and fade

```glsl
// Locked head cells bypass normal trail brightness calculation
rawBright = isLockHead ? uMsgRevealProgress : rawBright

// Flare on lock, cool to uMsgBoost
lockSettle = smoothstep(0, 1, lockAge)   // 0 → 1 over 1 s
lockBoost  = mix(uMsgBoost * 1.5, uMsgBoost, lockSettle)
col2 *= isLockHead ? lockBoost : 1.0

// POM disabled for locked heads (flicker artefact on concave glyphs)
pomDepth = isLockHead ? 0.0 : uDepth
```

`uMsgRevealProgress` is driven `0 → 1` at reveal start, held at `1.0` during hold, then ramped `1 → 0` over `fadeDuration` seconds during the fading state. When it reaches `0`, `_clearAllLocks(true)` resets all `aLockState` entries and returns to idle.

---

## 7. Reserve Pool

Allocated as the last `spawnReserves` columns (default 48) of the geometry. At geometry build time they are positioned at evenly-spaced azimuth angles on the inner shell (or ring, depending on topology) to give predictable screen-X coverage.

The pool is a struct stored on the geometry:

```js
geom._reservePool = {
  reserveStart,           // first reserve column index
  free: [...],            // column indices not yet claimed
  used: new Set(),        // column indices currently in use
  origYOff: Float32Array, // original aYOff values for cleanup
}
```

`_claimReserve(pool, targetScreenX, targetWorldY, colABuf, nRows, vpMat)` picks the closest-X free reserve column, teleports its head, marks it used. `_releaseReserve(pool, colIdx, ...)` restores `aYOff` to original and returns it to `free`.

---

## 8. Key Uniforms

| Uniform | Default | Description |
|---|---|---|
| `uMsgRevealProgress` | `0.0` | Global opacity for lock-head glyphs `0 → 1 → 0` |
| `uMsgBoost` | `2.0` | Brightness multiplier on claimed glyph cells |
| `uMsgRevealY` | `0.0` | World Y centre of the message band |
| `uMsgRevealBand` | `0.35` | Half-height of the suppression band (world units) |
| `uMsgRevealActive` | `0.0` | `1` once first glyph locks; gates band suppression |
| `uMsgXMin` / `uMsgXMax` | `0 / 1` | Screen UV X-bounds of the message text (band suppression X-gate) |
| `uMsgBandSuppress` | `0.0` | User-facing toggle; `1` = enable band suppression |
| `uMsgSettleSharpness` | `4.0` | Scramble→settle speed: crystallises in `1/value` seconds |

---

## 9. Test Concept (Three.js / Vitest)

Because the message reveal state machine runs in JS (no GPU) and the `aLockState` attribute is a plain `Float32Array`, the core logic can be tested headlessly with mocked Three.js geometry.

### 9.1 Test harness

```js
// tests/message-reveal.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Minimal mock for Three.js geometry attribute ──────────────────────────
function makeAttr(nCols, nRows) {
  const arr = new Float32Array(nCols * nRows * 4).fill(0);
  let dirty = false;
  return {
    array: arr,
    get needsUpdate() { return dirty; },
    set needsUpdate(v) { dirty = v; },
  };
}

function makeColABuf(nCols, nRows, overrides = {}) {
  // aColA: [wx, wz, speed, seed] per cell (same for every row in column)
  const buf = new Float32Array(nCols * nRows * 4);
  for (let c = 0; c < nCols; c++) {
    const base = c * nRows * 4;
    buf[base + 0] = overrides[c]?.wx   ?? (c - nCols / 2) * 0.12; // evenly spaced
    buf[base + 1] = overrides[c]?.wz   ?? 1.0;
    buf[base + 2] = overrides[c]?.speed ?? 2.0;
    buf[base + 3] = overrides[c]?.seed  ?? c * 0.13;
    // Copy to all rows
    for (let r = 1; r < nRows; r++) {
      buf.copyWithin((c * nRows + r) * 4, base, base + 4);
    }
  }
  return buf;
}

function makeColBBuf(nCols, nRows, overrides = {}) {
  // aColB: [yOff, scale, ...] per cell
  const buf = new Float32Array(nCols * nRows * 4).fill(0);
  for (let c = 0; c < nCols; c++) {
    const base = c * nRows * 4;
    buf[base + 1] = overrides[c]?.scale ?? 1.0;
    for (let r = 1; r < nRows; r++) {
      buf[(c * nRows + r) * 4 + 1] = overrides[c]?.scale ?? 1.0;
    }
  }
  return buf;
}

// ── Extract helpers under test from module ────────────────────────────────
// _writeLockRows and _headYjs are internal; either export them for testing
// or reconstruct their logic here to test the contract.

function _writeLockRows(lockData, nRows, c, lockY, lockGlyph, lockTime, spawnActive) {
  for (let r = 0; r < nRows; r++) {
    const i4 = (c * nRows + r) * 4;
    lockData[i4 + 0] = lockY;
    lockData[i4 + 1] = lockGlyph;
    lockData[i4 + 2] = lockTime;
    lockData[i4 + 3] = spawnActive;
  }
}
```

### 9.2 Unit tests

```js
// ── _writeLockRows ────────────────────────────────────────────────────────
describe('_writeLockRows', () => {
  it('writes identical values to every row of the column', () => {
    const nCols = 4, nRows = 8;
    const buf = new Float32Array(nCols * nRows * 4);
    _writeLockRows(buf, nRows, 2, 3.5, 7, 1.23, 1);
    for (let r = 0; r < nRows; r++) {
      const base = (2 * nRows + r) * 4;
      expect(buf[base + 0]).toBeCloseTo(3.5);  // lockY
      expect(buf[base + 1]).toBe(7);           // lockGlyph
      expect(buf[base + 2]).toBeCloseTo(1.23); // lockTime
      expect(buf[base + 3]).toBe(1);           // spawnActive
    }
  });

  it('does not touch other columns', () => {
    const nCols = 4, nRows = 4;
    const buf = new Float32Array(nCols * nRows * 4).fill(99);
    _writeLockRows(buf, nRows, 1, -9999, -1, 0, 0);
    // Column 0 still all 99
    expect(buf[0]).toBe(99);
    // Column 2 still all 99
    expect(buf[2 * nRows * 4]).toBe(99);
  });

  it('sentinel values unlock a column', () => {
    const nCols = 2, nRows = 3;
    const buf = new Float32Array(nCols * nRows * 4).fill(1);
    _writeLockRows(buf, nRows, 0, -9999, -1, 0, 0);
    expect(buf[0]).toBe(-9999);
    expect(buf[1]).toBe(-1);
  });
});

// ── JS head-Y approximation ───────────────────────────────────────────────
describe('_headYjs (JS-side head position approximation)', () => {
  // Mirrors the shader formula:
  //   cycleH   = worldH + nRows * cellH * scale * 1.85
  //   cyclePos = (t * speed * speedMul + seed * cycleH) mod cycleH
  //   headY    = aYOff - worldH/2 + cyclePos
  function headYjs(colABuf, colBBuf, nRows, c, t, worldH = 16, cellH = 0.08, speedMul = 1) {
    const base   = c * nRows * 4;
    const speed  = colABuf[base + 2];
    const seed   = colABuf[base + 3];
    const yOff   = colBBuf[base + 0];
    const scale  = colBBuf[base + 1];
    const step   = cellH * scale * 1.85;
    const cycleH = worldH + nRows * step;
    const cp     = ((t * speed * Math.max(0.01, speedMul) + seed * cycleH) % cycleH + cycleH) % cycleH;
    return yOff - worldH / 2 + cp;
  }

  it('returns a value within the column cycle range', () => {
    const nCols = 2, nRows = 10;
    const colA = makeColABuf(nCols, nRows, { 0: { speed: 3.0, seed: 0.5 } });
    const colB = makeColBBuf(nCols, nRows, { 0: { scale: 1.0 } });
    const worldH = 16, cellH = 0.08;
    const cycleH = worldH + nRows * cellH * 1.0 * 1.85;
    for (const t of [0, 0.5, 1, 10, 100]) {
      const y = headYjs(colA, colB, nRows, 0, t, worldH, cellH);
      // headY is within [-worldH/2, -worldH/2 + cycleH]
      expect(y).toBeGreaterThanOrEqual(-worldH / 2 - 1e-4);
      expect(y).toBeLessThan(-worldH / 2 + cycleH + 1e-4);
    }
  });

  it('advances monotonically with t for a positive speed column', () => {
    const nCols = 1, nRows = 10;
    const colA = makeColABuf(nCols, nRows, { 0: { speed: 2.0, seed: 0.0 } });
    const colB = makeColBBuf(nCols, nRows);
    const y0 = headYjs(colA, colB, nRows, 0, 0);
    const y1 = headYjs(colA, colB, nRows, 0, 0.5);
    // Within one cycle (no wrap), y1 > y0 (column falls downward = decreasing Y in world space — actually increases cp → increases headY until wrap)
    expect(y1).toBeGreaterThan(y0);
  });

  it('wraps correctly at cycle boundary', () => {
    const nCols = 1, nRows = 10;
    const worldH = 16, cellH = 0.08;
    const scale = 1.0;
    const speed = 5.0;
    const seed  = 0.0;
    const cycleH = worldH + nRows * cellH * scale * 1.85;
    const tWrap = cycleH / speed; // exactly one full cycle
    const colA = makeColABuf(nCols, nRows, { 0: { speed, seed } });
    const colB = makeColBBuf(nCols, nRows, { 0: { scale } });
    const y0     = headYjs(colA, colB, nRows, 0, 0,     worldH, cellH);
    const yWrap  = headYjs(colA, colB, nRows, 0, tWrap, worldH, cellH);
    expect(yWrap).toBeCloseTo(y0, 3); // should be back to origin
  });
});

// ── State machine invariants ──────────────────────────────────────────────
// These tests drive a stripped-down version of the revealing-tick logic.
describe('message reveal state machine (unit)', () => {
  it('claims a slot when head passes within tolerance', () => {
    // Setup: 1 slot at screenX 0.5, targetWorldY 0, tolerance large
    const claimed = { value: false };
    const headY   = 0.02;  // close to targetWorldY = 0
    const tol     = 0.5;   // generous tolerance
    if (Math.abs(headY - 0) < tol) claimed.value = true;
    expect(claimed.value).toBe(true);
  });

  it('does not claim when head is far from target', () => {
    const claimed = { value: false };
    const headY   = 5.0;
    const tol     = 0.3;
    if (Math.abs(headY - 0) < tol) claimed.value = true;
    expect(claimed.value).toBe(false);
  });

  it('transitions to holding when all slots claimed', () => {
    let state = 'revealing';
    const slots = [{ claimed: false }, { claimed: false }];
    let claimedCount = 0;

    // Simulate locking both slots
    slots[0].claimed = true; claimedCount++;
    slots[1].claimed = true; claimedCount++;

    if (claimedCount >= slots.length) state = 'holding';
    expect(state).toBe('holding');
  });

  it('transitions to fading after holdDuration', () => {
    let state = 'holding';
    const holdEnd = 10.0;
    const t = 10.1;
    if (state === 'holding' && t >= holdEnd) state = 'fading';
    expect(state).toBe('fading');
  });

  it('fade progress reaches 0 at end of fadeDuration', () => {
    const fadeStart = 5.0;
    const fadeDuration = 1.5;
    const t = fadeStart + fadeDuration;
    const fadeT = Math.min(1.0, (t - fadeStart) * (1.0 / fadeDuration));
    const uMsgRevealProgress = 1.0 - fadeT;
    expect(uMsgRevealProgress).toBeCloseTo(0, 5);
  });

  it('clears locks once fade is complete', () => {
    const lockData = new Float32Array(4 * 4).fill(1);  // 1 col, 4 rows
    const nRows = 4;
    const col = 0;
    // Simulate lock
    _writeLockRows(lockData, nRows, col, 2.0, 5, 1.0, 0);
    expect(lockData[0]).toBe(2.0);  // locked
    // Simulate clearAllLocks (sentinel write)
    _writeLockRows(lockData, nRows, col, -9999, -1, 0, 0);
    expect(lockData[0]).toBe(-9999);  // unlocked
  });
});

// ── Scramble-settle logic ──────────────────────────────────────────────────
describe('scramble-settle (JS approximation)', () => {
  // Mirror of shader:
  //   settleT    = clamp(lockAge * sharpness, 0, 1)
  //   settleCoin = fract(sin(lockTime * 31.7 + colX * 47.3) * 43758.5453)
  //   useLock    = settleCoin < settleT

  function settleProb(lockTime, colX, lockAge, sharpness = 4.0) {
    function fract(x) { return x - Math.floor(x); }
    const settleT    = Math.min(1, Math.max(0, lockAge * sharpness));
    const settleCoin = fract(Math.sin(lockTime * 31.7 + colX * 47.3) * 43758.5453);
    return { settleT, settleCoin, useLock: settleCoin < settleT };
  }

  it('probability is 0 at lockAge = 0', () => {
    const { settleT } = settleProb(1.0, 0.5, 0);
    expect(settleT).toBe(0);
  });

  it('probability reaches 1 at lockAge = 1/sharpness', () => {
    const { settleT } = settleProb(1.0, 0.5, 0.25, 4.0);
    expect(settleT).toBeCloseTo(1, 5);
  });

  it('is deterministic for the same inputs', () => {
    const r1 = settleProb(2.5, 1.3, 0.1, 4.0);
    const r2 = settleProb(2.5, 1.3, 0.1, 4.0);
    expect(r1.useLock).toBe(r2.useLock);
  });

  it('different columns produce different coins (no aliasing)', () => {
    const coins = new Set();
    for (let i = 0; i < 20; i++) {
      function fract(x) { return x - Math.floor(x); }
      const c = fract(Math.sin(1.0 * 31.7 + i * 47.3) * 43758.5453);
      coins.add(c.toFixed(6));
    }
    expect(coins.size).toBeGreaterThan(15);  // almost all unique
  });
});
```

### 9.3 Integration test concept (browser / Playwright)

Full end-to-end verification requires a WebGPU context and a rendered frame. The following is the intended test flow — runnable via Playwright against a local `python3 -m http.server` instance:

```js
// tests/e2e/message-reveal.spec.js
import { test, expect } from '@playwright/test';

test('message reveal reaches holding state within revealDuration + 0.5 s', async ({ page }) => {
  await page.goto('http://localhost:8080/matrix-3d.html');
  // Wait for WebGPU init
  await page.waitForFunction(() => typeof rain !== 'undefined' && rain.backend === 'webgpu');

  await page.evaluate(() => {
    window._revealDone = false;
    rain.showMessage('WAKE UP', {
      revealDuration: 0.5,
      holdDuration:   0.5,
      fadeDuration:   0.3,
    });
    // Poll msgState via a debug accessor (requires exposing _msgState or a getState() method)
    const check = setInterval(() => {
      if (window._msgStateProxy === 'holding') {
        window._revealDone = true;
        clearInterval(check);
      }
    }, 100);
  });

  await expect.poll(() => page.evaluate(() => window._revealDone), { timeout: 3000 }).toBe(true);
});

test('clearMessage transitions to fading immediately', async ({ page }) => {
  await page.goto('http://localhost:8080/matrix-3d.html');
  await page.waitForFunction(() => typeof rain !== 'undefined' && rain.backend === 'webgpu');

  await page.evaluate(() => {
    rain.showMessage('CLEAR ME', { holdDuration: 999 });
  });
  await page.waitForTimeout(600); // let reveal phase settle
  await page.evaluate(() => {
    rain.clearMessage({ fadeDuration: 0.1 });
  });
  // uMsgRevealProgress should reach 0 within ~0.2 s
  await page.waitForTimeout(300);
  const progress = await page.evaluate(() => {
    // Access via exposed debug handle or internal uniform
    return rain._uniforms?.uMsgRevealProgress?.value ?? -1;
  });
  expect(progress).toBeCloseTo(0, 1);
});
```

> **Note:** The Playwright tests require exposing `rain._uniforms` or a lightweight debug accessor. Currently the handle object does not expose internal uniforms directly — add `get _uniforms() { return uniforms; }` to the handle as a dev/test-only accessor, or instrument the demo page with `window._msgStateProxy`.

---

## 10. Known Constraints

- **One active message at a time.** `showMessage()` while a message is active immediately begins clearing the prior message (force-fade).
- **Reserve pool depletion.** If more characters than reserve slots exist (default 48), extra slots fall back to nearest non-reserve columns, which may already be moving fast. Increase `spawnReserves` via `setMessageReserves()` before calling `showMessage()`.
- **Camera movement.** Without `trackCamera: true`, moving the camera during hold causes the message to drift off-screen. Enable track only when camera will move vertically.
- **Reversed columns excluded.** Columns whose hash seed falls in the `reverseChance` fraction are never recruited (they fall upward, so the head never reaches the target Y).
- **POM disabled on lock-head cells.** Prevents flicker artefacts on glyphs with concave counters.
