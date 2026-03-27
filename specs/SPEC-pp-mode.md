# SPEC-pp-mode — Post-processing mode selector for `initMatrixRain`

**Status**: Implemented
**Priority**: P1

---

## Motivation

Two separate entry points currently exist for the 3D rain:

| Entry point | Post-processing | Usage |
|---|---|---|
| `initMatrixRain(el, opts)` | 7-stage rain pipeline (bloom → heat → phosphor → soften → streaks → holo → god rays → FXAA) | `demo.html` |
| `initMatrixRainCRT(el, rainOpts, crtOpts)` | CRT bridge (rain node chain → `buildCRTNodesFromSource` → FXAA) | `demo-crt.html` |

Callers must know at import time which mode they want, and the two APIs return differently-shaped handles (`handle` vs `{ rain, crt, destroy }`). Switching modes requires rewriting the call site.

This spec adds `postProcessing: 'rain' | 'crt' | 'none'` to `initMatrixRain`, making mode selection a single option. The bridge (`matrix-rain-crt-bridge.js`) becomes a thin backward-compat shim. The returned handle shape is unified across all three modes.

---

## Files

| File | Change |
|---|---|
| `matrix-rain-webgpu.js` | Add `postProcessing` + `crtOpts` opts; rename internal pipeline variable; branch pipeline construction; extend `animate()`; guard PP-specific handle methods; expose `handle.crt` |
| `matrix-rain-crt-bridge.js` | Replace body with backward-compat shim |
| `demo.html` | Add PP-mode dropdown; show/hide CRT-specific controls |

No new files. No changes to `matrix-rain-passes-tsl.js`, `matrix-rain-tsl.js`, or any 2D module.

---

## API Changes

### `initMatrixRain(element, opts)`

Two new opts:

| Option | Type | Default | Description |
|---|---|---|---|
| `postProcessing` | `'rain' \| 'crt' \| 'none'` | `'rain'` | Pipeline mode selected at init time |
| `crtOpts` | `object` | `{}` | Options forwarded to `buildCRTNodesFromSource`; ignored unless `postProcessing: 'crt'` |

All existing opts (`color`, `opacity`, `charSet`, `preset`, `externalLoop`, …) are unchanged.

### Handle — `handle.crt`

When `postProcessing: 'crt'`, the handle exposes `handle.crt` — the CRT handle returned by `buildCRTNodesFromSource` (with `setShader`, `setGlitch`, `setBloom`, etc.).

**Timing**: `initMatrixRain` returns synchronously before `renderer.init()` resolves, so `handle.crt` is `null` at return time and becomes the live CRT handle only after async init finishes. Implement as a getter backed by a closure variable:

```js
let crtHandle = null;
// In handle definition:
get crt() { return crtHandle; }
// After buildCRTNodesFromSource resolves:
crtHandle = buildCRTNodesFromSource(renderer, pp_rainNodes.outputNode, crtOpts);
```

Callers that need to act immediately on `handle.crt` should poll or wait for a known async checkpoint (e.g. their own `renderer.init()` promise when using `externalLoop: true`). When `postProcessing` is `'rain'` or `'none'`, `handle.crt` returns `null` always.

### Handle — PP-specific methods in non-`'rain'` modes

The methods `setHeat`, `setSoften`, `setStreaks`, `setHoloAberration`, `setGodRays`, `setBurstBloom`, `setPhosphorDecay`, `setBloomThreshold`, `setBloomStrength` must no-op silently in `'crt'` and `'none'` modes rather than throw.

**Guard on the mode string, not on `pp._x`.** The existing implementation uses a dual-access pattern `pp?._heatBuild ?? currentRainNodes?.passBuilders?._heatBuild`. Do NOT replace this with `if (!pp?._heatBuild) return` — that breaks `externalLoop: true` + `'rain'` mode where `pp` is null but `currentRainNodes` is live (set by `handle.buildNodes()`). The correct guard is:

```js
// Canonical guard — apply to every PP-pass method that accesses a pass builder:
setHeat(on, amt) {
  if (postProcessing !== 'rain') return;   // postProcessing is the opt string
  const b = pp?._heatBuild ?? currentRainNodes?.passBuilders?._heatBuild;
  if (!b) return;
  b.uHeatAmt.value = on ? (amt ?? 0.004) : 0;
},
```

For the two methods that don't access a pass builder object:

```js
// setPhosphorDecay writes a bare uniform; setPhosphorDecay and setBurstBloom
// work via mode guard only:
setPhosphorDecay(v) {
  if (postProcessing !== 'rain') return;
  phosphorDecay.value = v;
},
setBurstBloom(on) {
  if (postProcessing !== 'rain') return;
  burstBloomActive = on;
},
```

`setBloomThreshold` and `setBloomStrength` access `_bloomNode` not a `_xBuild` — keep their existing dual-access pattern but add the mode guard at the top:

```js
setBloomThreshold(v) {
  if (postProcessing !== 'rain') return;
  bloomThreshold = v;
  if (pp?._bloomNode) pp._bloomNode.threshold.value = v;
  if (currentRainNodes?.passBuilders?._bloomNode)
    currentRainNodes.passBuilders._bloomNode.threshold.value = v;
},
```

The affected methods are: `setHeat`, `setSoften`, `setStreaks`, `setHoloAberration`, `setGodRays`, `setBurstBloom`, `setPhosphorDecay`, `setBloomThreshold`, `setBloomStrength`. All other methods (`setColor`, `setOpacity`, `setDepth`, `setCharSet`, `setSpeed`, `applyPreset`, `buildNodes`, `tick`, `onResize`, `destroy`, …) are unchanged across all modes.

### CRT mode — what feeds into CRT

In `'crt'` mode, `buildNodesInternal(sceneColor)` builds the **full 7-stage rain chain** (bloom → heat → phosphor → soften → streaks → holo → god rays). The output of that chain is then passed as source to `buildCRTNodesFromSource`. This matches the existing bridge behaviour and is intentional: rain post-processing provides phosphor smear, bloom, and lens effects; CRT adds scanlines, curvature, glitch, and gamma. Use `crtOpts` to control what the CRT applies on top.

---

## Internal Design

### Step 0 — Rename the internal pipeline variable

The current code uses `let postProcessing = null` for the `THREE.RenderPipeline` object, which would shadow the new `postProcessing` option string. Rename it to `let pp = null` throughout `matrix-rain-webgpu.js` before making any other changes. `buildPP()` already returns what gets stored in this variable; consolidate to `pp` everywhere.

### CRT dependency — dynamic import

To avoid pulling in `telescreen-crt-webgpu.js` when CRT mode is not requested:

```js
// Inside renderer.init().then() callback, only when postProcessing === 'crt'
const { buildCRTNodesFromSource } = await import('../telescreen-crt-webgpu/telescreen-crt-webgpu.js');
```

If the import fails (404 or parse error), the error is caught and logged — it must not become an unhandled rejection since `renderer.init().then(async () => {...})` swallows rejections from the async callback (the returned inner Promise is not `.catch()`-ed). Wrap the entire `async` callback body in try/catch:

```js
renderer.init().then(async () => {
  try {
    // ... all init logic ...
  } catch (err) {
    console.error('[matrix-rain] init failed:', err);
  }
  // Guards below run even on error so RAF + ResizeObserver don't start:
  // (put ro.observe / animRef.id inside the try block)
});
```

### Pipeline construction — three branches

Add `let pp_rainNodes = null` and `let crtHandle = null` to the closure (alongside the existing `let pp = null`).

```js
renderer.init().then(async () => {
  try {
    switch (postProcessing) {

      case 'rain':
        pp = buildPP();                        // unchanged
        break;

      case 'crt': {
        const { buildCRTNodesFromSource } =
          await import('../telescreen-crt-webgpu/telescreen-crt-webgpu.js');
        const sceneColor = pass(scene, camera).getTextureNode('output');
        pp_rainNodes = buildNodesInternal(sceneColor);   // full rain chain
        crtHandle    = buildCRTNodesFromSource(renderer, pp_rainNodes.outputNode, crtOpts);
        pp           = new THREE.RenderPipeline(renderer);
        pp.outputNode = fxaa(rtt(crtHandle.outputNode));
        break;
      }

      case 'none': {
        pp = new THREE.RenderPipeline(renderer);
        pp.outputNode = fxaa(pass(scene, camera).getTextureNode('output'));
        break;
      }
    }

    if (!externalLoop) ro.observe(element);    // preserve existing externalLoop guard
    if (preset) handle?.applyPreset(preset);
    if (!externalLoop) animRef.id = requestAnimationFrame(animate);
  } catch (err) {
    console.error('[matrix-rain] init failed:', err);
  }
});
```

### `animate()` — per-mode tick additions

```js
async function animate(ts) {
  animRef.id = requestAnimationFrame(animate);
  tick(ts * 0.001);   // existing call — unchanged

  if (!pp) return;

  // ... existing 'rain' RTT resize check (pp._rttPhosphor) ...
  // ... CRT RTT resize check — see RTT resize section below ...

  // CRT mode: drive CRT tick and handle its rebuild signal
  if (postProcessing === 'crt' && crtHandle) {
    const signal = crtHandle.tick(ts);
    if (signal?.rebuild) {
      pp.outputNode = fxaa(rtt(crtHandle.outputNode));
    }
  }

  ensurePrevRT();   // existing call — needed for phosphor in rain and crt modes

  try {
    await pp.render();   // matches existing API name (postProcessing.render())
    firstRenderDone = true;

    // Phosphor feedback copy — rain and crt both have the rain node chain
    if (postProcessing === 'rain') currentRainNodes?.postRender(renderer);
    if (postProcessing === 'crt')  pp_rainNodes?.postRender(renderer);

    // CRT postRender (optional hook — present in current bridge, keep for compat)
    if (postProcessing === 'crt')  crtHandle?.postRender?.(renderer);
  } catch (e) {
    console.warn('matrix-rain-webgpu: render threw:', e);
  }
}
```

Note: `ensurePrevRT()` is needed in both `'rain'` and `'crt'` modes because the rain node chain (present in both) uses the phosphor RT. In `'none'` mode it is harmless.

### RTT resize detection — per mode

The existing resize detection runs inside `animate()` and checks whether the phosphor RTT has been resized. Each mode has a distinct path:

**`'rain'` mode** — unchanged. The existing `pp._rttPhosphor?.renderTarget` size-mismatch check triggers `pp = buildPP()` as before.

**`'crt'` mode** — `pp._rttPhosphor` is absent; guard against it. Add a sibling check on `pp_rainNodes`:

```js
// In animate(), before renderAsync() — insert after the existing 'rain' resize check:
if (postProcessing === 'crt' && firstRenderDone && crtHandle) {
  const rdrW = renderer.domElement.width;
  const rdrH = renderer.domElement.height;
  const rttRT = pp_rainNodes?.rttPhosphor?.renderTarget;
  if (rttRT && (rttRT.width !== rdrW || rttRT.height !== rdrH)) {
    pp_rainNodes.dispose();
    const sceneColor = pass(scene, camera).getTextureNode('output');
    pp_rainNodes = buildNodesInternal(sceneColor);
    crtHandle.setSourceNode(pp_rainNodes.outputNode);
    // CRT emits signal.rebuild on next tick; animate() then swaps pp.outputNode
    firstRenderDone = false;
    return;
  }
}
```

**`'none'` mode** — `pass(scene, camera)` re-evaluates against the live renderer size every frame; no RTT exists to check, no resize detection needed. `renderer.setSize()` in `onResize()` is sufficient.

### `externalLoop: true` + `'crt'` mode

When `externalLoop: true` and `postProcessing: 'crt'`, callers drive the entire loop. They must:

1. Await `renderer.init()` themselves
2. Call `handle.buildNodes(sceneColor)` to get rain nodes
3. Retrieve `handle.crt` (available after step 1 completes) and call `handle.crt.setSourceNode(rainNodes.outputNode)` when resizing
4. Drive `handle.crt.tick(ts)` each frame and handle `signal.rebuild`

This is identical to the current bridge's `rebuildPP()` responsibility. No new mechanism needed; callers know `handle.crt` is populated after `renderer.init()` resolves because they drove `renderer.init()` themselves.

---

## `matrix-rain-crt-bridge.js` — shim

Replace the entire file body with:

```js
/**
 * matrix-rain-crt-bridge.js — backward-compat shim.
 * New code should use initMatrixRain({ postProcessing: 'crt' }) directly.
 */
import { initMatrixRain } from './matrix-rain-webgpu.js';

export function initMatrixRainCRT(element, rainOpts = {}, crtOpts = {}) {
  const handle = initMatrixRain(element, { ...rainOpts, postProcessing: 'crt', crtOpts });

  // Backward-compat: bridge callers access bridge.rain.setColor(), bridge.crt, bridge.destroy().
  // Expose 'rain' as an alias for the handle itself so existing call sites need no changes.
  handle.rain = handle;

  return handle;
}
```

`handle.rain = handle` is a self-reference, not a getter, because `initMatrixRain` returns synchronously and `handle.crt` (the CRT handle) is already exposed as a getter on the returned object. Existing callers can use `bridge.rain.setColor()`, `bridge.crt`, and `bridge.destroy()` unchanged. `demo-crt.html` requires no changes.

---

## `demo.html` — PP mode dropdown

Add a "Post-processing" dropdown as the first control (above Preset):

```html
<label>Post-processing
  <select id="ctl-ppmode">
    <option value="rain" selected>rain</option>
    <option value="crt">crt</option>
    <option value="none">none (diagnostic)</option>
  </select>
</label>
```

**Mode switch**: On change, capture the current `charSet` option from the charset dropdown, call `rain.destroy()`, re-init with `initMatrixRain(host, { charSet: currentCharSet, postProcessing: newMode })`. All other parameters reset to defaults — this is acceptable since `'none'` is a diagnostic mode and `'crt'` has its own defaults. Document this in a comment in the script.

**CRT-specific controls**: Show a minimal CRT sub-panel (initially hidden) containing at least `setShader` dropdown. Toggle visibility when mode is `'crt'`. Wire controls through `rain.crt` using the same `withCrt`-style deferred access: `rain.crt?.setShader(v)` is safe since `rain.crt` returns `null` before init completes and the control isn't visible in non-CRT mode.

**`'none'` mode label**: The `(diagnostic)` suffix in the option text signals that this mode disables bloom — glyphs render without glow, which looks visually harsh and is unsuitable as a final aesthetic. It is intended for compositing the raw scene output or debugging the glyph material.

---

## Tasks

Tasks are listed in dependency order:

1. **Rename `let postProcessing` → `let pp`** throughout `matrix-rain-webgpu.js`. This is a prerequisite for all subsequent tasks and must be done first to avoid the name collision.

2. **Add `postProcessing` + `crtOpts` opts destructuring** with defaults `'rain'` and `{}`.

3. **Add closure vars** `let pp_rainNodes = null` and `let crtHandle = null`.

4. **Add PP-pass method guards** to all affected handle methods: `setHeat`, `setSoften`, `setStreaks`, `setHoloAberration`, `setGodRays`, `setBurstBloom`, `setPhosphorDecay`, `setBloomThreshold`, `setBloomStrength`. Guard pattern: `if (postProcessing !== 'rain') return;` added at the top of each method. Preserve the existing `pp?._x ?? currentRainNodes?.passBuilders?._x` dual-access fallback — do not replace it with direct `pp._x` access (required for `externalLoop: true` + `'rain'` mode). See the guard examples in the API Changes section above.

5. **Branch `renderer.init().then()`** into the three cases with try/catch wrapper. Preserve the `!externalLoop` guard on `ro.observe` and `animRef`.

6. **Extend `animate()`** with per-mode CRT tick + rebuild signal, mode-aware phosphor postRender, and CRT postRender hook.

7. **Extend RTT resize detection** in `animate()` with `'crt'` mode branch; confirm `'none'` mode requires no detection.

8. **Expose `handle.crt` getter** backed by the `crtHandle` closure var. JSDoc note: *"Returns the CRT handle after renderer.init() resolves; null before that and in non-CRT modes."*

9. **Update `destroyMatrixRain`** to dispose CRT-mode resources: after the existing teardown calls, add `currentRainNodes?.dispose()` and `crtHandle?.destroy?.()`. `currentRainNodes?.dispose()` frees all RTT render targets for both 'rain' and 'crt' modes; it is safe to call unconditionally since it is null in 'none' mode.

10. **Replace `matrix-rain-crt-bridge.js`** with the shim including `handle.rain = handle`.

11. **Update `demo.html`** with PP mode dropdown, mode-switch logic (preserving charSet only), and conditional CRT sub-panel.

12. **Manual test**: all three modes render correctly at startup; PP-pass methods no-op without throwing in `'crt'`/`'none'` modes; in `externalLoop: true` + `'rain'` mode, PP-pass methods write through after `handle.buildNodes()` is called; resize works in all modes; `demo-crt.html` works unchanged via the shim; `demo.html` PP dropdown switches modes cleanly.

---

## Out of Scope

- Hot-swap at runtime (mode change without destroy/reinit)
- Hybrid/stacked mode (rain passes AND CRT in series)
- `init2DRain` — the 2D component already handles CRT compositing via `headless` + `getOutputNode()`
- `demo-crt.html` updates — the `handle.rain = handle` shim preserves its call sites unchanged
