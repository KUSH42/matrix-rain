# SPEC — Column End-of-Life Effects

**Status**: Implemented
**Priority**: P2
**Depends on**: none
**Goal**: Add terminal flash and glyph freeze to column end-of-life, and expose the death-fade threshold as a tunable uniform — all via shader only, zero new attributes or JS state.

---

## Motivation

When a column completes its fall cycle it currently fades uniformly to black over the last
12% of the cycle (`smoothstep(0.88, 1.0, cyclePhase)`).  The death-fade window is
hardcoded and invisible to callers.  There is no way to give the EOL moment any character.

This spec adds two complementary shader effects plus exposes the existing death-fade
threshold as a uniform:

| Effect | Description |
|---|---|
| **Terminal flash** | Head surges bright just before the death fade — a brief phosphor flare as the column "burns out" |
| **Glyph freeze** | Head glyph stops cycling and locks to a stable character during the flash/fade window — data settling before deletion |
| **Death-fade exposure** | `0.88` hardcoded threshold promoted to `uEolFadeStart` so callers can tune it |

All three are pure shader changes.  No new attributes, no JS state.

**Out of scope**: echo ghost (requires a second instanced mesh pass — separate spec).

---

## Scope

| File | Change |
|---|---|
| `matrix-rain-tsl.js` | 3 new uniforms; 1 new varying; terminal flash in fragment Fn; glyph freeze in fragment Fn; `uEolFadeStart` replaces hardcoded `0.88` |
| `matrix-rain-webgpu.js` | 3 new handle methods: `setEolFlash(v)`, `setEolFreezeStart(v)`, `setEolFadeStart(v)` |
| `matrix-3d.html` | 3 new sliders in Glyph FX sub-panel |

**Not changed**: `matrix-rain-passes-tsl.js`, `matrix-rain-presets.js`

---

## Goals

1. `setEolFlash(v)` controls terminal flash intensity; `setEolFlash(0)` disables it with zero extra GPU cost.
2. `setEolFreezeStart(v)` controls the cyclePhase at which the head glyph locks; `setEolFreezeStart(1.0)` disables it.
3. `setEolFadeStart(v)` exposes the death-fade threshold, replacing the hardcoded `0.88`; existing behaviour preserved at the default.
4. All three effects are independently controllable and individually disableable.
5. No new attributes, no new JS per-column state, no new post-processing passes.

---

## Non-Goals

- Echo ghost (requires a second instanced mesh pass — deferred to a separate spec).
- No per-column JS state or new geometry attributes.
- No changes to `matrix-rain-passes-tsl.js` or `matrix-rain-presets.js`.
- No persistence across page reloads.

---

## Concept

### Cycle phases overview

```
cyclePhase ∈ [0, 1]

   0 ──────────── active ─────────────── A ──── flash ──── F ──── fade ──── 1 → 0
                                         ↑                 ↑      ↑
                                  freeze start       flash peak  fade start (uEolFadeStart)
```

Defaults: flash peak 0.87, freeze start 0.80, fade start 0.88.

With defaults the sequence is:
1. **[0, 0.80]** — normal cycling: head glyph changes at `effectiveHoldSec` rate
2. **[0.80, 0.88]** — freeze + flash: head glyph locked; brightness surges then plateaus
3. **[0.88, 1.0]** — death fade multiplies alpha toward 0 (existing behaviour, now tunable)

The three windows are independent — callers can push `uEolFreezeStart` to 1.0 (disable
freeze), `uEolFlash` to 0 (disable flash), or `uEolFadeStart` to 1.0 (instant cutoff).

---

## New Uniforms (`matrix-rain-tsl.js` → `makeUniforms()`)

```js
uEolFlash:       uniform(0.6),   // terminal flash intensity  0–2   (0 = off)
uEolFreezeStart: uniform(0.80),  // cyclePhase at which head glyph freezes  0–1 (1 = off)
uEolFadeStart:   uniform(0.88),  // cyclePhase at which death fade begins   0.5–1
```

Add to the destructure block at the top of `buildGlyphMaterial()`.

---

## New Varying

```js
const vCyclePhase = varying(float(), 'vCyclePhase');
```

Declare at builder scope alongside existing varyings (`vDeathFade`, `vBurst`, etc.).

Add a default assignment in the unconditional pre-gate block (alongside lines 221–233)
to satisfy WGSL's requirement that all varyings are assigned on every execution path:

```js
vCyclePhase.assign(0.0);   // ← add to the defaults block
```

Assign the real value in the vertex Fn, immediately after `cyclePhase` is computed
(inside the density-gate `If` block):

```js
const cyclePhase = cyclePos.div(cycleH);
vCyclePhase.assign(cyclePhase);          // ← add this line
```

---

## Death-Fade Threshold (`matrix-rain-tsl.js`, vertex Fn)

Replace the hardcoded literal:

```js
// before
const deathRamp = smoothstep(0.88, 1.0, cyclePhase);

// after
const deathRamp = smoothstep(uEolFadeStart, float(1.0), cyclePhase);
```

No other changes to the death-fade path.

---

## Terminal Flash (`matrix-rain-tsl.js`, fragment Fn)

### Placement

Insert after the existing `drip` block and before the `flashBucket` glyph-flash block:

```js
// ── Terminal flash — head surges bright near EOL ───────────────────────
// Gaussian peak centred just before the death fade (cyclePhase ≈ 0.87).
// Applied only at the head (dist ≈ 0) via headFrac to avoid lighting the trail.
const eolFlashPeak   = uEolFadeStart.sub(0.01);   // peak 1% before fade start
const eolFlashWidth  = float(0.04);
const eolFlashDelta  = vCyclePhase.sub(eolFlashPeak).div(eolFlashWidth);
const eolFlashCurve  = exp(eolFlashDelta.mul(eolFlashDelta).negate());
const eolFlashAmt    = eolFlashCurve.mul(uEolFlash).mul(headFrac);
col2.addAssign(col2.mul(eolFlashAmt));
```

`headFrac` is already defined above this insertion point:
```js
const headFrac = float(1).sub(smoothstep(0.0, 0.8, vDist));
```

### Result

- At `vCyclePhase = eolFlashPeak` (default 0.87): head multiplied by `1 + uEolFlash`
  (at `uEolFlash = 0.6` → head is 1.6× its normal brightness)
- Falls off with Gaussian shape over ±`eolFlashWidth` (±4% of cycle on each side)
- Zero effect on trail cells (`headFrac ≈ 0` for `dist > 1`)
- Combines additively with the existing drip and head-white effects

---

## Glyph Freeze (`matrix-rain-tsl.js`, fragment Fn)

### Concept

The head glyph currently cycles using a time-derived `changeTick`.  During the freeze
window (`vCyclePhase > uEolFreezeStart`) the tick is replaced with a cycle-stable value
so the displayed glyph no longer changes.

The cycle-stable tick is derived from `vCyclePhase` itself, quantised into a fixed
number of buckets — 20 is enough to produce a deterministic-looking frozen glyph
that differs between cycles:

```js
const frozenTick = floor(vCyclePhase.mul(20.0));
```

Since `vCyclePhase` is deterministic (modular math from `uTime` and `aSpeed`), the
frozen glyph is consistent across frames without any per-column JS state.

### Placement

The freeze replaces the **first** `changeTick` definition — the one in the column
glyph-cycling path (around line 546 in `matrix-rain-tsl.js`). There is a second
unrelated `changeTick` inside the message-reveal section (around line 833) that is
in a different Fn block and must **not** be touched.

The existing `changeTick` logic to replace is:

```js
const changeTick = floor(
  cellPhase.mul(effectiveHoldSec).add(uTime).div(effectiveHoldSec)
);
```

Replace it with:

```js
const isFreezeActive = vCyclePhase.greaterThan(uEolFreezeStart);
const isHeadCell     = vDist.greaterThanEqual(float(-0.5))
                            .and(vDist.lessThan(float(0.5)));
const frozenTick     = floor(vCyclePhase.mul(20.0));
const normalTick     = floor(
  cellPhase.mul(effectiveHoldSec).add(uTime).div(effectiveHoldSec)
);
const changeTick     = select(
  isFreezeActive.and(isHeadCell),
  frozenTick,
  normalTick
);
```

The existing `isLockHead` message-reveal override sits below this and takes priority —
no change needed there.

### Interaction with death fade

The freeze window `[uEolFreezeStart, 1.0]` overlaps the death fade window
`[uEolFadeStart, 1.0]`.  That is intentional: the frozen glyph fades out together with
the rest of the column via `vDeathFade`.  No special casing needed.

---

## Handle Methods (`matrix-rain-webgpu.js`)

Add to the returned handle object in `initMatrixRain`:

```js
setEolFlash(v)       { uniforms.uEolFlash.value       = v; },
setEolFreezeStart(v) { uniforms.uEolFreezeStart.value = v; },
setEolFadeStart(v)   { uniforms.uEolFadeStart.value   = v; },
```

---

## API (`CLAUDE.md` handle methods table)

Add:

| Method | Description |
|---|---|
| `setEolFlash(v)` | Terminal flash intensity 0–2 (0 = off, default 0.6) |
| `setEolFreezeStart(v)` | Cycle phase at which head glyph freezes 0–1 (1 = off, default 0.80) |
| `setEolFadeStart(v)` | Cycle phase at which death fade begins 0.5–1 (default 0.88) |

---

## Uniform Defaults (`CLAUDE.md` uniforms table)

Add:

| Uniform | Default | Note |
|---|---|---|
| `uEolFlash` | `0.6` | Terminal flash intensity; 0 = off |
| `uEolFreezeStart` | `0.80` | Head glyph freeze threshold; 1.0 = off |
| `uEolFadeStart` | `0.88` | Death fade start threshold (was hardcoded) |

---

## Demo Controls (`matrix-3d.html`, Glyph FX sub-panel)

Add three sliders immediately before the closing `</div>` of the Glyph FX sub-panel
(after the existing Burst glyph rate / POM steps rows):

```html
<label>EOL flash
  <span style="display:flex;align-items:center;gap:4px;">
    <input id="ctl-eol-flash"     type="range"  min="0" max="2"   step="0.05" value="0.6">
    <input id="ctl-eol-flash-num" type="number" min="0" max="2"   step="0.05" value="0.6">
  </span>
</label>
<label>EOL freeze start
  <span style="display:flex;align-items:center;gap:4px;">
    <input id="ctl-eol-freeze"     type="range"  min="0" max="1" step="0.01" value="0.80">
    <input id="ctl-eol-freeze-num" type="number" min="0" max="1" step="0.01" value="0.80">
  </span>
</label>
<label>EOL fade start
  <span style="display:flex;align-items:center;gap:4px;">
    <input id="ctl-eol-fade"     type="range"  min="0.5" max="1" step="0.01" value="0.88">
    <input id="ctl-eol-fade-num" type="number" min="0.5" max="1" step="0.01" value="0.88">
  </span>
</label>
```

JS bindings (add to controls setup section):

```js
linkSlider('ctl-eol-flash',  'ctl-eol-flash-num',  v => rain.setEolFlash(v));
linkSlider('ctl-eol-freeze', 'ctl-eol-freeze-num', v => rain.setEolFreezeStart(v));
linkSlider('ctl-eol-fade',   'ctl-eol-fade-num',   v => rain.setEolFadeStart(v));
```

`collectSettings()` additions:

```js
eolFlash:       fv('ctl-eol-flash'),
eolFreezeStart: fv('ctl-eol-freeze'),
eolFadeStart:   fv('ctl-eol-fade'),
```

`applySettings()` additions:

```js
if (s.eolFlash       !== undefined) { rain.setEolFlash(s.eolFlash);             setSlider('ctl-eol-flash',  s.eolFlash); }
if (s.eolFreezeStart !== undefined) { rain.setEolFreezeStart(s.eolFreezeStart); setSlider('ctl-eol-freeze', s.eolFreezeStart); }
if (s.eolFadeStart   !== undefined) { rain.setEolFadeStart(s.eolFadeStart);     setSlider('ctl-eol-fade',   s.eolFadeStart); }
```

---

## Edge Cases

| Case | Behaviour |
|---|---|
| `uEolFlash = 0` | No flash; `eolFlashAmt = 0` throughout; zero cost |
| `uEolFreezeStart = 1.0` | `isFreezeActive` never true; freeze disabled; zero cost |
| `uEolFadeStart = 1.0` | Death fade compressed to nothing (instant cutoff at wrap) |
| `uEolFadeStart = 0.5` | Long fade; overlaps midcycle; visually dimmed columns |
| Locked column (message reveal) | `vDeathFade` is already forced to 1.0 for locked heads — flash and freeze still fire but are not visible because the lock-head glyph and brightness override take priority |
| Reverse columns | `vCyclePhase` is computed from the forward `cyclePos` (before `revCyclePos`), so EOL always fires at the same phase regardless of direction |

---

## Design Decisions

- **Gaussian peak for flash**: `exp(-Δ²)` is one GPU instruction and gives a smooth, physically plausible flare. A hard ramp would look like a strobe.
- **`vCyclePhase` from forward `cyclePhase` (pre-`revCyclePos`)**: Ensures EOL timing is always at the same fraction of the cycle regardless of column direction. Reverse columns still die at the same phase — the column just exits upward instead of downward.
- **`select()` for freeze, not `if()`**: Avoids non-uniform control flow in the fragment shader. `select(condition, a, b)` compiles to a conditional move — both branches evaluate but there is no divergence cost.
- **`frozenTick = floor(vCyclePhase * 20)`**: Twenty buckets is enough to give each cycle a distinct glyph without JS state. Because `vCyclePhase` is deterministic (modular math from `uTime` and `aSpeed`), the frozen glyph is frame-stable.
- **Flash defaults to 0.6 (on)**: The effect is the whole point of this spec. Defaulting to off would make the feature invisible to new users. Backward compatibility is acknowledged in the Backward Compatibility section.
- **`eolFlashPeak = uEolFadeStart - 0.01`**: Ties the flash peak to the fade start so they always feel related; no separate peak uniform needed.

---

## Implementation Plan

**Step 1** — Add 3 uniforms to `makeUniforms()` in `matrix-rain-tsl.js`:
  `uEolFlash`, `uEolFreezeStart`, `uEolFadeStart`.

**Step 2** — Declare `vCyclePhase` varying at builder scope in `buildGlyphMaterial()`;
  add `vCyclePhase.assign(0.0)` to the unconditional defaults block (alongside `vDeathFade`, `vDist`, etc.).

**Step 3** — Add `vCyclePhase.assign(cyclePhase)` in the vertex Fn immediately after `cyclePhase` is computed (inside the density-gate `If` block).

**Step 4** — Replace the hardcoded `0.88` in the `deathRamp` computation with `uEolFadeStart`.

**Step 5** — Insert the terminal flash block in the fragment Fn, after the `drip` block and before the `flashBucket` glyph-flash block.

**Step 6** — Replace the first `changeTick` definition (column glyph-cycling path, ~line 546) with the freeze-aware `select()` version. Do not touch the second `changeTick` in the message-reveal section (~line 833).

**Step 7** — Add 3 handle methods to the returned handle object in `initMatrixRain` in `matrix-rain-webgpu.js`: `setEolFlash`, `setEolFreezeStart`, `setEolFadeStart`.

**Step 8** — Add 3 sliders to the Glyph FX sub-panel in `matrix-3d.html` (before the closing `</div>` of that panel).

**Step 9** — Add `linkSlider` bindings for all 3 controls.

**Step 10** — Add to `collectSettings()` and `applySettings()` in `matrix-3d.html`.

**Step 11** — Update CLAUDE.md handle methods table and uniforms defaults table.

---

## State Changes

No new JS state. All new state is shader-side:

| Uniform | Type | Default | Purpose |
|---|---|---|---|
| `uEolFlash` | `float` | `0.6` | Terminal flash intensity |
| `uEolFreezeStart` | `float` | `0.80` | Head glyph freeze threshold |
| `uEolFadeStart` | `float` | `0.88` | Death fade start threshold |

New varying:

| Varying | Type | Default | Purpose |
|---|---|---|---|
| `vCyclePhase` | `float` | `0.0` | Forward cyclePhase passed to fragment Fn |

No new JS variables, no new per-column attributes, no new geometry.

---

## Capabilities Required

None beyond existing. Pure shader additions.

---

## Cost Impact

| Addition | GPU cost | Memory |
|---|---|---|
| 3 uniforms | Negligible | 12 bytes |
| `vCyclePhase` varying | +4 bytes/vertex in varying buffer | Negligible |
| Terminal flash | 1 `exp()` + 3 muls per fragment when `uEolFlash > 0`; compiler eliminates when `uEolFlash = 0` | Zero |
| Glyph freeze | 1 `select()` per fragment | Zero |
| **Total when all disabled** | Zero extra | Zero |

---

## Determinism Impact

None. `vCyclePhase` is derived from existing deterministic values (`cyclePos`, `cycleH`). `frozenTick` is derived from `vCyclePhase` — fully deterministic per cycle. No new randomness introduced.

---

## Backward Compatibility

`uEolFadeStart` defaults to `0.88` — identical to the previous hardcoded value. No visible change.

`uEolFlash = 0.6` (on by default) and `uEolFreezeStart = 0.80` (on by default) **do** change the appearance of the rain for existing users. This is intentional: these are the desired aesthetics that motivated the spec. Callers who want the prior look can call `setEolFlash(0)` and `setEolFreezeStart(1.0)`.

---

## Test Plan

| Step | Action | Expected |
|---|---|---|
| 1 | Load demo, observe columns | Terminal flash visible at head just before each column dies. Head glyph freezes shortly before fade. |
| 2 | `setEolFlash(0)` | No flash; column dies with plain fade only. |
| 3 | `setEolFlash(2.0)` | Head burns very bright just before fade. |
| 4 | `setEolFreezeStart(1.0)` | Head glyph cycles normally until death — no freeze visible. |
| 5 | `setEolFreezeStart(0.0)` | Head glyph locked for entire column lifetime. |
| 6 | `setEolFadeStart(1.0)` | Column snaps out instantly at cycle wrap — no gradual fade. |
| 7 | `setEolFadeStart(0.5)` | Columns visibly dimmer throughout second half of cycle. |
| 8 | Enable reverse columns (`setReverseChance(1.0)`) | EOL flash and freeze fire correctly for upward columns. |
| 9 | Trigger message reveal | `isLockHead` override still wins; locked head glyph and brightness take priority over freeze. |
| 10 | Sliders in Glyph FX panel | All three sliders and their numeric companions update the effect in real time. |
| 11 | Save/restore settings | `collectSettings` captures all 3 values; `applySettings` restores them correctly. |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `vCyclePhase` default missing → WGSL validation error | Low (fixed in spec) | Build failure | Spec now specifies default assignment in pre-gate block |
| Wrong `changeTick` replaced (message-reveal one) | Low | Scrambled message glyphs | Spec explicitly names the first definition (~line 546) and warns about the second (~line 833) |
| `eolFlashPeak` formula (`uEolFadeStart - 0.01`) wraps negative when `uEolFadeStart < 0.01` | Very low | Flash at wrong phase | Slider minimum is `0.5`; no user can reach `< 0.01` |
| Default flash/freeze changes appearance for existing presets | Medium | Visual regression for preset users | Presets can be updated; behavior is intentional and acknowledged in Backward Compatibility |

---

## Interaction with Other Specs

- **SPEC-message-reveal**: `isLockHead` override sits below `changeTick` in the code and takes priority. No conflict.
- **SPEC-ccp-mode-expansion**: No interaction — CCP mode operates on color uniforms, not EOL timing.
- No dependency on any unimplemented spec.

---

## Review Checklist

- [ ] `vCyclePhase` varying declared at builder scope; default `0.0` in pre-gate block; assigned after `cyclePhase` in vertex Fn
- [ ] `uEolFadeStart` replaces literal `0.88`; no other death-fade logic changed
- [ ] Terminal flash insertion point is after `drip`, before `flashBucket` glyph-flash
- [ ] Glyph freeze replaces first `changeTick` only (column path, ~line 546); message-reveal `changeTick` (~line 833) untouched
- [ ] `isLockHead` message-reveal override still wins (sits below freeze in code)
- [ ] Three handle methods added and exported
- [ ] Three sliders in Glyph FX panel, linked and included in collectSettings/applySettings
- [ ] CLAUDE.md handle table and uniforms table updated
- [ ] PROGRESS.md updated
