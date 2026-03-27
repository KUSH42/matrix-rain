# SPEC-text-reveal — Message reveal animation for the 3D rain

**Status**: Implemented
**Priority**: P2

---

## Motivation

The rain is a visual medium for the Matrix "writing" reality. The natural extension is
letting it write a message — text that crystallises out of the chaos, holds briefly, then
dissolves back into the cascade. This spec adds a `handle.showMessage(text, opts?)` API
that:

1. Renders the message string to an offscreen canvas and uploads it as a GPU texture
2. Drives three new shader uniforms to animate a left-to-right wave reveal across the
   rain glyph mesh
3. In the text region: scrambles glyphs at high rate as the wave front approaches,
   then settles them to a bright, near-static state that reads as the message shape
   through brightness, not character identity
4. After a configurable hold, fades the effect out and returns to normal rain

The effect is additive to the existing pipeline — it runs entirely inside the glyph
material and needs no new post-processing passes.

---

## Relationship to existing features

- `postProcessing: 'rain'`, `'crt'`, and `'none'` — all modes work; the text effect is in
  the glyph layer before any post-processing
- The existing bloom pass naturally picks up the overbrightened text region glyphs and
  adds glow without any changes
- The existing phosphor persistence pass causes the text to linger briefly even after the
  effect fades — a desirable CRT burn-in quality
- `externalLoop: true` — callers drive `handle.tick(t)` and the state machine advances
  normally

---

## Files

| File | Change |
|---|---|
| `matrix-rain-tsl.js` | Add four uniforms (`uMsgTex`, `uMsgRevealProgress`, `uMsgWaveX`, `uMsgBoost`); import `screenUV`; add scramble boost + brightness boost in `outputNode` |
| `matrix-rain-webgpu.js` | Canvas text render helper; message state machine in `tick()`; `showMessage` / `clearMessage` on handle |
| `demo.html` | Message input field + trigger button; clear button |

No new files. No changes to `matrix-rain-passes-tsl.js` or any 2D module.

---

## Visual behaviour

### Reveal phase

A wave front sweeps left to right across the screen (`uMsgWaveX` 0→1, driven by
`tick()` over `revealDuration` seconds).

- **Ahead of the wave**: rain is completely unaffected.
- **At the wave front** (within the text mask): glyphs scramble rapidly — changeTick rate
  is boosted ~20×. The frantic flickering signals that something is being "written".
- **Just behind the wave front** (within the text mask): glyphs settle at ~3–4× normal
  brightness. The scramble rate drops back toward normal over ~0.3 s after the wave
  passes each column. Deep in the settled region the glyphs are near-static, matching the
  "crystallised" quality described in `specs/matrix-rain-analysis.md §4` for the deep
  trail — as if these cells have been written and held.
- **Behind the wave, outside the text mask**: normal rain.

The message reads as a bright shape — a region of overbright, near-static glyphs — not
as exact characters. This is intentional: the existing katakana/ascii glyphs inside the
lit region are dense enough to be readable as letter silhouettes, especially after bloom
adds the surrounding glow. The effect is identical in feel to how operators "read the
Matrix" in the film — pattern recognition through brightness, not symbol decoding.

### Hold phase

After the wave reaches x=1, the effect holds for `holdDuration` seconds.
`uMsgRevealProgress` remains at 1.0. The text region stays bright and near-static.

### Fade phase

`uMsgRevealProgress` decreases from 1→0 over `fadeDuration` seconds. The brightness
boost and scramble boost both scale with `uMsgRevealProgress`, so the effect dissolves
uniformly. Phosphor persistence causes the remaining impression to linger a frame or two
after `uMsgRevealProgress` reaches zero, giving a natural tail.

---

## New shader uniforms

Add to `makeUniforms()` in `matrix-rain-tsl.js`:

```js
uMsgTex:            texture(dummyMsgTex, screenUV),  // 1×1 black CanvasTexture; screenUV baked in
uMsgRevealProgress: uniform(0.0),                    // overall effect opacity 0–1
uMsgWaveX:          uniform(0.0),                    // leading-edge X position in screen UV (0–1)
uMsgBoost:          uniform(3.0),                    // brightness multiplier in text region
```

`dummyMsgTex` is a 1×1 black `THREE.CanvasTexture` created in `matrix-rain-webgpu.js` and
passed into `makeUniforms`. `screenUV` is baked into the node at definition time — TSL
evaluates it lazily per-fragment at render, matching the pattern used by `phosphorPrevTex`.
It satisfies the texture node before any message is shown and allows the shader to be
compiled without a branch.

Expose these four uniforms in the returned object so `matrix-rain-webgpu.js` can reach
them through `uniforms.uMsgRevealProgress`, etc.

---

## Fragment shader changes (`matrix-rain-tsl.js`)

Add `screenUV` to the imports from `three/tsl` (also required by `makeUniforms` for the
`uMsgTex` node — see Tasks).

Insert the following block inside `outputNode`, **after `holdSec` is computed** (line 296
in the current source) and **before `changeTick`** (line 301) — not after `glyphIdx`,
which comes later:

```js
// ── Message reveal ────────────────────────────────────────────────────
// uMsgRevealProgress == 0 → all multipliers resolve to 1.0 (no effect).
// uMsgTex has screenUV baked in; .r gives the mask value at this fragment's screen pos.
const msgMask      = uMsgTex.r;                              // 0 outside text, ~1 inside
const msgWavePast  = step(screenUV.x, uMsgWaveX);            // 1 where wave has passed
const msgActive    = msgMask.mul(msgWavePast).mul(uMsgRevealProgress); // 0–1 combined

// Scramble rate boost — lerp holdSec toward a very small value.
// holdSec drives how frequently the glyph index changes.
// At msgActive=1, glyphs change every ~1/20 s; at 0, normal rate.
const msgHoldSec   = mix(holdSec, float(0.05), msgActive);

// Scramble settle — glyphs calm back down after wave passes.
// waveGap: how far the wave front has moved past this column (0 = just arrived).
const waveGap      = clamp(uMsgWaveX.sub(screenUV.x).mul(6.0), 0.0, 1.0);
const settledHold  = mix(msgHoldSec, holdSec, waveGap.mul(uMsgRevealProgress));
```

Replace the `changeTick` computation with `settledHold` in place of `holdSec`:

```js
// Was: floor(cellPhase.mul(holdSec).add(uTime).div(holdSec))
const changeTick = floor(
  cellPhase.mul(settledHold).add(uTime).div(settledHold)
).add(burstOffset);
```

After the colour computation (`col2` assembled, grain applied, flash applied, depth tint
applied), **before** the POM block, apply the brightness boost:

```js
// Brightness boost in text region — overbright so bloom picks up the shape.
// msgActive is already 0 when uMsgRevealProgress == 0, so no branch needed.
col2.mulAssign(float(1.0).add(msgActive.mul(uMsgBoost.sub(1.0))));
```

No other fragment changes. The alpha path (`rawBright`, `contrast`, `alpha`) already
multiplies `trail * mask * vAlpha * vDepthDim`; the overbrightened `col2` passes through
unchanged, blooms in the post-processing pipeline, and dies naturally when
`uMsgRevealProgress` returns to 0.

### Canvas texture Y-axis

`screenUV` in Three.js WebGPU follows OpenGL convention: `y=0` is the bottom of the
screen. `THREE.CanvasTexture` flips Y by default (`flipY = true`), which corrects the
canvas 2D origin (top-left) to match OpenGL (bottom-left). Text centred at
`canvas.height / 2` correctly lands at `screenUV.y ≈ 0.5`. If the effect appears
vertically flipped during testing, flip the canvas draw origin or set `tex.flipY = false`
and negate the Y in the shader.

---

## Canvas text rendering helper (`matrix-rain-webgpu.js`)

Add a module-level helper (not exported):

```js
/**
 * Render a message string to a CanvasTexture sized to the renderer output.
 * Returns a THREE.CanvasTexture ready to assign to uMsgTex.value.
 *
 * @param {string}        text       message to display
 * @param {number}        w          renderer pixel width
 * @param {number}        h          renderer pixel height
 * @param {object}        [opts]
 * @param {string}        [opts.font]    CSS font string (default: 'bold 80px monospace')
 * @param {string}        [opts.align]   'left'|'center'|'right' (default: 'center')
 * @param {number}        [opts.yFrac]   vertical position 0–1 (default: 0.5)
 * @param {number}        [opts.padding] horizontal padding px (default: 48)
 * @returns {THREE.CanvasTexture}
 */
function renderMessageToTexture(text, w, h, opts = {}) {
  const {
    font    = 'bold 80px monospace',
    align   = 'center',
    yFrac   = 0.5,
    padding = 48,
  } = opts;

  const canvas  = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;
  const ctx     = canvas.getContext('2d');

  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = 'white';
  ctx.font      = font;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';

  const x = align === 'center' ? w / 2
          : align === 'left'   ? padding
          :                      w - padding;
  ctx.fillText(text, x, h * yFrac);

  const tex          = new THREE.CanvasTexture(canvas);
  tex.needsUpdate    = true;
  return tex;
}
```

No minimum canvas size is enforced here — callers pass the renderer's current pixel
dimensions (`renderer.domElement.width`, `renderer.domElement.height`).

---

## Message state machine (`matrix-rain-webgpu.js`)

### New closure variables

Add inside `initMatrixRain`, alongside `let pp`, `let crtHandle`, etc.:

```js
// Message reveal state
let msgState        = 'idle';   // 'idle' | 'revealing' | 'holding' | 'fading'
let msgRevealSpeed  = 0;        // wave units per second (screen widths)
let msgHoldEnd      = 0;        // absolute time (s) when hold ends
let msgFadeSpeed    = 0;        // progress units per second
let msgTex          = null;     // current CanvasTexture; disposed on clearMessage / new message
```

### `tick()` additions

At the end of the existing `tick(t)` function, after the burst bloom logic, add:

```js
// Message state machine
if (msgState !== 'idle') {
  const u = uniforms;
  if (msgState === 'revealing') {
    u.uMsgWaveX.value = Math.min(1.0, u.uMsgWaveX.value + msgRevealSpeed * dt);
    u.uMsgRevealProgress.value = 1.0;
    if (u.uMsgWaveX.value >= 1.0) {
      msgState = 'holding';
      msgHoldEnd = t + (msgHoldEnd);   // msgHoldEnd stores duration until this point
    }
  } else if (msgState === 'holding') {
    if (t >= msgHoldEnd) {
      msgState = 'fading';
    }
  } else if (msgState === 'fading') {
    u.uMsgRevealProgress.value = Math.max(0.0, u.uMsgRevealProgress.value - msgFadeSpeed * dt);
    if (u.uMsgRevealProgress.value <= 0.0) {
      msgState = 'idle';
      u.uMsgWaveX.value = 0.0;
      // Dispose the message texture now that it's invisible
      if (msgTex) { try { msgTex.dispose(); } catch (_) {} msgTex = null; }
      u.uMsgTex.value = dummyMsgTex;   // CanvasTexture IS the texture; no .texture sub-property
    }
  }
}
```

**Note on hold timing**: store `holdDuration` in `msgHoldEnd` temporarily during
`'revealing'`, then convert to an absolute timestamp when entering `'holding'`:

```js
// In 'revealing' state when wave completes:
msgHoldEnd = t + msgHoldEnd;   // msgHoldEnd held the duration; now becomes absolute time
```

Or use a separate `let msgHoldDuration = 0` variable to avoid the double use. Either is
fine; the implementation should pick whichever reads more clearly.

---

## `handle.showMessage(text, opts?)` and `handle.clearMessage(opts?)`

Add to the handle object:

```js
/**
 * Display a message by brightening rain glyphs in the text region.
 * Safe to call before renderer.init() resolves — starts when ready.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.font]            CSS font for canvas rendering (default: 'bold 80px monospace')
 * @param {string} [opts.align]           'left'|'center'|'right' (default: 'center')
 * @param {number} [opts.yFrac]           vertical centre position 0–1 (default: 0.5)
 * @param {number} [opts.revealDuration]  seconds for wave to sweep screen (default: 1.5)
 * @param {number} [opts.holdDuration]    seconds to hold after reveal (default: 3.0)
 * @param {number} [opts.fadeDuration]    seconds to fade out (default: 1.0)
 * @param {number} [opts.boost]           brightness multiplier in text region (default: 3.0)
 */
showMessage(text, opts = {}) {
  const {
    font           = 'bold 80px monospace',
    align          = 'center',
    yFrac          = 0.5,
    revealDuration = 1.5,
    holdDuration   = 3.0,
    fadeDuration   = 1.0,
    boost          = 3.0,
  } = opts;

  // Dispose any previous texture
  if (msgTex) { try { msgTex.dispose(); } catch (_) {} }

  const w = renderer.domElement.width  || element.clientWidth  || 512;
  const h = renderer.domElement.height || element.clientHeight || 512;

  msgTex = renderMessageToTexture(text, w, h, { font, align, yFrac });
  uniforms.uMsgTex.value            = msgTex;
  uniforms.uMsgRevealProgress.value = 0.0;
  uniforms.uMsgWaveX.value          = 0.0;
  uniforms.uMsgBoost.value          = boost;

  msgRevealSpeed = 1.0 / revealDuration;
  msgHoldEnd     = holdDuration;              // duration; tick() converts to absolute time
  msgFadeSpeed   = 1.0 / fadeDuration;
  msgState       = 'revealing';
},

/**
 * Interrupt the current message and fade it out.
 * @param {object} [opts]
 * @param {number} [opts.fadeDuration]  seconds to fade (default: 0.8)
 */
clearMessage(opts = {}) {
  const { fadeDuration = 0.8 } = opts;
  if (msgState === 'idle') return;
  msgFadeSpeed = 1.0 / fadeDuration;
  msgState = 'fading';
},
```

**Pre-init safety**: if `showMessage` is called before `renderer.init()` resolves, the
canvas texture is created immediately and assigned to `uniforms.uMsgTex.value`. The
texture upload happens when the GPU is ready (Three.js queues it). The state machine
starts running in the first `tick()` call after the RAF starts. This means the wave may
begin slightly before the texture is fully uploaded on low-end devices — acceptable.

---

## `dummyMsgTex` — initial texture for `uMsgTex`

The texture node for `uMsgTex` must be satisfied before any message is shown.
Create a 1×1 black canvas texture **before the `makeUniforms` call** (currently line 204),
since `dummyMsgTex` is passed into `makeUniforms` as a parameter:

```js
const dummyMsgCanvas   = document.createElement('canvas');
dummyMsgCanvas.width   = 1;
dummyMsgCanvas.height  = 1;
const dummyMsgTex      = new THREE.CanvasTexture(dummyMsgCanvas);
// ↑ must appear before: const uniforms = makeUniforms(...)
```

Pass `dummyMsgTex` into `makeUniforms` as a new parameter. Inside `makeUniforms`, the
node is created as `texture(dummyMsgTex, screenUV)` so `screenUV` is baked in — matching
the `phosphorPrevTex` pattern. This ensures `uMsgTex` is a valid sampler node from the
moment the material is compiled.

Add `dummyMsgTex` to the state object `s` so `destroyMatrixRain` can dispose it:

```js
const s = { ..., dummyRT, dummyMsgTex, ... };
// in destroyMatrixRain:
s.dummyMsgTex?.dispose();
```

The `_cleanup()` closure should also dispose `msgTex` if a message is in progress when
`destroy()` is called.

---

## `demo.html` additions

Add below the Char set label and above the CRT sub-panel:

```html
<!-- Message reveal sub-panel -->
<div style="border-top:1px solid #00ff7044;margin-top:4px;padding-top:4px;
            display:flex;flex-direction:column;gap:4px;">
  <label style="color:#7fffaa;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;">
    — Message —
  </label>
  <label>Text
    <input id="ctl-msg-text" type="text" value="WAKE UP"
           style="background:#111;color:#00ff70;border:1px solid #00ff70;
                  font-family:'Courier New',monospace;font-size:10px;width:90px;padding:1px 4px;">
  </label>
  <label>Boost
    <input id="ctl-msg-boost" type="range" min="1" max="6" step="0.1" value="3">
  </label>
  <label>Reveal s
    <input id="ctl-msg-reveal" type="range" min="0.3" max="4" step="0.1" value="1.5">
  </label>
  <label>Hold s
    <input id="ctl-msg-hold" type="range" min="0" max="10" step="0.5" value="3">
  </label>
  <label>Fade s
    <input id="ctl-msg-fade" type="range" min="0.2" max="3" step="0.1" value="1">
  </label>
  <label style="justify-content:center;gap:4px;">
    <button id="ctl-msg-show"
            style="background:#111;color:#00ff70;border:1px solid #00ff70;
                   font-family:'Courier New',monospace;font-size:10px;cursor:pointer;
                   padding:2px 8px;">
      SHOW
    </button>
    <button id="ctl-msg-clear"
            style="background:#111;color:#00ff70;border:1px solid #00ff70;
                   font-family:'Courier New',monospace;font-size:10px;cursor:pointer;
                   padding:2px 8px;">
      CLEAR
    </button>
  </label>
</div>
```

Wire in the script block:

```js
document.getElementById('ctl-msg-show').addEventListener('click', () => {
  rain.showMessage(document.getElementById('ctl-msg-text').value, {
    boost:          parseFloat(document.getElementById('ctl-msg-boost').value),
    revealDuration: parseFloat(document.getElementById('ctl-msg-reveal').value),
    holdDuration:   parseFloat(document.getElementById('ctl-msg-hold').value),
    fadeDuration:   parseFloat(document.getElementById('ctl-msg-fade').value),
  });
});
document.getElementById('ctl-msg-clear').addEventListener('click', () => {
  rain.clearMessage();
});
```

---

## Edge cases and constraints

**Multiple calls to `showMessage`**: Always interrupts the current message immediately —
disposes the old texture, creates the new one, resets wave to 0. No queue.

**`clearMessage` on idle**: no-op (guarded by `if (msgState === 'idle') return`).

**Resize during reveal**: The canvas texture was rendered at the old renderer size. The
text will be correctly centred at `screenUV = (0.5, 0.5)` even if the renderer is
resized, because both the texture and `screenUV` space are normalised to 0–1.
The text may appear larger or smaller relative to the screen after resize — acceptable.
Callers who want pixel-perfect text after resize can call `showMessage` again.

**`postProcessing: 'none'` mode**: bloom is absent, so the brightness boost makes the
text visibly brighter but without the glow halo. Still readable. No guard needed.

**`externalLoop: true`**: caller drives `handle.tick(t)` — state machine advances
normally. No special handling needed.

**`uMsgTex` type in TSL**: `texture(dummyMsgTex, screenUV)` creates a `TextureNode` with
the UV baked in. Assigning `uniforms.uMsgTex.value = newCanvasTexture` hot-swaps the
underlying `THREE.Texture` on the node without requiring a material or graph rebuild —
the same mechanism as `phosphorPrevTex.value = prevRT.texture` (where `prevRT` is a
`THREE.RenderTarget`; `CanvasTexture` is itself the texture object so no `.texture`
sub-property is needed).

**Multiline text**: not in scope. Callers who need multiple lines can call `showMessage`
with newline-separated text — the canvas `fillText` will not wrap automatically, so long
messages may clip. This spec does not add wrapping. A future extension could accept
`string[]` and render each line at a different `yFrac`.

---

## Tasks

In dependency order:

1. **Add `dummyMsgCanvas` / `dummyMsgTex` 1×1 canvas texture** in `matrix-rain-webgpu.js`
   **before the `makeUniforms` call** (currently line 204) — not alongside `dummyRT`
   (line 232), which comes after. Add `dummyMsgTex` to the state object `s` for disposal.

2. **Import `screenUV`** from `three/tsl` in `matrix-rain-tsl.js` — required before Task 3
   since `makeUniforms` will reference it in `texture(dummyMsgTex, screenUV)`.

3. **Add four new uniforms** to `makeUniforms()` in `matrix-rain-tsl.js`:
   `uMsgTex`, `uMsgRevealProgress`, `uMsgWaveX`, `uMsgBoost`. The `uMsgTex` node
   requires the dummy canvas texture from Task 1 as its initial value — pass `dummyMsgTex`
   into `makeUniforms` as a new parameter so the node can be constructed there. Also add
   all four new uniform names to the destructuring block at the top of `buildGlyphMaterial`
   so the `outputNode` Fn can access them.

4. **Add `settledHold` derivation** in `outputNode` — insert after `holdSec` is computed,
   before `changeTick`. Replace `holdSec` with `settledHold` in the `changeTick` formula.

5. **Add brightness boost** in `outputNode` — insert after the depth tint block, before
   the POM section. Formula: `col2.mulAssign(float(1.0).add(msgActive.mul(uMsgBoost.sub(1.0))))`.

6. **Add `renderMessageToTexture` helper** function in `matrix-rain-webgpu.js`.

7. **Add message state machine closure variables** (`msgState`, `msgRevealSpeed`,
   `msgHoldEnd`, `msgFadeSpeed`, `msgTex`) in `matrix-rain-webgpu.js`.

8. **Extend `tick()`** with the state machine block. Verify the hold-duration
   `absolute-time` conversion is correct.

9. **Add `showMessage` and `clearMessage`** to the handle. Update `_cleanup()` to also
   dispose `msgTex` if non-null.

10. **Update `destroyMatrixRain`** to dispose `s.dummyMsgTex`.

11. **Update `demo.html`** with the message sub-panel and button wiring.

12. **Manual test checklist**:
    - Default mode: `showMessage('WAKE UP')` → wave sweeps, text glows, holds, fades
    - Interruption: `showMessage` then `clearMessage` mid-reveal → fades cleanly
    - Sequential: two `showMessage` calls → second message replaces first immediately
    - Resize mid-hold → text remains centred (see edge cases above)
    - `postProcessing: 'none'` → text visible without bloom halo, still readable
    - `externalLoop: true` → text animates when caller drives `tick()`
    - `destroy()` during reveal → no dangling textures or animation frames

---

## Out of scope

- Exact character-level decode (glyphs matching the letter silhouette from an atlas)
- Multiline text / wrapping
- Right-to-left or vertical text direction
- Animated typewriter character-by-character entry (separate from the wave reveal)
- Custom reveal wave shapes (radial, top-down, etc.) — wave is always left-to-right
- `showMessage` on the 2D rain (`init2DRain`) — 2D path has its own architecture
