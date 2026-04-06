# SPEC — Rain-Integrated Message Reveal

**Status**: Draft
**Replaces**: `SPEC-message-reveal.md` (IMPLEMENTED — overlay-mesh approach)

---

## Motivation

The current message reveal renders characters on a separate `InstancedMesh` with
`NormalBlending`. This works but is fundamentally external to the rain: the characters
float on top of the effect rather than emerging from it.

The user-requested approach: message characters are formed by locking actual rain column
heads at the message band. A column whose head reaches the target Y position for its
character slot has its head glyph overridden to the target character and frozen there.
Rain continues to flow below the locked head via a high-probability spawn. The message
is built organically, letter by letter, as columns happen to intersect each character slot.

Visual result: characters crystallise out of the rain itself. No separate mesh. No
blending artifact. Completely seamless with depth.

---

## Scope

| File | Change |
|---|---|
| `matrix-rain-tsl.js` | New per-instance attribute `aLockState` (vec4); `vLockState` varying; density-cull bypass for locked columns; lock-freeze in vertex Fn; locked-glyph override in fragment Fn; remove `buildMsgColumnMaterial` and `uMsgTex`, `uMsgWave*`, `uMsgCascade*`, `uMsgSettle*`, `uMsgCenter`, `uMsgWorldX*`, `uMsgFace*` uniforms |
| `matrix-rain-webgpu.js` | `showMessage()` rework; `clearMessage()` rework; per-tick lock detection; spawn-below logic; lock attribute buffer management; remove overlay-mesh machinery |
| `matrix-3d.html` | Remove cascadeMode selector |

**Not changed**: `matrix-rain-passes-tsl.js`, `matrix-rain-presets.js`

---

## Concept

### Message band

At `showMessage(text, opts)` time, the message is projected into world space as a
horizontal band at `MSG_DEPTH = 4.0` world units in front of the camera, using the
camera state at trigger time:

```
worldY      — vertical centre of the message row (world units, fixed at trigger time)
charSlots[] — N slots, one per character:
  slot.xCenter — world X centre of this character (fixed at trigger time)
  slot.xHalf   — half-width of this character slot (proportional to advance width)
  slot.glyph   — target atlas glyph index (-1 = unsupported char or space, no lock)
  slot.claimed — bool: true once a column has locked here
  slot.colIdx  — index of the column assigned to this slot (-1 = none yet)
```

Projection math (same as the current InstancedMesh approach):

```js
const tanHalfFov = Math.tan((camera.fov * Math.PI / 180) / 2);
const camAspect  = camera.aspect;
const uvToLocalX = 2.0 * MSG_DEPTH * tanHalfFov * camAspect;  // full width in world units

// Camera right/up in world space → world X/Y of a screen UV point at MSG_DEPTH
worldX = (screenUV_x - 0.5) * uvToLocalX + camera.position.x + camera.getWorldDirection().x * MSG_DEPTH
worldY = (0.5 - screenUV_y) * uvToLocalY + camera.position.y
```

Simplified: `worldY = camera.position.y + (0.5 - yFrac) * uvToLocalY`. World X per character
is computed from pixel advance widths, centred on the camera's forward direction.

### Column slot assignment

Column world X must account for `uColumnOffset`: `colWorldX = aColA.x + uColumnOffset.x`
(column follow mode shifts all columns by this offset).

For each active, non-reversed column where `colWorldX` overlaps any unassigned slot
`[slot.xCenter - slot.xHalf, slot.xCenter + slot.xHalf]`:

1. Mark the slot as **assigned** to this column; record `slot.colIdx`.
2. Write `aLockState = (worldY, slot.glyph, 0.0, 0.0)` into the column's rows in
   `aLockStateData` (see §Attribute buffer sizing). `lockTime = 0` means assigned
   but not yet locked.
3. Flush `needsUpdate = true` on the attribute.

Only one column is assigned per slot. If multiple columns overlap a slot, the one
closest in X to `slot.xCenter` is preferred; ties broken by lowest colIdx.

Reversed columns (head sweeps bottom→top, determined by `h2(colIdx * 0.23, 0.69) ≥ 1 − uReverseChance`)
approach `worldY` from below and cannot reliably hold position there — skip them for assignment.

Density-culled columns (columns where `h2(colIdx * 0.137 + 0.5, 42.7) > uDensity`) are also
skipped: they are not rendered and cannot lock. Another column or the fallback handles their slot.

If a slot has no overlapping eligible column, flag it immediately for **fallback spawn**.

### Head lock

Each tick, for each assigned-but-not-yet-locked column JS computes an approximate head Y:

```js
// JS-side headY approximation (ignores burst/breath/zone — close enough for lock detection)
const nCols  = /* NUM_COLS from _geomParams */;
const nRows  = total / nCols;
const base   = colIdx * nRows * 4;            // index into colABuf / colBBuf (itemSize=4)
const aSpeed = colABuf[base + 2];
const aSeed  = colABuf[base + 3];
const aYOff  = colBBuf[base + 0];
const aScale = colBBuf[base + 1];
// Use nominal spacingFactor 1.85 (per-column hash jitter ignored in JS)
const cellStep = uCellH * aScale * 1.85;
const cycleH   = uWorldH + nRows * cellStep;
const cyclePos = ((uTime * aSpeed + aSeed * cycleH) % cycleH + cycleH) % cycleH;
const headY    = aYOff + uWorldH / 2 - cyclePos;
```

Lock tolerance: `lockTolerance = uCellH * aScale * 1.5` — generous enough to account for
the `spacingFactor` hash jitter (`1.85 ± 0.10`).

When `Math.abs(headY - worldY) < lockTolerance`:

1. Record `lockTime = uTime`.
2. Write `aLockState = (worldY, slot.glyph, lockTime, 0.0)` into all `nRows` rows of this
   column in `aLockStateData`. Set `aLockStateAttr.needsUpdate = true`.
3. Mark `slot.claimed = true`.
4. **Clear other columns** assigned to this slot: for any column previously assigned to
   this same slot, write default lock state `(-9999, -1, 0, 0)` to their rows. This
   prevents multiple columns freezing at the same `worldY`.
5. Roll spawn-below (see §Spawn-below).

### Spawn-below

With probability `spawnChance` (default 0.85):

1. Find the column closest in X to `colWorldX` that is not currently locked, not assigned
   to any slot, and not already in `spawnColumns`. Prefer density-culled columns (those
   whose per-column hash exceeds `uDensity` — do NOT use `aFrustumVis` for this check).
   Limit search to columns within `SPAWN_SEARCH_RADIUS = 2.0` world units (internal
   constant; not a user API parameter). If none available, skip.
2. For the chosen spare column, compute `targetHeadY = worldY - 1.5 * cellStep_approx`.
   Adjust its `aYOff` (`aColB.x`) without touching `aColA.w` (aSeed):
   ```js
   const spareBase     = spareColIdx * nRows * 4;
   const spareSpeed    = colABuf[spareBase + 2];
   const spareSeed     = colABuf[spareBase + 3];
   const spareScale    = colBBuf[spareBase + 1];
   const spareCellStep = uCellH * spareScale * 1.85;
   const spareCycleH   = uWorldH + nRows * spareCellStep;
   const curCyclePos   = ((uTime * spareSpeed + spareSeed * spareCycleH) % spareCycleH + spareCycleH) % spareCycleH;
   const newYOff       = targetHeadY - uWorldH / 2 + curCyclePos;
   for (let r = 0; r < nRows; r++) colBBuf[(spareColIdx * nRows + r) * 4] = newYOff;
   colBAttr.needsUpdate = true;
   ```
3. Set `aLockState.w = 1.0` (the `spawnActive` flag) for all rows of this column. This
   causes the shader to bypass the density cull (see §Shader lock — vertex stage). Record
   this column in a JS `spawnColumns` set.
4. Do NOT modify `aFrustumVis` or `aColA.w`.

JS tracks each spawn-below column separately. Once its head has swept past `worldY - uWorldH`
(i.e. one full cycle duration after lock), clear `aLockState.w` back to `0.0` and flush
`needsUpdate`. This prevents the column from force-rendering forever.

### Shader lock — attribute and varying

#### Attribute

`aLockState: vec4` per instance — (lockY, lockGlyph, lockTime, spawnActive)

| Component | Default | Meaning |
|---|---|---|
| `.x` = `lockY` | −9999.0 | World Y to freeze head at |
| `.y` = `lockGlyph` | −1.0 | Target atlas glyph index |
| `.z` = `lockTime` | 0.0 | `uTime` when lock fired (0 = not yet locked) |
| `.w` = `spawnActive` | 0.0 | 1.0 = force-render this column as spawn-below |

#### Varying

Declare at builder scope in `buildGlyphMaterial()`:

```js
const vLockState = varying(vec4(), 'vLockState');
```

Write OUTSIDE all `If()` blocks (before the density-cull gate) so the fragment stage always
receives a valid value:

```js
vLockState.assign(aLockStateAttr);
```

### Shader lock — vertex stage

Read `aLockState` and determine flags BEFORE the density-cull `If()`:

```js
const aLockStateAttr = attribute('aLockState', 'vec4');
const isLocked      = aLockStateAttr.z.greaterThan(float(0.0));
const isSpawnActive = aLockStateAttr.w.greaterThan(float(0.5));

// Write varying outside any If block
vLockState.assign(aLockStateAttr);
```

Modify the existing density-cull gate to bypass for locked and spawn-active columns:

```js
// Was: If(densityPasses.and(aFrustumVisAttr.greaterThan(float(0.5))), () => {
If(densityPasses.and(aFrustumVisAttr.greaterThan(float(0.5))).or(isLocked).or(isSpawnActive), () => {
```

Inside the vertex body, after `headY` is computed from `revCyclePos`:

```js
// Lock-freeze: pin headY for locked columns
const lockY = aLockStateAttr.x;
headY.assign(select(isLocked, lockY, headY));

// Suppress death-fade so the frozen glyph never vanishes mid-hold
vDeathFade.assign(select(isLocked, float(1.0), vDeathFade));
```

No other vertex changes. The trail above the frozen head exits the viewport as scroll
effectively pauses; this is the intended visual (ghost trail draining upward).

### Shader lock — fragment stage

In the fragment `Fn`, read from `vLockState` (the varying). After the normal glyph index
is resolved from the scramble / weighted-LUT path:

```js
// Read lock state from varying
const lockGlyph  = vLockState.y;
const lockActive = vLockState.z.greaterThan(float(0.0));

// isLockHead: at the head cell (dist ∈ [−0.5, 0.5)) of a locked column
const isLockHead = lockActive
  .and(vDist.greaterThanEqual(float(-0.5)))
  .and(vDist.lessThan(float(0.5)));

// Override glyph only if target glyph is valid (≥ 0)
const hasLockTarget = lockGlyph.greaterThanEqual(float(0.0));
glyphIdx.assign(select(isLockHead.and(hasLockTarget), lockGlyph, glyphIdx));

// Locked head: full-head brightness regardless of trail gradient
rawBright.assign(select(isLockHead, float(1.0), rawBright));

// During hold→fade: multiply brightness by uMsgRevealProgress for all locked cells
rawBright.assign(select(lockActive, rawBright.mul(uMsgRevealProgress), rawBright));
```

For slots with `lockGlyph == -1` (space or unsupported char): no glyph override. The cell
renders normally — scramble stagger still runs but never resolves.

### State machine

Structure unchanged (`idle → revealing → holding → fading → idle`):

| Phase | Lock state | Column behaviour |
|---|---|---|
| `idle` | All `aLockState` at defaults | Normal rain |
| `revealing` | Locks accumulate column by column | Locked columns freeze; spawns below trigger |
| `holding` | All claimed slots locked | Frozen heads persist; `uMsgRevealProgress = 1.0` |
| `fading` | `uMsgRevealProgress` 1→0 | Locked glyphs fade; at progress = 0 clear all `aLockState` |

Transition `revealing → holding`: when all N eligible slots are claimed OR `revealDuration`
expires, whichever first. Slots with `glyph = -1` (spaces) are pre-marked claimed at start.

### Fallback spawn for uncovered slots

If a slot reaches `revealDuration × 0.75` seconds without being claimed:

1. Find the unlocked column closest in X to `slot.xCenter` (regardless of density cull).
2. Force its head to `worldY` by writing `aColB.x` (aYOff) using the same formula as
   spawn-below (target = worldY, not worldY − delta).
3. On the very next tick, the head-lock check will detect this column at the target Y and
   fire the normal lock path.

This guarantees the message fully appears within `revealDuration`, even with sparse column
coverage near a particular character position.

---

## showMessage() API

```js
handle.showMessage('ENTER THE MATRIX', {
  revealDuration:  2.0,   // seconds to allow organic reveal
  holdDuration:    4.0,   // seconds to hold the frozen message
  fadeDuration:    1.0,   // seconds for fade-out
  yFrac:           0.5,   // 0 = top, 1 = bottom of screen
  spawnChance:     0.85,  // probability of spawning a new column below each lock
});
```

`cascadeMode`, `settleSharpness`, `spawnSearchRadius` are no longer parameters. Reveal
order is organic. `uMsgWaveX/R`, `uMsgCascadeMode`, `uMsgSettleSharpness`, `uMsgCenter`,
`uMsgWorldXMin/Max`, `uMsgFaceRight/Up` are all removed uniforms.

`clearMessage({ fadeDuration: 0.8 })` — existing API. On call, must also immediately clear
the `aLockState` attribute for all currently locked columns (write defaults, flush
`needsUpdate = true`), then transition to `fading`.

---

## Attribute buffer sizing

The rain geometry has `total = NUM_COLS × NUM_ROWS` instances. All per-instance attributes
(including `aColA`, `aColB`) have `total` entries, with per-column data replicated for every
row of that column. `aLockState` must follow the same layout:

```js
const aLockStateData = new Float32Array(total * 4);
// Default: (-9999, -1, 0, 0) per instance
for (let i = 0; i < total; i++) {
  aLockStateData[i * 4 + 0] = -9999;
  aLockStateData[i * 4 + 1] = -1;
  aLockStateData[i * 4 + 2] = 0;
  aLockStateData[i * 4 + 3] = 0;
}
const aLockStateAttr = new THREE.InstancedBufferAttribute(aLockStateData, 4);
geom.setAttribute('aLockState', aLockStateAttr);
```

When writing lock data for column `c` (0-indexed), write to all its rows:

```js
for (let r = 0; r < nRows; r++) {
  const i4 = (c * nRows + r) * 4;
  aLockStateData[i4 + 0] = lockY;
  aLockStateData[i4 + 1] = lockGlyph;
  aLockStateData[i4 + 2] = lockTime;
  aLockStateData[i4 + 3] = 0;
}
aLockStateAttr.needsUpdate = true;
```

---

## New / changed uniforms

### Removed uniforms

`uMsgWaveX`, `uMsgWaveR`, `uMsgCascadeMode`, `uMsgSettleSharpness`, `uMsgCenter`,
`uMsgWorldXMin`, `uMsgWorldXMax`, `uMsgFaceRight`, `uMsgFaceUp`, `uMsgTex` — all removed
from `makeUniforms()`. The canvas texture (`dummyMsgTex`) and its creation + assignment
machinery are also removed.

### Kept uniforms

`uMsgRevealProgress` (0→1→0) — drives the brightness fade multiplier for locked glyphs.
`uMsgBoost` — brightness multiplier for locked glyphs (default 2.0, unchanged).

---

## Removed machinery

- `renderMessageToTexture()` — no canvas texture needed
- `buildMsgColumnMaterial()` — no separate mesh
- `_msgColumnMesh` / `_destroyMsgColumnMesh()` — no separate mesh lifecycle
- `projectMessageOntoColumns()` — replaced by inline slot assignment in `showMessage()`
- `uMsgTex` and the dummy `CanvasTexture` created at init time
- `aMsgGlyph`, `aMsgPhase` instance attributes on the overlay mesh (mesh gone)
- `uMsgHalfH` — already removed in a prior change

Note: `aColMsgGlyph` was already removed in a prior implementation; it is not present in
the current codebase and needs no removal step here.

---

## Implementation steps

1. **Attribute buffer**: In `buildGeometry()` (called by `rebuildGeom()`), add:
   ```js
   const aLockStateData = new Float32Array(total * 4);
   aLockStateData.fill(0);
   for (let i = 0; i < total; i++) { aLockStateData[i*4] = -9999; aLockStateData[i*4+1] = -1; }
   geom.setAttribute('aLockState', new THREE.InstancedBufferAttribute(aLockStateData, 4));
   ```
   Store `aLockStateData` in module scope for tick() access.

2. **`makeUniforms()`**: Remove all uniforms listed in §Removed uniforms. Remove the dummy
   `CanvasTexture` creation. Keep `uMsgRevealProgress`, `uMsgBoost`.

3. **`buildGlyphMaterial()` — vertex Fn**:
   - Declare `vLockState = varying(vec4(), 'vLockState')` at builder scope.
   - Before the density-cull `If()`: read `aLockStateAttr`, compute `isLocked`, write
     `vLockState.assign(aLockStateAttr)`.
   - Change cull condition: `.or(isLocked)`.
   - After `headY` computed: add freeze + `vDeathFade` suppression.

4. **`buildGlyphMaterial()` — fragment Fn**:
   - After scramble resolves `glyphIdx`: add glyph override via `vLockState`.
   - After `rawBright` is set: locked-head full-brightness + progress fade.
   - Remove all `uMsgTex` / `uMsgWave*` / `uMsgCascade*` references.
   - Remove `buildMsgColumnMaterial()` function entirely.

5. **`showMessage()` rework**:
   - Project text to world space; build `charSlots[]`.
   - Assign columns to slots (one per slot, eligibility check); write initial `aLockState`
     (lockY, lockGlyph, lockTime=0). If `showMessage()` is called during an active reveal,
     first clear all currently locked columns to defaults, then start fresh.
   - Mark space/unsupported slots as pre-claimed.
   - Start reveal state machine (`msgState = 'revealing'`).

6. **`tick()` additions**:
   - For each assigned-but-not-yet-locked column: compute JS-side `headY`; check tolerance.
   - On lock: write `lockTime` into all rows; flush `needsUpdate`; mark slot claimed; clear
     other columns assigned to same slot; roll spawn-below (write `aLockState.w = 1.0` for
     chosen spawn column; add to `spawnColumns` set).
   - For each spawn-below column in `spawnColumns`: check if head has wrapped past bottom;
     if so, clear `aLockState.w` to 0.0, remove from set.
   - Fallback check: if slot unclaimed at 75% of `revealDuration`, force closest unlocked
     column to `worldY`.
   - All slots claimed (or timer expired) → transition to `holding`.
   - Fading: decrement `uMsgRevealProgress`; at 0, clear all locked `aLockState` and all
     remaining spawn-active `aLockState.w`, transition to `idle`.

7. **`clearMessage()`**: On call, immediately write defaults to all locked columns'
   `aLockState` rows and set `needsUpdate = true`, then set `msgState = 'fading'`.

8. **Remove old machinery**: Delete `renderMessageToTexture`, `buildMsgColumnMaterial`,
   `_msgColumnMesh` / `_destroyMsgColumnMesh`, dummy canvas texture, all removed uniforms.
   Remove cascadeMode selector from `matrix-3d.html`.

---

## Edge cases

| Case | Handling |
|---|---|
| charSet has no glyph for char | `slot.glyph = -1`; scramble runs, no resolve; slot pre-claimed (no lock needed) |
| Text has spaces | Same as unsupported char: `slot.glyph = -1`, pre-claimed |
| Slot has no eligible column | Flagged for fallback spawn immediately at assignment time |
| Column is reversed | Excluded from slot assignment; cannot reliably hold at worldY |
| Column is density-culled at reveal time | Excluded from assignment; another column or fallback handles slot |
| Locked column becomes density-culled later | Density-cull bypass (`.or(isLocked)`) ensures it still renders |
| Camera moves after showMessage() | `worldY` and `worldX` are world-space fixed at trigger time; locked positions stay |
| showMessage() called during active reveal | Clear all existing locked aLockState rows, reset slot state, start fresh |
| uColumnOffset changes | Slot assignment used `colWorldX = aColA.x + uColumnOffset.x` at trigger time; offset is baked into slot X ranges; if offset changes later, locked positions are still world-space correct |

---

## What this does NOT do

- No canvas texture, no dual-channel R/G encoding.
- No radial / horizontal-wave cascade modes (reveal order is organic).
- No separate mesh, no blending artifacts, no occlusion issues.
- Does not change column XZ positions, speed distribution, or atlas.
- Does not support `cascadeMode`, `settleSharpness`, or `spawnSearchRadius` as API params.
