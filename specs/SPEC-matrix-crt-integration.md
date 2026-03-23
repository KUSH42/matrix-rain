# SPEC-matrix-crt-integration

**Status**: Reviewed
**Priority**: P1
**Reference**: `../telescreen-crt-webgpu/CLAUDE.md`, `../telescreen-crt-webgpu/telescreen-crt-webgpu.js`

---

## Motivation

matrix-rain-webgpu and telescreen-crt-webgpu are complementary layers:
matrix-rain simulates the 3-D animated rain with film-style post-processing;
telescreen-crt simulates the display hardware the rain would appear on (scanlines,
phosphor mask, halation, barrel warp, convergence, etc.).

Integration should composite them without penalty: one `THREE.RenderPipeline`,
one scene render per frame, zero intermediate canvas copies.

`THREE.RenderPipeline` is the Three.js r171+ successor to `THREE.PostProcessing`.
Both existing codebases already use it; the spec uses the name consistently.

---

## Path C: Single PostProcessing Graph

The entire effect runs in one `THREE.RenderPipeline` that chains the two node
graphs end-to-end:

```
pass(scene, camera)
  → bloom → heat → phosphor → soften → streaks → holo → god rays
  → warp → glitch → [signal] → kernel → mask → halation → gamma → [grain/snow]
  → FXAA → screen
```

Everything is composed at the TSL node level. One RAF loop drives one
`pp.render()` per frame. No extra RTTs between the two stacks.

---

## Required changes — overview

| What | Where | Scope |
|---|---|---|
| Node-factory split + `externalLoop` opt | `matrix-rain-webgpu.js` | Internal refactor, backward-compat wrapper kept |
| Expose `scene`, `camera`, `renderer` on handle | `matrix-rain-webgpu.js` | Additive |
| New export: `buildCRTNodesFromSource` | `telescreen-crt-webgpu.js` | Additive only |
| Glue module | `matrix-rain-webgpu/matrix-rain-crt-bridge.js` | New file |

---

## 1. Changes to `matrix-rain-webgpu.js`

### 1a. Split `buildPostProcessing` into a node factory

Introduce internal `buildMatrixRainNodes(sceneColorNode)` that accepts the
scene colour output node, chains the full matrix-rain PP graph on top of it,
and returns:

```js
{
  outputNode,      // TSL node — final output of the rain PP chain, pre-FXAA
  rttPhosphor,     // RTTNode for phosphor persistence — needed by postRender
  passBuilders,    // { _bloomNode, _heatBuild, _softenBuild, _streakBuild,
                   //   _holoBuild, _godRaysBuild }
  postRender(renderer),
  // Lazily calls ensurePrevRT() (allocating prevRT on first call), then:
  //   renderer.copyTextureToTexture(
  //     rttPhosphor.renderTarget.texture,
  //     prevRT.texture
  //   )
  // Guard: perform only when both rttPhosphor.renderTarget and prevRT are ready.
  // (Skip — i.e. return early — if either is null/undefined.)
  // This mirrors the existing animate() logic (lines 375–387 of matrix-rain-webgpu.js).

  dispose(),
  // Disposes all RTTNodes and their GPU render targets created by this factory call:
  // afterBloomRtt, afterHeatRtt, rttPhosphor, afterSoftenRtt, rttPreHolo,
  // rttPreGodRays, and rttPreFxaa (the factory's outputNode — the RTT that FXAA
  // or the CRT node chain reads from). This last RTT is factory-owned; the factory
  // returns it as outputNode and is responsible for disposing it.
  // Call before discarding a rainNodes reference, e.g. on resize in the bridge.
  // Does NOT dispose prevRT or dummyRT — those are owned by the initMatrixRain closure.
  //
  // Note: the standalone animate() resize path (lines 367–373) must also be updated
  // to call dispose() on the old rainNodes (or equivalent per-RTT disposal) before
  // calling buildPP(). Currently only rttRT (phosphor RT) is disposed there, leaking
  // the other six RTTs. Task 1 covers this fix.
}
```

`rttPhosphor` is returned as a top-level field (not inside `passBuilders`)
because it is a render target node, not a pass-builder with exposed uniforms.

`postRender` must call `ensurePrevRT()` internally before the copy — this is
what allocates `prevRT` on the first frame. Callers do not call `ensurePrevRT`
separately.

The existing `buildPostProcessing(renderer, scene, camera, ...)` becomes a
thin wrapper: it calls `pass(scene, camera).getTextureNode('output')` to
produce `sceneColorNode`, passes it to `buildMatrixRainNodes`, assembles a
`THREE.RenderPipeline`, and returns the same `pp` object (with `_bloomNode`,
`_heatBuild`, etc. attached to `pp`) that the rest of the code already expects.
Zero behaviour change for standalone use.

Note: `pass(scene, camera)` alone returns a `PassNode`, not a texture/color
node. The `.getTextureNode('output')` call is required — omitting it causes a
type mismatch in bloom and the downstream passes.

The wrapper must **flatten** the `passBuilders` fields onto `pp` directly,
and store `rainNodes` in a closure variable for the resize-path dispose:

```js
// inside the standalone buildPostProcessing wrapper / buildPP():
let currentRainNodes = null;  // closure variable in initMatrixRain scope

function buildPP() {
  const sceneColorNode = pass(scene, camera).getTextureNode('output');
  currentRainNodes = buildMatrixRainNodes(sceneColorNode);
  const pp = new THREE.RenderPipeline(renderer);
  pp.outputNode    = fxaa(currentRainNodes.outputNode);
  pp._rttPhosphor  = currentRainNodes.rttPhosphor;
  pp._bloomNode    = currentRainNodes.passBuilders._bloomNode;
  pp._heatBuild    = currentRainNodes.passBuilders._heatBuild;
  pp._softenBuild  = currentRainNodes.passBuilders._softenBuild;
  pp._streakBuild  = currentRainNodes.passBuilders._streakBuild;
  pp._holoBuild    = currentRainNodes.passBuilders._holoBuild;
  pp._godRaysBuild = currentRainNodes.passBuilders._godRaysBuild;
  pp._bloomNode.threshold.value = bloomThreshold;
  return pp;
}
```

Without the flattening, `postProcessing._bloomNode` and all `_*Build` accesses
in the animate loop and handle methods would be `undefined`.

The standalone resize path in `animate()` must dispose `currentRainNodes`
before calling `buildPP()`:

```js
// inside animate() resize detection block:
currentRainNodes?.dispose();   // replaces the current rttRT-only dispose
postProcessing = buildPP();
```

This fixes the GPU render-target leak that existed before this refactor (only
`rttPhosphor.renderTarget` was disposed; the other six RTTs were orphaned).

**FXAA**: the standalone wrapper adds `fxaa(rttPreFxaa)` as `pp.outputNode`.
In node-factory mode `outputNode` is pre-FXAA. The bridge (§3) applies FXAA
once at the very end, after the CRT nodes.

**Note on `setGlobeInteract`**: the module header comment lists
`setGlobeInteract(on)` as a handle method, but it is absent from the handle
and `uGlobeInteract` does not exist in `makeUniforms()` or `matrix-rain-tsl.js`.
During the handle restructure required by this spec, Task 1 must:
1. Add `uGlobeInteract: uniform(1.0)` to `makeUniforms()` in `matrix-rain-tsl.js`.
2. Reference `uGlobeInteract` in the TSL shader to gate the globe proximity
   pulse effect (multiply the pulse contribution by `uGlobeInteract`).
3. Add the handle method:
   ```js
   setGlobeInteract(on) { uniforms.uGlobeInteract.value = on ? 1.0 : 0.0; },
   ```

**Note on `buildMatrixRainNodes` scope**: `buildMatrixRainNodes` must be
defined as an inner function (or closure expression) *inside* `initMatrixRain`.
It depends on `phosphorPrevTex`, `phosphorDecay`, `uAspect`, and `ensurePrevRT`
from the outer closure — these are not passed as parameters. Returning it as
`handle.buildNodes` in `externalLoop` mode gives the bridge access while keeping
those variables private.

### 1b. Expose `scene`, `camera`, `renderer` on the handle

Add read-only getters so the bridge can pass them to `buildCRTNodesFromSource`:

```js
handle = {
  // ... existing methods ...
  get scene()    { return scene; },
  get camera()   { return camera; },
  get renderer() { return renderer; },
};
```

### 1c. `tick(t)` frame-tick function

Extract all per-frame state mutations from `animate()` into `tick(t)`.
`tick` tracks its own `prevTs` internally (same pattern as `animate()`'s
existing `prevTs` variable) so callers do not need to supply `dt`:

```js
function tick(t) {
  const dt = prevTs > 0 ? t - prevTs : 1.0 / 60.0;
  prevTs = t;
  // ...burst bloom, uTime, camera sync, light azimuth...
}
```

The `t` argument is in **seconds** (i.e., `ts * 0.001` where `ts` is the
raw RAF millisecond timestamp). `animate()` continues to call `tick(t)` with
its existing seconds-domain `t` — no behaviour change. The bridge calls
`tick(ts * 0.001)` from its own RAF loop.

---

## 2. Changes to `telescreen-crt-webgpu.js`

### 2a. New export: `buildCRTNodesFromSource(renderer, sourceNode, opts)`

A new **exported** function that builds the CRT node chain starting from an
arbitrary TSL source node instead of from `pass(scn, cam)`. This is the only
public API addition to telescreen-crt.

Pre-condition: `sourceNode` must be a non-null TSL node. If null or undefined,
throw immediately: `throw new Error('buildCRTNodesFromSource: sourceNode is null')`.

```js
/**
 * Build the CRT post-processing node chain on top of an externally-provided
 * source node. Used by integration bridges where the scene has already been
 * rendered and post-processed by another library.
 *
 * Call only after renderer.init() has resolved.
 *
 * @param {THREE.WebGPURenderer} renderer   Initialised renderer
 * @param {object}               sourceNode TSL node — vec4 RGBA to apply CRT on top of
 * @param {object}               [opts]     Same opts as initTelescreenCRTWebGPU, except
 *                                          videoSource and autoRender are not applicable.
 * @returns {{
 *   outputNode: object,
 *   setShader(params): void,
 *   setGlitch(enabled, ...): void,
 *   setBloom(params): void,
 *   tick(ts): { skipRender: boolean, newOutputNode: object|null },
 *   postRender(renderer): void,
 *   setSourceNode(node): void,
 * }}
 */
export function buildCRTNodesFromSource(renderer, sourceNode, opts = {}) { ... }
```

Internally, `buildCRTNodesFromSource` calls a refactored
`_buildCRTNodeChain(sourceNode, renderer, srcW, srcH, usePrevTex)` which
extracts the body of the existing `buildPostProcessing` with its
`pass(scn, cam)` / `sceneOutput` preamble (lines 1057–1064 of
`telescreen-crt-webgpu.js`) replaced by the caller-provided `sourceNode`.

The existing `initTelescreenCRTWebGPU` remains unchanged: it calls the internal
`buildPostProcessing(rdr, scn, cam, ...)` which now delegates to
`_buildCRTNodeChain` after constructing
`sceneOutput = pass(scn, cam).getTextureNode('output')` (preserving the null
check and throw that guard it).

**No breaking changes to the existing API.**

### 2b. `tick(ts)` and `postRender(renderer)` returned from `buildCRTNodesFromSource`

`renderFrame` in `telescreen-crt-webgpu.js` does the following (all of which
must be split between `tick` and `postRender` in bridge mode):

**`tick(ts)` — call before `pp.render()` each frame:**

1. Guard: if `destroyed` or `deviceLost`, return `{ skipRender: true }`.
2. Initialise `startTime` on first call: `if (startTime === null) startTime = ts`.
3. Compute `t = (ts - startTime) / 1000`.
4. Compute `dt`; initialise `lastTs` on first call (fallback `1/60`).
5. Auto-compute `persistence` from `_persistenceTau` if set.
6. Wrap `uniforms.tWrapped.value = t % 3600`.
7. Run `updateGlitchScheduler(t)`, `updateRollbarPhase(t)`, `updateSagPhase(t)`.
8. Update `humPhase`, AGC oscillator, `frameCount`.
9. Advance tension wire shimmer phase.
10. Toggle `interlaceField`, update `_cpuState.interlaceDecay`.
11. Compute `outW/H`, `effectiveSrc`, `needsTwoPass`; sync `outputSizeX/Y`, `scrollPhase`.
12. Check all mode-transition flags (twoPass/srcChanged/usePrevTex/glassBlur/ghost/halo/
    dotCrawl/signal/feedback).
13. If any flag changed: call `disposeCurrentPP()`, set `_rebuildPending = true`,
    store `_rebuildArgs`, return `{ skipRender: true }`.
14. If `_rebuildPending`: rebuild pipeline from `_rebuildArgs` using the stored
    `sourceNode`, clear flag, return `{ skipRender: true }`.
15. Sync `kernelSrcW/H`, `sourceSizeX/Y`. Update mask energy compensation.
16. Return `{ skipRender: false }`.

**`postRender(renderer)` — call after `pp.render()` each frame:**

1. Call `ensurePersistenceTargets()`.
2. Copy `pp._rttBlend.renderTarget.texture → prevRT.texture` when the
   guard passes:
   ```js
   if (postProcessing._rttBlend !== null &&
       (uniforms.persistence.value > 0.001 || uniforms.interlace.value > 0.5)) {
     ensurePersistenceTargets();
     renderer.copyTextureToTexture(postProcessing._rttBlend.renderTarget.texture, prevRT.texture);
   }
   ```
   `pp._rttBlend` is the CRT persistence RTTNode (line 1432 of
   `telescreen-crt-webgpu.js`). It is `null` when `usePrevTex = false`.
3. Call `ensureFeedbackTarget()` and copy `feedbackRT` when `_lastFeedbackActive`.

**Regarding pipeline rebuild in bridge mode (Issue 6 detail):**
When `tick` returns `{ skipRender: true }` due to `_rebuildPending`, the
bridge must skip `pp.render()` that frame and update its `pp.outputNode` the
following frame when `tick` returns a fresh `outputNode`. Therefore `tick`'s
return value should include the new node when a rebuild just completed:

```js
// tick return when rebuild just completed:
{ skipRender: true, newOutputNode: newCrtOutputNode }
// tick return otherwise:
{ skipRender: false, newOutputNode: null }
```

The bridge checks `result.newOutputNode` and, when non-null, sets
`pp.outputNode = fxaa(result.newOutputNode)`. Setting `pp.outputNode` on a
live `THREE.RenderPipeline` is supported: the pipeline recompiles on the next
render call. This matches how matrix-rain's own `buildPP()` works (it assigns
a new outputNode after resize-triggered rebuild).

---

## 3. New file: `matrix-rain-crt-bridge.js`

Lives in `matrix-rain-webgpu/`. Depends on both sibling libraries.

All TSL node construction and pipeline assembly happen inside
`renderer.init().then()` — the renderer must be fully initialised before any
`pass()`, `rtt()`, or `THREE.RenderPipeline` call.

```js
import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { initMatrixRain }
  from './matrix-rain-webgpu.js';
import { buildCRTNodesFromSource }
  from '../telescreen-crt-webgpu/telescreen-crt-webgpu.js';

export function initMatrixRainCRT(element, rainOpts = {}, crtOpts = {}) {
  const rain = initMatrixRain(element, { ...rainOpts, externalLoop: true });

  // Bridge owns the renderer; CRT requires LinearSRGBColorSpace.
  // Must be set before buildCRTNodesFromSource is called.
  rain.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

  let rainNodes = null;
  let crt       = null;
  let pp        = null;
  let rafId     = 0;
  let rendering = false;   // re-entry guard

  // ResizeObserver is declared here (outer scope) so destroy() can call ro.disconnect().
  // It is set up after pp is ready (see §4 block below — insert it after the init().then() call).
  let ro;

  rain.renderer.init().then(() => {
    // Build rain node chain
    const sceneColor = pass(rain.scene, rain.camera).getTextureNode('output');
    rainNodes = rain.buildNodes(sceneColor);

    // Build CRT node chain on top
    crt = buildCRTNodesFromSource(rain.renderer, rainNodes.outputNode, crtOpts);

    // Assemble single PostProcessing
    pp = new THREE.RenderPipeline(rain.renderer);
    pp.outputNode = fxaa(crt.outputNode);

    // Attach bridge ResizeObserver (full block shown in §4)
    ro = new ResizeObserver(() => { /* see §4 */ });
    ro.observe(element);

    rafId = requestAnimationFrame(animate);
  });

  async function animate(ts) {
    rafId = requestAnimationFrame(animate);
    if (!pp || rendering) return;
    rendering = true;
    try {
      rain.tick(ts * 0.001);          // seconds-domain t; tick tracks prevTs internally

      const crtResult = crt.tick(ts);  // millisecond RAF timestamp, matching renderFrame(ts)

      // Handle CRT pipeline rebuild (deferred dispose + one-frame skip)
      if (crtResult.skipRender) {
        if (crtResult.newOutputNode) {
          pp.outputNode = fxaa(crtResult.newOutputNode);
        }
        return;
      }

      await pp.render();

      rainNodes.postRender(rain.renderer);
      crt.postRender(rain.renderer);
    } finally {
      rendering = false;
    }
  }

  return {
    rain,
    crt,
    destroy() {
      cancelAnimationFrame(rafId);
      ro?.disconnect();        // bridge's ResizeObserver (may be null if destroyed before init resolves)
      rainNodes?.dispose();    // release rain RTTNode render targets
      rain.destroy();          // disposes renderer, geometry, textures
      pp?.dispose?.();         // bridge owns PostProcessing; rain.destroy() does not
    },
  };
}
```

**Note on timestamp conventions:** `rain.tick(t)` takes `t` in **seconds** (convert
with `ts * 0.001`). `crt.tick(ts)` takes the raw RAF millisecond timestamp,
matching the existing `renderFrame(ts)` signature. `tick` implementations
track their own `prevTs` internally; callers do not supply `dt`.

**Note on `renderer.init()` idempotency:** `initMatrixRain(..., { externalLoop: true })`
calls `renderer.init()` internally. The bridge then calls `rain.renderer.init()`
again. `THREE.WebGPURenderer.init()` is idempotent — subsequent calls return
the already-resolved promise without re-initialising. Both calls are safe.

---

## 4. Resize handling

The `externalLoop: true` mode **suppresses matrix-rain's internal
`ResizeObserver`** (§5). The bridge attaches its own `ResizeObserver` to the
host element:

```js
const ro = new ResizeObserver(() => {
  if (!pp) return;
  const w = element.clientWidth  || 1;
  const h = element.clientHeight || 1;
  rain.renderer.setSize(w, h);
  rain.camera.aspect = w / h;
  rain.camera.updateProjectionMatrix();
  rain.onResize(w, h);   // sets uAspect.value = w / h (the only dimension-dependent uniform)
  rebuildPP();
});
ro.observe(element);
```

`rebuildPP()` tears down and reconstructs both node chains:

```js
function rebuildPP() {
  rainNodes?.dispose();   // release old RTTNode render targets before rebuilding
  const sceneColor = pass(rain.scene, rain.camera).getTextureNode('output');
  rainNodes = rain.buildNodes(sceneColor);
  // Re-create CRT chain — crt.tick() detects mode transitions internally
  // and handles its own deferred rebuild. After the resize, the next
  // crt.tick() call will trigger a CRT pipeline rebuild automatically
  // (outW/H changed → mode transition detected). The bridge only needs
  // to rebuild the rain nodes and update the CRT's sourceNode.
  crt.setSourceNode(rainNodes.outputNode);
  // pp.outputNode remains valid; crt.tick() will return newOutputNode
  // when its internal rebuild completes.
}
```

`crt.setSourceNode(node)` must do two things atomically:

1. Store the new source node in a primary `_sourceNode` field (always updated,
   unconditionally). This field is the canonical source for all future
   `_buildCRTNodeChain` calls — every rebuild path reads `_sourceNode`, not
   `_rebuildArgs.sourceNode`. (If `_rebuildArgs` exists and is non-null, update
   `_rebuildArgs.sourceNode` as well to keep them in sync, but `_sourceNode`
   is authoritative.) This design means `setSourceNode` is safe to call at any
   time, including before the first CRT rebuild — `_rebuildArgs` may be null and
   that is fine.
2. Set `_rebuildPending = true` (if not already set) to schedule a rebuild on
   the next `tick()`. This is necessary because the resize that changed `w/h`
   is itself a mode-transition trigger — without scheduling a rebuild, the CRT
   would continue rendering with stale `outW/H` dimensions for one extra frame.

If `_rebuildPending` is already `true` from the previous `tick()` (i.e., a
rebuild is already in flight), `setSourceNode` only needs to update `_sourceNode`;
the in-flight rebuild will use the updated value when it executes.

This must be added alongside `buildCRTNodesFromSource` (Task 3).

The bridge `destroy()` must also call `ro.disconnect()`.

**Why not suppress the CRT's internal rebuild too?** The CRT's rebuild is
triggered by mode transitions (two-pass ↔ single-pass, glass blur on/off, etc.)
that can happen independently of window resize. Suppressing it entirely would
require the bridge to replicate all of the CRT's rebuild-condition logic.
Instead, the CRT's internal rebuild runs as before — `tick` returns
`{ skipRender: true, newOutputNode }` when a rebuild occurs, and the bridge
updates `pp.outputNode` accordingly (§2b).

---

## 5. `externalLoop` init option for matrix-rain

When `externalLoop: true` is passed to `initMatrixRain`:

- Do **not** call `requestAnimationFrame` internally. `s.animRef.id` stays 0.
  `destroy()` will call `cancelAnimationFrame(0)` — this is a no-op and intentional.
- Do **not** create a `THREE.RenderPipeline` internally. `buildPP()` is not called.
- `renderer.init().then(...)` still runs to initialise the WebGPU context, but
  its callback only calls the `preset` init option if provided — no RAF, no PP.
- Suppress the internal `ResizeObserver` (`ro.observe(element)` is skipped).
  Resize is owned entirely by the bridge. `destroy()` therefore has no internal
  `ro` to disconnect — this is intentional, not a leak.
- Return three additional methods on the handle:
  - `buildNodes(sceneColorNode)` — node factory (§1a). May only be called after
    `renderer.init()` has resolved.
  - `tick(t)` — frame tick, `t` in seconds (§1c).
  - `onResize(w, h)` — sets `uAspect.value = w / h` (`uAspect` is the only
    dimension-dependent uniform in the rain chain; there are no others). The
    bridge calls this before `rebuildPP()` whenever the host element resizes.
    Implemented in Task 1 (alongside the other `externalLoop` handle additions).

`destroy()` still disposes renderer, geometry, textures, `dummyRT`. It does
**not** dispose `postProcessing` (since none was created). The bridge calls
`pp.dispose?.()` separately.

The existing code path (`externalLoop` absent or false) is identical to today.

---

## 6. FXAA placement

In standalone matrix-rain: `pp.outputNode = fxaa(rttPreFxaa)`. FXAA is last.

In the bridge: both `outputNode` values are pre-FXAA. The bridge adds FXAA
once: `pp.outputNode = fxaa(crt.outputNode)`. This avoids running FXAA twice.

---

## 7. Color space

telescreen-crt requires `renderer.outputColorSpace = THREE.LinearSRGBColorSpace`
before any CRT node construction. Without it, the pipeline double-encodes:
CRT's `buildGammaNode` applies γ=2.5, then Three.js applies sRGB (γ≈2.2),
yielding a net γ≈0.4 on the display.

The bridge sets this immediately after `initMatrixRain`:
```js
rain.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
```

Visual effect: matrix-rain's colours appear slightly brighter/more saturated
in bridge mode than in standalone mode (no sRGB correction applied to the rain
chain). The CRT's gamma node re-encodes to CRT γ=2.5 at the end. Rain presets
tuned for standalone use may need slight retuning for the CRT stack.

---

## 8. Preset interplay

matrix-rain presets (in `matrix-rain-presets.js`) tune the rain PP stack.
CRT presets (`PRESETS` and `SIGNAL_PRESETS` exported from
`../telescreen-crt-webgpu/crt-presets.js`) tune the display simulation.
They are orthogonal and applied independently.

The demo imports both:
```js
import { PRESETS as RAIN_PRESETS } from './matrix-rain-presets.js';
import { PRESETS as CRT_PRESETS, SIGNAL_PRESETS }
  from '../telescreen-crt-webgpu/crt-presets.js';
```

Useful pairings (to explore in the demo):
- `matrix1999` rain + `trinitron` CRT + `offAirNtsc` signal — closest to authentic
- `ghost` rain + `shadow_mask` CRT — dim P39/P7 oscilloscope look
- `overdrive` rain + `aperture_grille` CRT + `broadcast` signal — maximum intensity

---

## 9. Demo (`demo-crt.html`, new file)

A second demo page alongside `demo.html` that uses `matrix-rain-crt-bridge.js`.
Controls panel has two sections: **Rain** (mirror of existing `demo.html`
controls) and **CRT** (key CRT params: warp, halation, scanline hardness,
mask type, phosphor persistence, convergence). A preset row at the top allows
stacking rain and CRT presets independently.

Import CRT presets from `../telescreen-crt-webgpu/crt-presets.js` (not from
`telescreen-crt-webgpu.js`).

Defer `telescreen-controls-webgpu.js` full integration — manual bindings for
a curated subset of CRT params are sufficient for the demo.

---

## Tasks

1. **matrix-rain: `externalLoop` opt + `buildNodes` + `tick` + `onResize`** —
   internal refactor. `initMatrixRain` wraps the new internals. Zero behaviour
   change when `externalLoop` is absent. Includes:
   - `externalLoop: true` suppresses internal RAF, PP build, and `ResizeObserver`.
   - `buildNodes(sceneColorNode)` — node factory (§1a), defined as an inner
     function inside `initMatrixRain` to close over `phosphorPrevTex`,
     `phosphorDecay`, `uAspect`, and `ensurePrevRT`.
   - `tick(t)` — frame tick in seconds (§1c).
   - `onResize(w, h)` — sets `uAspect.value = w / h`.
   - Fix `setGlobeInteract(on)`: add `uGlobeInteract: uniform(1.0)` to
     `makeUniforms()` in `matrix-rain-tsl.js`, wire it in the shader, and add
     the handle method. *(Also modifies `matrix-rain-tsl.js`.)*
   - Fix standalone resize leak: introduce `let currentRainNodes` closure
     variable; update `buildPP()` to set `currentRainNodes = buildMatrixRainNodes(...)`;
     update `animate()` resize path to call `currentRainNodes?.dispose()` before
     `buildPP()` (currently only `rttPhosphor.renderTarget` is disposed; the
     other six RTTs are leaked).
   *(No dependencies.)*

2. **matrix-rain: expose `scene`, `camera`, `renderer` getters on handle** —
   additive. *(Depends on Task 1 for the handle restructure.)*

3. **telescreen-crt: `buildCRTNodesFromSource` + `setSourceNode` exports** —
   extract `_buildCRTNodeChain` from `buildPostProcessing`; expose two new
   exports. `tick` returns `{ skipRender, newOutputNode }`. `postRender` uses
   `_rttBlend` guard logic from lines 1980–1986 of `telescreen-crt-webgpu.js`.
   Existing `initTelescreenCRTWebGPU` unchanged.
   *(No dependencies on matrix-rain tasks.)*

4. **`matrix-rain-crt-bridge.js`** — glue module as specified in §3–§4.
   Owns RAF loop, ResizeObserver, re-entry guard, CRT rebuild detection,
   `outputColorSpace` setup, `pp.dispose()` on destroy.
   *(Depends on Tasks 1–3.)*

5. **`demo-crt.html`** — standalone demo using the bridge; dual controls
   panel; rain + CRT preset stacking; imports `crt-presets.js` from sibling
   directory. *(Depends on Task 4.)*

---

## Out of Scope

- Animated crossfade between rain presets through the CRT
- `telescreen-controls-webgpu.js` full integration into the demo
- CRT effect applied to a video source through the bridge
  (use `initTelescreenCRTWebGPU` with `videoSource` directly for that)
- WebGL2 fallback path (bridge is WebGPU-only)
- A combined preset format specifying both rain and CRT values in one object
- `prefers-reduced-motion` handling in the bridge
  (each library handles it internally)
