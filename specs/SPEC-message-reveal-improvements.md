# SPEC — Message Reveal Improvements (Round 2)

**Status**: Implemented
**Priority**: Mixed (see priority table)
**Depends on**: SPEC-message-reveal-reference.md (implemented), SPEC-message-reveal-improvements (Changes 1–4, implemented)

---

## Overview

Twelve improvements across four themes, prioritised after the core message-reveal system
and its first round of improvements (auto-pool, saturating spawn, multi-line, camera
tracking) are stable.

| ID | Name | Theme | Priority | Complexity |
|---|---|---|---|---|
| A1 | Cascade direction | Reveal choreography | P1 | Low |
| A2 | Trail column boost | Reveal choreography | P1 | Medium |
| A3 | Scramble set narrowing | Reveal choreography | P2 | Medium |
| B1 | Per-character fade | Exit effects | P1 | Medium |
| B2 | Exit glitch | Exit effects | P2 | Low |
| B3 | Freeze-trail mode | Exit effects | P2 | Medium |
| C1 | onHold / onComplete callbacks | API ergonomics | P1 | Low |
| C2 | Message queue | API ergonomics | P1 | Medium |
| C3 | Vertical text mode | API ergonomics | P3 | High |
| D1 | Resize resilience | Robustness | P1 | Low |
| D2 | Velocity-aware tolerance | Robustness | P2 | Low |
| D3 | VP projection cache | Performance | P3 | Medium |

---

## Theme A — Reveal Choreography

### A1 — Cascade Direction

#### Motivation

Characters currently lock in natural arrival order — whichever column reaches the target
band first claims its slot first. Adding explicit cascade control lets callers choose
left-to-right, right-to-left, centre-out, or rain-speed ordering.

#### Design

Add a `cascadeDir` option to `showMessage`:

```js
showMessage('HELLO', {
  cascadeDir: 'left',   // 'left' | 'right' | 'center-out' | 'rain' (default: undefined = natural)
})
```

Implementation: after `_msgSlots` is built **and after the initial column assignment loop**
(which sets `slot.colIdx`), compute a `revealDelay` per slot and add it as a slot field.
The delay gates the fallback force-move so characters appear in the chosen order.

No shader changes required.

#### `revealDelay` computation

```js
// Run immediately after the initial column assignment + order-fix bubble-sort block.
if (cascadeDir) {
  const nonSpaceSlots = _msgSlots.filter(s => !s.claimed);
  const xs = nonSpaceSlots.map(s => s.screenX);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);

  for (const slot of _msgSlots) {
    if (slot.claimed) { slot.revealDelay = 0; continue; }
    const xFrac = (slot.screenX - xMin) / (xMax - xMin || 1);  // 0..1 left→right
    let t;
    switch (cascadeDir) {
      case 'left':       t = xFrac; break;
      case 'right':      t = 1 - xFrac; break;
      case 'center-out': t = Math.abs(xFrac - 0.5) * 2; break;
      case 'rain': {
        // Sort by column's current fall speed — fastest column locks first.
        // Speed is in aColA.z = colABuf[c * nRows * 4 + 2].
        const spd = slot.colIdx >= 0
          ? colABuf[slot.colIdx * nRows * 4 + 2]
          : 0;
        slot._rainSpeed = spd;
        t = 0;  // set after sort below
        break;
      }
      default: t = 0;
    }
    if (cascadeDir !== 'rain') slot.revealDelay = t * revealDuration * 0.6;
  }

  if (cascadeDir === 'rain') {
    // Sort assigned slots by speed descending (fastest → t=0, slowest → t=1)
    const assigned = _msgSlots.filter(s => !s.claimed && s.colIdx >= 0);
    assigned.sort((a, b) => (b._rainSpeed ?? 0) - (a._rainSpeed ?? 0));
    assigned.forEach((slot, i) => {
      slot.revealDelay = (i / (assigned.length || 1)) * revealDuration * 0.6;
    });
    // Unassigned slots get 0 delay
    _msgSlots.forEach(s => { if (!s.claimed && s.revealDelay === undefined) s.revealDelay = 0; });
  }
}
```

`revealDuration * 0.6` spreads the cascade across 60% of the reveal window; the last 40%
is left for natural convergence (and the fallback force-move at 92%).

#### Applying the delay in the tick

In the fallback force-move block (inside the `revealing` state, after `msgRevealFallbackT`
has elapsed):

```js
// Existing guard: if (t >= msgRevealFallbackT && !slot.fallbackTriggered) { ... }
// Add per-slot delay gate:
if (t < msgRevealStart + (slot.revealDelay ?? 0)) continue;  // not yet eligible
```

Also gate the `_claimReserve` early-reservation path in the same way so reserves are not
claimed before the slot is eligible.

#### New slot fields

| Field | Type | Description |
|---|---|---|
| `revealDelay` | `number` | Seconds after `msgRevealStart` before this slot is eligible for fallback force-move |
| `_rainSpeed` | `number` | Temp field used only during cascade='rain' sort; not accessed after showMessage returns |

#### `showMessage` signature change

```js
showMessage(text, { cascadeDir, ... })
// cascadeDir: undefined (natural, default) | 'left' | 'right' | 'center-out' | 'rain'
```

#### Scope

| File | Change |
|---|---|
| `matrix-rain-webgpu.js` | Add `cascadeDir` to `showMessage` opts destructure; compute `revealDelay` per slot after initial assignment; gate fallback and reserve-claim on delay |
| `CLAUDE.md` | Document `cascadeDir` option in `showMessage` API |

---

### A2 — Trail Column Boost

#### Motivation

During message reveal, the rain column trail above each locking character is the same
brightness as the rest of the scene. Boosting the trail immediately above the locked head
creates a bright drip streak that draws the eye to each newly-appearing glyph.

#### Design

Two new uniforms control the effect in the fragment shader:

| Uniform | Default | Range | Description |
|---|---|---|---|
| `uMsgTrailBoost` | `0.0` | `0–3.0` | Additive brightness multiplier applied to the trail of locked columns |
| `uMsgTrailDecay` | `8.0` | `1–20` | Exponential decay rate — boost falls off with row distance from head |

The boost applies only to the trail cells of currently-locked columns (`isLockTrail`),
which is defined at line ~1021 in the fragment as:

```js
const isLockTrail = lockActive.and(isLockHead.not());
```

This variable is already in scope; no new variable is needed.

#### Shader change (`matrix-rain-tsl.js`)

In `makeUniforms()`, add:

```js
uMsgTrailBoost: uniform(0.0),
uMsgTrailDecay: uniform(8.0),
```

In `buildGlyphMaterial()`, destructure the new uniforms alongside the existing message
uniforms (`uMsgBoost`, etc.).

In the fragment `outputNode`, after the `isLockTrail` trail fade-in block (around line 1022),
add the boost:

```js
// Trail boost: locked-column trail cells glow brighter, decaying away from head.
// d = max(vDist, 0.0) — 0 at head, increases into the trail.
// exp(-d * decay) gives max boost at d=0, decaying toward 0 further up the trail.
const trailBoostAmt = float(1.0).add(
  uniforms.uMsgTrailBoost.mul(exp(d.negate().mul(uniforms.uMsgTrailDecay)))
);
col2.mulAssign(select(isLockTrail, trailBoostAmt, float(1.0)));
```

`d` is already in scope (line 679: `const d = max(vDist, 0.0)`). The boost is a
multiplicative factor, so it scales regardless of base brightness.

**Note**: `uMsgTrailBoost = 0` (default) makes `trailBoostAmt = 1.0`, which is a no-op.
The block can be placed after the existing `rawBright.assign(select(isLockTrail, ...))` line
so the boost is visible in the final output.

#### Handle methods

```js
handle.setMsgTrailBoost(boost, decay?)
// boost: 0–3 (clamp); decay: 1–20 (optional, defaults to current value if omitted)
```

#### Scope

| File | Change |
|---|---|
| `matrix-rain-tsl.js` | Add `uMsgTrailBoost`, `uMsgTrailDecay` to `makeUniforms()`; destructure in `buildGlyphMaterial()`; add boost block in fragment after `isLockTrail` fade-in |
| `matrix-rain-webgpu.js` | Add `setMsgTrailBoost` handle method |
| `CLAUDE.md` | Add uniforms, handle method |

---

### A3 — Scramble Set Narrowing

#### Motivation

During scramble-settle, the mutating glyph is picked uniformly from the full atlas. For
Katakana messages, flashing Latin or symbol glyphs during the scramble phase is jarring.
Narrowing candidates to the same atlas row as the target glyph makes the scramble feel
thematically consistent.

#### Design

Add a new uniform `uSettleSetBlend` (range 0–1):

- `0` = full atlas (current behaviour)
- `1` = same row as the target glyph

| Uniform | Default | Description |
|---|---|---|
| `uSettleSetBlend` | `0.0` | Blend from full-atlas scramble to same-row scramble |

#### Shader change (`matrix-rain-tsl.js`)

In `makeUniforms()`, add:

```js
uSettleSetBlend: uniform(0.0),
```

The row-narrowing code must be inserted **after** `lockGlyph` is declared (line 761) but
**before** the `glyphIdx.assign(...)` call (line 773). Both variables are already in scope
at that point; no forward reference issue.

```js
// Placed after: const lockGlyph = vLockState.y;  (line 761)
// Placed before: glyphIdx.assign(select(isLockHead, select(useLockGlyph, lockGlyph, mutGlyph), glyphIdx));  (line 773)

// Row-constrained scramble: bias mutGlyph toward the same atlas row as the target glyph.
// lockGlyph can be -1 (no target) — clamp to 0 to avoid negative row index.
const safeLockGlyph  = max(lockGlyph, float(0.0));
const targetRow      = floor(safeLockGlyph.div(float(uAtlasGridW)));
const rowStart       = targetRow.mul(float(uAtlasGridW));
// Re-use mutHash (declared at line 746) fractional part to pick within the row.
const mutGlyphRow    = rowStart.add(floor(fract(mutHash.mul(uGlyphCount)).mul(float(uAtlasGridW))));
// Only blend when a lock target exists (hasLockTarget already declared above).
const settleBlend    = select(hasLockTarget, uniforms.uSettleSetBlend, float(0.0));
// Blend between full-atlas mutGlyph and row-constrained mutGlyphRow.
const mutGlyphBlend  = mix(mutGlyph.toFloat(), mutGlyphRow.toFloat(), settleBlend).floor();
```

Replace `mutGlyph` with `mutGlyphBlend` in the `glyphIdx.assign` call at line 773:

```js
glyphIdx.assign(select(isLockHead, select(useLockGlyph, lockGlyph, mutGlyphBlend), glyphIdx));
```

**Naming notes**:
- Use `lockGlyph` (declared at line 761 as `const lockGlyph = vLockState.y;`) — not
  `lockGlyphIdx`.
- Use `uGlyphCount` (not `uAtlasGridW * uAtlasGridH`) so the count respects the active set.
- `mutHash` is declared at line 746; reuse it here.
- `hasLockTarget` is declared at line 766; reuse it here.

#### Handle method

```js
handle.setSettleSetBlend(v)  // v: 0–1
```

#### Scope

| File | Change |
|---|---|
| `matrix-rain-tsl.js` | Add `uSettleSetBlend`; destructure; add row-constrained blend in scramble path; replace `mutGlyph` downstream with `mutGlyphBlend` |
| `matrix-rain-webgpu.js` | Add `setSettleSetBlend` handle method |
| `CLAUDE.md` | Add uniform, handle method |

---

## Theme B — Exit Effects

### B1 — Per-Character Fade

#### Motivation

Currently all locked glyphs fade together at the same rate when the `fading` phase begins.
Staggering the fade per character — outward from centre, left-to-right, or randomly —
creates a dramatic exit.

#### Current fade mechanism (important prerequisite)

The current fade is **entirely JS-driven via a global uniform** — there is no per-cell fade
calculation in the shader. The fading phase runs:

```js
// In the tick, fading state:
const fadeT = Math.min(1.0, (t - msgFadeStart) * msgFadeSpeed);
uniforms.uMsgRevealProgress.value = 1.0 - fadeT;  // 1→0 over fadeDuration
```

The fragment shader reads this as:
```js
// Line ~1018:
rawBright.assign(select(isLockHead, uMsgRevealProgress.mul(mask), rawBright));
```

All locked heads fade uniformly together. To implement per-character staggered fade, the
shader must be given a per-column fade start offset so it can compute individual `fadeT`
values.

#### Design

Add two new uniforms:

| Uniform | Default | Description |
|---|---|---|
| `uMsgFadeStart` | `0.0` | Absolute time (seconds) when the fade phase began; set at hold→fading transition |
| `uMsgFadeDuration` | `1.0` | Duration of the fade in seconds |

Store per-column `fadeOffset` (seconds) in `aLockState.w` at the hold→fading transition.
The shader uses `vLockState.w` as the per-column delay offset when computing fade progress.

```js
showMessage('WAKE UP', {
  fadeDuration: 1.5,
  fadeSpread:   0.8,   // stagger window in seconds (≤ fadeDuration)
  fadeDir:      'center-out',  // 'left' | 'right' | 'center-out' | 'random'
})
```

#### Attribute reuse

`aLockState` is `vec4(lockY, lockGlyph, lockTime, spawnActive)`. The `spawnActive` field
(`.w`) is `1` during the approach phase and `0` when the column has locked or finished
spawning. By the `holding` phase, `.w` is `0` for all locked columns.

At the hold→fading transition, write `fadeOffset` (seconds, range `0–fadeSpread`) into
`.w` for each locked column. During fading, the shader uses this as a time offset.

**On the `isSpawnActive = aLockStateAttr.w.greaterThan(float(0.5))` check**: if
`fadeOffset > 0.5` seconds, the vertex shader will incorrectly treat the column as
"spawn active". However, locked columns already bypass the density cull via `isLocked`,
so the visual result is identical. After `_clearAllLocks` resets all lock data to
`(−9999, −1, 0, 0)`, `.w` is cleared. This is a semantic overlap, not a visual bug.

#### Writing fade offsets at hold→fading

```js
// At holding → fading transition in tick:
const nonSpaceFadeable = _msgSlots.filter(s => s.claimed && s.colIdx >= 0);
const xs    = nonSpaceFadeable.map(s => s.screenX);
const xMin_ = Math.min(...xs);
const xMax_ = Math.max(...xs);

for (const slot of nonSpaceFadeable) {
  const xFrac = (slot.screenX - xMin_) / (xMax_ - xMin_ || 1);
  let orderT;
  switch (_msgFadeDir) {
    case 'left':       orderT = xFrac; break;
    case 'right':      orderT = 1 - xFrac; break;
    case 'center-out': orderT = Math.abs(xFrac - 0.5) * 2; break;
    case 'random':     orderT = Math.random(); break;
    default:           orderT = 0;
  }
  const offset = orderT * Math.min(_msgFadeSpread, _msgFadeDuration * 0.9);
  const c = slot.colIdx;
  for (let r = 0; r < nRows; r++) lockData[(c * nRows + r) * 4 + 3] = offset;
  lockDirty = true;
}
uniforms.uMsgFadeStart.value    = t;
uniforms.uMsgFadeDuration.value = _msgFadeDuration;
```

#### Shader change (`matrix-rain-tsl.js`)

In `makeUniforms()`, add:

```js
uMsgFadeStart:    uniform(0.0),
uMsgFadeDuration: uniform(1.0),
```

In the fragment `outputNode`, replace the existing locked-head alpha line (~line 1018):

```js
// Current:
rawBright.assign(select(isLockHead, uMsgRevealProgress.mul(mask), rawBright));

// New: per-column fade using vLockState.w as per-column delay offset
const fadeOffset   = vLockState.w;  // seconds of delay for this column
const effectiveFadeT = clamp(
  uTime.sub(uMsgFadeStart).sub(fadeOffset).div(max(uMsgFadeDuration, float(0.001))),
  float(0.0), float(1.0)
);
const perColFadeMult = float(1.0).sub(effectiveFadeT);
// When uMsgFadeStart == 0.0 (not fading), effectiveFadeT = large negative → clamp to 0.
// This means perColFadeMult = 1.0 during reveal and hold phases. ✓
rawBright.assign(select(isLockHead, perColFadeMult.mul(mask), rawBright));
```

**Note**: when `uMsgFadeStart == 0.0` and `uTime` is large (e.g. 30 s), `uTime - 0 - offset`
would be large, making `perColFadeMult = 0` even before fading begins. To avoid this:
- Add a gate: `uniforms.uMsgRevealProgress.value` remains in use as a binary on/off gate —
  set it to `0.0` only once the fade is complete (not during reveal/hold), OR
- Add a new boolean uniform `uMsgFading` (0=not fading, 1=fading):
  ```js
  rawBright.assign(select(isLockHead,
    select(uMsgFading.greaterThan(0.5), perColFadeMult, uMsgRevealProgress).mul(mask),
    rawBright));
  ```
  `uMsgFading` is set to `1.0` at hold→fading and `0.0` in `_clearAllLocks`.

The `uMsgFading` uniform approach is cleaner. Add it:

| Uniform | Default | Description |
|---|---|---|
| `uMsgFading` | `0.0` | 1 = per-column fade active; 0 = use `uMsgRevealProgress` global |

#### State variables

```js
let _msgFadeSpread   = 0;      // max stagger window in seconds
let _msgFadeDir      = 'left'; // fade direction
let _msgFadeDuration = 1.0;    // mirrors fadeDuration at showMessage time
```

Set in `showMessage` alongside the existing `msgFadeSpeed` assignment:
```js
_msgFadeDuration = fadeDuration;   // store for B1 uniform at hold→fading
```

Reset all three in `_clearAllLocks` under `if (resetState)`. Also reset the new uniforms:
```js
uniforms.uMsgFading.value    = 0.0;
uniforms.uMsgFadeStart.value = 0.0;
```
(`uMsgFadeDuration` does not need reset — it's only read when `uMsgFading = 1`.)

#### Handle method

```js
handle.setMsgFadeSpread(v)  // v: 0–fadeDuration seconds (clamped at apply time)
```

#### Scope

| File | Change |
|---|---|
| `matrix-rain-tsl.js` | Add `uMsgFadeStart`, `uMsgFadeDuration`, `uMsgFading` to `makeUniforms()`; destructure; replace locked-head alpha line with per-column fade computation |
| `matrix-rain-webgpu.js` | Add `_msgFadeSpread`, `_msgFadeDir`, `_msgFadeDuration` closure vars; write `fadeOffset` to `aLockState.w` at hold→fading; set `uMsgFadeStart`, `uMsgFadeDuration`, `uMsgFading` uniforms; reset in `_clearAllLocks`; add `fadeSpread`/`fadeDir` to `showMessage` opts; add `setMsgFadeSpread` handle |
| `CLAUDE.md` | Document new uniforms, opts, handle method |

---

### B2 — Exit Glitch

#### Motivation

A brief full-screen glitch at the moment the message begins to dissolve is a dramatic
punctuation effect. The existing holo-pass glitch mechanism (`uGlitchAmt`) is already
implemented.

#### Design

Add an `exitGlitch` option to `showMessage`:

```js
showMessage('NEO', {
  exitGlitch:          true,  // default false
  exitGlitchIntensity: 1.2,   // default 0.8
  exitGlitchDuration:  0.4,   // default 0.3 (seconds)
})
```

#### Implementation note — scope constraint

`triggerGlitch` is defined as a method on the handle object and is **not** accessible
from the closure-scoped tick function. To fire glitch from the tick or `_clearAllLocks`,
the glitch body must be extracted to a private closure-scoped function `_doGlitch`:

```js
// Add near the _glitchTimerId declaration:
function _doGlitch(intensity, duration) {
  if (_reducedMotion) return;
  const b = pp?._holoBuild
    ?? currentRainNodes?.passBuilders?._holoBuild
    ?? pp_rainNodes?.passBuilders?._holoBuild;
  if (!b?.uGlitchAmt) return;
  if (_glitchTimerId !== null) clearTimeout(_glitchTimerId);
  b.uGlitchAmt.value = intensity;
  _glitchTimerId = setTimeout(() => { _glitchTimerId = null; b.uGlitchAmt.value = 0.0; }, duration * 1000);
}
```

The existing `triggerGlitch` handle method becomes a thin wrapper. The cancel closure
references `_glitchTimerId` and `b.uGlitchAmt` which are both closure-scoped; the cancel
logic does not move — it stays inline in the handle method:

```js
triggerGlitch(intensity = 0.6, duration = 0.4) {
  _doGlitch(intensity, duration);
  // Cancel function: clears the glitch immediately if needed.
  // Accesses _glitchTimerId and b.uGlitchAmt from closure; must stay here, not in _doGlitch.
  const b = pp?._holoBuild
    ?? currentRainNodes?.passBuilders?._holoBuild
    ?? pp_rainNodes?.passBuilders?._holoBuild;
  return () => {
    if (_glitchTimerId !== null) { clearTimeout(_glitchTimerId); _glitchTimerId = null; }
    if (b?.uGlitchAmt) b.uGlitchAmt.value = 0.0;
  };
},
```

At the `holding → fading` transition in the tick:

```js
if (_msgExitGlitch) _doGlitch(_msgExitGlitchIntensity, _msgExitGlitchDuration);
```

**Note**: `_doGlitch` is a no-op when `pp._holoBuild` is unavailable (i.e. in `'none'`
or `'crt'` pipeline modes). `exitGlitch` silently has no effect in those modes.

#### State variables

```js
let _msgExitGlitch          = false;
let _msgExitGlitchIntensity = 0.8;
let _msgExitGlitchDuration  = 0.3;
```

Reset in `_clearAllLocks`.

#### Scope

| File | Change |
|---|---|
| `matrix-rain-webgpu.js` | Extract `_doGlitch(intensity, duration)` private function; update `triggerGlitch` to call `_doGlitch`; add `_msgExitGlitch` / `_msgExitGlitchIntensity` / `_msgExitGlitchDuration` closure vars; fire at hold→fading; add opts to `showMessage` |
| `CLAUDE.md` | Document new `showMessage` opts |

---

### B3 — Freeze-Trail Mode

#### Motivation

When a locked column is released at the end of fading, the glyph briefly "pops" as the
column resumes normal fall. Freezing the column's trail glyph at the locked position for a
configurable duration before releasing softens this transition.

#### Design

Add a new per-cell attribute `aFreezeUntil` (float, per-cell like all existing attributes)
storing the absolute `uTime` at which the freeze expires. A value of `0` means not frozen.

```js
showMessage('HELLO', {
  freezeTrailDuration: 0,   // default 0 = off; seconds to hold after fade completes
})
```

#### Attribute

```js
// In buildGeom / initGeom (inside the function that creates the geometry):
const freezeUntilBuf  = new Float32Array(nCols * nRows);  // 1 component per cell-instance
geom.setAttribute('aFreezeUntil', new THREE.InstancedBufferAttribute(freezeUntilBuf, 1));
```

The attribute is per-cell (size `nCols * nRows`) because all existing instanced attributes
have one entry per cell-instance. To freeze an entire column, write the same timestamp to
all rows:

```js
function _writeFreezeUntilRows(buf, nRows, c, val) {
  for (let r = 0; r < nRows; r++) buf[c * nRows + r] = val;
}
```

**Access pattern**: do NOT store `freezeUntilBuf` as a closure variable. After
`rebuildGeom()` the geometry is replaced and a closure var would point to the old geometry's
buffer. Access it the same way `lockData` is accessed — fetch fresh via the current
geometry:

```js
const freezeAttr = geomNow.getAttribute('aFreezeUntil');
const freezeUntilBuf = freezeAttr?.array;
```

`rebuildGeom()` must also add `aFreezeUntil` to the new geometry (initialised with all
zeros), just as it already adds `aLockState` at line 2328.

#### Shader change (`matrix-rain-tsl.js`)

Declare the attribute and a new varying in `buildGlyphMaterial()`:

```js
const aFreezeUntilAttr = attribute('aFreezeUntil', 'float');
const vFreezeUntil     = varying(float(), 'vFreezeUntil');
```

In the `vertexNode` varying-assignment block (where all varyings are assigned defaults):
```js
vFreezeUntil.assign(aFreezeUntilAttr);
```

In the vertex body, after the existing `isLocked` head-Y override:
```js
// Freeze: when aFreezeUntil > uTime, pin the head at lockY even after lock is released.
const isFrozenV = aFreezeUntilAttr.greaterThan(uTime);
// lockY = aLockStateAttr.x; only pin if the column is not currently locked
// (frozen is the post-lock phase; if still locked, the existing isLocked logic handles it).
headY.assign(select(isFrozenV.and(isLocked.not()), aLockStateAttr.x, headY));
```

In the fragment `outputNode`, add a glyph-stability override for frozen cells:

```js
const isFrozenF = vFreezeUntil.greaterThan(uTime);
// When frozen: treat as deeply static (holdSec=10000) so the glyph doesn't churn.
// This insertion happens before the holdSec→effectiveHoldSec calculation.
const holdSecFrozen = select(isFrozenF, float(10000.0), holdSec);
// (use holdSecFrozen in place of holdSec in the normalTick computation below)
```

This requires renaming or replacing the `holdSec` variable. The cleanest approach is to
apply the freeze after `holdSec` is computed:

```js
// After the existing holdSec assignment block:
const holdSec = /* existing computation */.toVar('holdSec');
holdSec.assign(select(isFrozenF, float(10000.0), holdSec));
```

#### JS side

In `_clearAllLocks`, write the freeze expiry **before** clearing `_msgSlots` (line 2259),
while `_msgLockedCols` and `_msgSlots` are still populated. Use `uniforms.uTime.value`
for the expiry timestamp — `_clearAllLocks` does not receive `t` as a parameter, but
`uniforms.uTime.value` is set each tick at the start of the tick function and is accurate.

```js
// Add near the top of _clearAllLocks, after geomNow and nRows are computed,
// before the _writeLockRows loop:
const freezeAttr    = geomNow.getAttribute('aFreezeUntil');
const freezeUntilBuf = freezeAttr?.array;
if (_msgFreezeTrailDuration > 0 && freezeUntilBuf && freezeAttr) {
  const expiry = uniforms.uTime.value + _msgFreezeTrailDuration;
  for (const c of _msgLockedCols) {
    _writeFreezeUntilRows(freezeUntilBuf, nRows, c, expiry);
  }
  freezeAttr.needsUpdate = true;
}
```

**Order note**: `freezeUntilBuf` and `lockData` are independent GPU buffers. The freeze
write and the `_writeLockRows` zeroing are in the same synchronous JS block, so the GPU
always sees both together at the next frame — write order does not matter for correctness.

The freeze expires naturally when `uTime > aFreezeUntil` with no JS-side polling. Stale
values (e.g. `aFreezeUntil = 15.0` when `uTime = 30.0`) simply evaluate to false with no
visual effect — no cleanup pass is needed.

#### B1/B3 interaction

B1 repurposes `aLockState.w` for `fadeOffset` during the fading phase. B3 adds a separate
`aFreezeUntil` attribute. These do not conflict. The timeline is:
1. Hold phase: `aLockState.w = 0` (spawnActive already cleared)
2. Hold→fading: B1 writes `fadeOffset` to `aLockState.w`
3. `_clearAllLocks`: writes `aLockState = (−9999, −1, 0, 0)` — clears `.w`
4. B3 freeze: writes `aFreezeUntil = t + freezeTrailDuration` before `_clearAllLocks` zeros it

So B3 must write `aFreezeUntil` inside `_clearAllLocks` **before** the lock data is zeroed
(i.e., before `_writeLockRows(lockData, nRows, c, -9999, -1, 0, 0)` is called for each slot).

#### State variables

```js
let _msgFreezeTrailDuration = 0;
```

Reset in `_clearAllLocks` under `if (resetState)`.

#### Scope

| File | Change |
|---|---|
| `matrix-rain-tsl.js` | Add `aFreezeUntil` attribute, `vFreezeUntil` varying; assign in vertex defaults; pin `headY` when frozen; add `holdSec` freeze override in fragment |
| `matrix-rain-webgpu.js` | Add `aFreezeUntil` attribute in `buildGeom` (all-zeros `Float32Array(nCols * nRows)`); carry attribute through `rebuildGeom`; add `_writeFreezeUntilRows`; fetch `freezeAttr` / `freezeUntilBuf` via `geomNow.getAttribute` in `_clearAllLocks`; add `_msgFreezeTrailDuration`; add `freezeTrailDuration` opt to `showMessage`; reset in `_clearAllLocks` |
| `CLAUDE.md` | Document new opt and attribute |

---

## Theme C — API Ergonomics

### C1 — onHold / onComplete Callbacks

#### Motivation

External code (scripted animations, sequencers) needs to know when the message has fully
revealed (`onHold`) or fully dissolved (`onComplete`) without polling `msgState`.

#### Design

```js
showMessage('WAKE UP', {
  onHold:     () => startCameraOrbit(),
  onComplete: () => triggerNextScene(),
})
```

Both callbacks fire at most once per `showMessage` invocation.

#### State variables

```js
let _msgOnHold     = null;  // (() => void) | null
let _msgOnComplete = null;  // (() => void) | null
```

#### Firing points

**`_msgOnHold`** — fired in the tick at the `revealing → holding` transition, immediately
after `msgState = 'holding'` is set:

```js
msgState = 'holding';
if (_msgOnHold) { const cb = _msgOnHold; _msgOnHold = null; cb(); }
```

**`_msgOnComplete`** — fired at the end of `_clearAllLocks(true)`, after `msgState = 'idle'`
is set, so re-entrant `showMessage` calls within the callback see `msgState === 'idle'`:

```js
// Inside _clearAllLocks, inside if (resetState):
msgState = 'idle';
if (_msgOnComplete) { const cb = _msgOnComplete; _msgOnComplete = null; cb(); }
```

Setting the var to `null` before calling prevents re-entrance if the callback calls
`showMessage` or `clearMessage`.

Both vars are reset to `null` in the `if (resetState)` block of `_clearAllLocks`.

#### Scope

| File | Change |
|---|---|
| `matrix-rain-webgpu.js` | Add `_msgOnHold`, `_msgOnComplete` closure vars; fire at transition points; add `onHold`/`onComplete` to `showMessage` opts; reset in `_clearAllLocks` |
| `CLAUDE.md` | Document opts |

---

### C2 — Message Queue

#### Motivation

Calling `showMessage` while a reveal is active cancels the current message. For scripted
sequences, automatic queuing allows messages to play one-after-another.

#### Design

```js
handle.queueMessage(text, opts)  // Enqueues; fires immediately if idle
handle.clearQueue()              // Clears pending queue (does not affect active message)
```

#### State

```js
let _msgQueue = [];  // Array of { text, opts }
```

#### Access constraint — inner function required

`showMessage` is a handle-object method and is **not** in scope from inside `_clearAllLocks`
(a closure-scoped function). Extract the showMessage body to a closure-scoped function:

```js
function _doShowMessage(text, opts) {
  // ... entire existing showMessage body ...
}
```

The handle's `showMessage` method becomes:

```js
showMessage(text, opts = {}) { _doShowMessage(text, opts); },
```

Then `queueMessage` and the dequeue path both call `_doShowMessage` directly.

#### `queueMessage` handle method

```js
queueMessage(text, opts = {}) {
  if (msgState === 'idle') {
    _doShowMessage(text, opts);
  } else {
    _msgQueue.push({ text, opts });
  }
},
```

#### Auto-dequeue in `_clearAllLocks`

After firing `_msgOnComplete` (if C1 is implemented) and setting `msgState = 'idle'`:

```js
if (_msgQueue.length > 0) {
  const next = _msgQueue.shift();
  // Defer to avoid re-entering the tick state machine synchronously.
  setTimeout(() => _doShowMessage(next.text, next.opts), 0);
}
```

**Ordering note**: `_msgOnComplete` fires before the dequeue check. If the callback calls
`queueMessage`, it appends to `_msgQueue`. But by that point the dequeue check has already
run (the queue was empty when it ran), and the callback's `queueMessage` sees
`msgState === 'idle'` and calls `_doShowMessage` directly. So the `setTimeout` dequeue and
the callback `queueMessage` path produce the same outcome without special-casing.

#### `clearQueue`

```js
clearQueue() { _msgQueue = []; },
```

Does not cancel the currently playing message — use `clearMessage()` for that.

#### Scope

| File | Change |
|---|---|
| `matrix-rain-webgpu.js` | Extract `_doShowMessage`; make `showMessage` a thin wrapper; add `_msgQueue`; add `queueMessage`/`clearQueue` handle methods; dequeue in `_clearAllLocks` after `onComplete` |
| `CLAUDE.md` | Document `queueMessage`, `clearQueue` handle methods |

---

### C3 — Vertical Text Mode

#### Motivation

Display a single word along a vertical column, characters stacked top-to-bottom, each
occupying one row of a single locked column.

#### Design

```js
handle.showVerticalMessage(text, opts = {})
// text:  string — one word per call
// opts:  { xFrac, yFrac, revealDuration, holdDuration, fadeDuration, onHold, onComplete }
// xFrac: screen UV X of the target column (default 0.5)
// yFrac: screen UV Y of the vertical centre of the text block (default 0.5)
```

**Recommendation**: implement as a separate handle method rather than branching inside
`showMessage`. This avoids contaminating the horizontal slot model with vertical-path state.

#### Mechanism

1. Find the column whose projected screen X is closest to `xFrac`.
2. Each character occupies one row. The lock Y for character `i` of `n` is:
   `lockY_i = (0.5 - yFrac) * uWorldH + (i - (n-1)/2) * uCellH * aScale * 1.85`
3. Write `_writeLockRows` with `lockY = lockY_i`, `lockGlyph = charToGlyphIdx(chars[i])`,
   `lockTime = t` (immediately locked — no organic reveal wait), `spawnActive = 0`.
4. All characters lock simultaneously on call (no column-approach wait needed since a single
   column can be pre-positioned).
5. After `holdDuration`, fade via the same `uMsgRevealProgress` path (or B1's
   per-character fade if implemented).

Since vertical mode uses the same `aLockState`, `uMsgRevealActive`, and `msgState` variables
as horizontal mode, only one message (horizontal or vertical) can be active at a time.

#### Complexity note

Vertical mode is high complexity because the fallback scan, reserve pool, and spawn-below
logic are all horizontal-model specific and must be entirely bypassed. Implementing as
`showVerticalMessage` keeps the complexity isolated. Multi-column vertical (`['NEO',
'WAKES']`, two side-by-side columns) is an extension not covered by this spec.

#### Scope

| File | Change |
|---|---|
| `matrix-rain-webgpu.js` | Add `showVerticalMessage` handle method; share `msgState` / `_clearAllLocks` with horizontal path |
| `CLAUDE.md` | Document `showVerticalMessage` |

---

## Theme D — Robustness & Performance

### D1 — Resize Resilience

#### Motivation

`_msgUVToLocalX` and `_msgUVToLocalY` are computed once at `showMessage` time. If the
canvas is resized during a reveal, the UV-to-world scale becomes stale, causing the fallback
force-move to target wrong world positions.

#### Design

On every tick while `msgState !== 'idle'`, check if the canvas aspect has changed:

```js
const currentAspect = renderer.domElement.width / renderer.domElement.height;
if (Math.abs(currentAspect - _msgAspect0) > 1e-3) {
  const wH = uniforms.uWorldH.value;
  _msgUVToLocalX = wH * currentAspect;
  _msgUVToLocalY = wH;                  // uWorldH doesn't change on resize
  _msgAspect0 = currentAspect;
}
```

This check is O(1) and adds negligible overhead. No new attributes or uniforms required.

`_msgAspect0` is set at `showMessage` time alongside `_msgUVToLocalX`:

```js
_msgAspect0 = camera.aspect;  // set in showMessage, alongside _msgUVToLocalX
```

#### State variables

```js
let _msgAspect0 = 1;  // aspect at showMessage time (or last resize during reveal)
```

Reset in `_clearAllLocks`.

#### Scope

| File | Change |
|---|---|
| `matrix-rain-webgpu.js` | Add `_msgAspect0`; set in `showMessage`; per-tick aspect check while `msgState !== 'idle'`; update `_msgUVToLocalX` on change |

---

### D2 — Velocity-Aware Tolerance

#### Motivation

At high column speeds, a fast column can skip over the tolerance window in a single frame,
triggering the fallback force-move even though the column would have arrived naturally on
the next tick. Clamping `tol` to at least 1.5× the current tick's displacement prevents
false-positive fallback triggers.

#### Design

**Existing variables** (no new declarations needed):
- `dt` — already declared at line 1554: `const dt = prevTs > 0 ? t - prevTs : 1/60`
- `colABuf[colIdx * nRows * 4 + 2]` — column speed (`aColA.z`; **not** `colBBuf` which
  holds `(yOff, scale, alpha, trail)`)

In the fallback tolerance check block (approximately line 1764):

```js
// Current:
const tol = uniforms.uCellH.value * Math.max(aScale, msgTolMinScale) * 1.85 * tolMult;

// New: velocity-aware clamp
const colSpeed  = colABuf[colIdx * nRows * 4 + 2];          // aColA.z = speed
const maxDisp   = colSpeed * uniforms.uSpeedMul.value * dt;  // approximate world displacement this tick
const dynTol    = Math.max(tol, maxDisp * 1.5);              // ensure tol covers ≥ 1.5 ticks
if (Math.abs(headY - _msgWorldYs[slot.lineIdx]) < dynTol) { /* lock */ }
```

`uniforms.uSpeedMul.value` is the global speed multiplier. Per-column breath/entrainment
effects are shader-only and not cheaply available in JS; the approximation is sufficient
for the purpose of preventing skipped-frame false negatives.

#### Scope

| File | Change |
|---|---|
| `matrix-rain-webgpu.js` | Apply `dynTol` in the existing fallback tolerance check block; use existing `dt` variable (no new declaration) |

---

### D3 — VP Projection Cache

#### Motivation

The fallback scan reprojects reserve columns on each tick. With 150 reserves and 20+
active slots, the projection count scales as `nReserves × nActiveSlots` per tick. Pre-
projecting all reserves once per tick reduces this to a single pass.

#### Design

**Context**: The existing `showMessage` already builds a `vpMat` (line 3351):

```js
const vpMat = new THREE.Matrix4().multiplyMatrices(
  camera.projectionMatrix, camera.matrixWorldInverse
);
```

The cache extends this idea to the tick: rebuild `vpMat` once at the start of each
revealing-state tick and project all active reserve columns.

```js
// At the start of the revealing tick (before the slot loop):
camera.updateMatrixWorld();
_msgVpMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
// _msgVpMat is the existing scratch Matrix4 declared at line ~1542.

const reserveScreenXs = new Float32Array(reserveStart);  // allocate once per showMessage, reuse across ticks
for (let c = 0; c < reserveStart; c++) {
  const base = c * nRows * 4;
  const wx   = colABuf[base + 0] + uniforms.uColumnOffset.value.x;
  const wz   = colABuf[base + 1] + uniforms.uColumnOffset.value.y;
  _msgTv.set(wx, midWorldY, wz, 1.0).applyMatrix4(_msgVpMat);
  reserveScreenXs[c] = _msgTv.w > 0 ? (_msgTv.x / _msgTv.w) * 0.5 + 0.5 : -999;
}
```

Where `midWorldY` is the midpoint of `_msgWorldYs` (already available in the tick).

**Correct projection order**: `_msgVpMat = P × V`, then `applyMatrix4(_msgVpMat)` applies
`P × V × worldPoint` in a single step. Using `_msgTv` (the existing scratch `Vector4` at
line ~1541) avoids allocation. Note that both `wz` (aColA.y) and the correct `midWorldY`
must be included — columns are not at `z=0` or `y=0`.

The fallback scan loop then reads `reserveScreenXs[c]` instead of reprojecting each
column. This requires allocating `reserveScreenXs` once at `showMessage` time and storing
it in the closure (e.g. `let _msgReserveScreenXs = null`).

**Note on applicability**: At `nCols = 600`, default 48 reserves with 20 active slots =
960 projections/tick without cache vs 48 projections/tick with cache. Cache pays off at
high-slot-count messages. At typical usage it is a low-priority optimization.

#### State variable

```js
let _msgReserveScreenXs = null;  // Float32Array | null; allocated at showMessage time
```

Set `_msgReserveScreenXs = new Float32Array(reserveStart)` in `showMessage`.
Reset `_msgReserveScreenXs = null` in `_clearAllLocks` (any resetState value is fine).

#### Scope

| File | Change |
|---|---|
| `matrix-rain-webgpu.js` | Add `_msgReserveScreenXs`; allocate at `showMessage` time; populate at start of revealing tick; use in fallback scan; reset in `_clearAllLocks` |

---

## Implementation Order

Recommended ship order based on dependencies and priority:

1. **D1** — Resize resilience (P1, trivial, 0 dependencies)
2. **C1** — onHold/onComplete callbacks (P1, low complexity, 0 dependencies)
3. **B2** — Exit glitch (P2, low complexity: extract `_doGlitch` function)
4. **A1** — Cascade direction (P1, low complexity, 0 shader changes)
5. **C2** — Message queue (P1, medium: depends on `_doShowMessage` extraction; compatible with C1)
6. **A2** — Trail column boost (P1, medium: new uniforms + shader fragment edit)
7. **B1** — Per-character fade (P1, medium: new uniforms `uMsgFadeStart`/`uMsgFadeDuration`/`uMsgFading`; repurposes `aLockState.w`)
8. **D2** — Velocity-aware tolerance (P2, trivial: one-line change using existing `dt`)
9. **A3** — Scramble set narrowing (P2, medium: shader edit in scramble path)
10. **B3** — Freeze-trail mode (P2, medium: new per-cell attribute; does not conflict with B1)
11. **D3** — VP projection cache (P3, low ROI until nCols scales up)
12. **C3** — Vertical text mode (P3, high complexity: separate handle method)

**B1 / B3 ordering note**: B1 repurposes `aLockState.w` for `fadeOffset`. B3 adds a
separate `aFreezeUntil` attribute. No conflict. Implement B1 before B3 to avoid needing
to re-review the `aLockState.w` usage with B3's attribute already present.

**C2 prerequisite**: C2 requires extracting `_doShowMessage`. This refactor also benefits
B2 (which requires extracting `_doGlitch`). Both should be done before or together with
C2.
