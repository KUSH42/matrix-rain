# SPEC-webgl-fallback

**Status**: Implemented
**Priority**: P1 — enables the library in browsers without WebGPU support

---

## Motivation

`matrix-rain-webgpu.js` creates `new THREE.WebGPURenderer()` and proceeds without
checking which backend was selected. Three.js will silently fall back to its WebGL2
backend when the browser lacks WebGPU support (Firefox without WebGPU enabled, older
Safari, Chrome with GPU disabled), but one known issue prevents the TSL shader graph
from compiling on the WebGL2 backend:

**TextureNode sampler name collision** — `TextureNode.generate(builder, 'sampler2D')`
appends `_sampler` to the uniform name because it detects the `sampler` prefix. On
WebGPU, texture and sampler are separate bindings so `name_sampler` is a valid
identifier. On WebGL2, GLSL declares a single `uniform sampler2D name`; referencing
`name_sampler` is undefined and the shader fails to compile.

Because the codebase uses only TSL `Fn()` (no `wgslFn` / `glslFn` dual
implementations), no shader rewrite is required; the TSL GLSL transpiler handles the
entire glyph material and all six post-processing passes. The work is:

- apply the TextureNode sampler patch (ported from `telescreen-crt-webgpu`)
- detect the active backend after `renderer.init()` resolves
- dispatch a `'matrixrain:ready'` event so demo UIs can show a backend badge
- expose `handle.backend` as a readable string on the control handle

---

## Problem Analysis

### TextureNode sampler issue (root cause)

`TextureNode.generate()` tests `/^sampler/.test(output)` — if the requested output
type starts with `sampler`, it appends `_sampler` to the generated name. On the
WebGPU backend this is correct (separate binding). On the WebGL2 backend the GLSL
transpiler declares only `uniform sampler2D name`; referencing `name_sampler` is
undefined and compilation fails.

**Fix (ported from `telescreen-crt-webgpu`, applied once at module evaluation):**

```js
// ── WebGL2 TextureNode sampler fix (Three.js r183) ───────────────────────
// On WebGL2, TextureNode.generate('sampler2D') appends '_sampler' to the
// uniform name; WebGL2 GLSL has no separate sampler binding.
// Redirecting to 'property' returns the bare name, which is correct.
{
  const _orig = THREE.TextureNode.prototype.generate;
  THREE.TextureNode.prototype.generate = function _patchedGenerate(builder, output) {
    if (/^sampler/.test(output) && builder.renderer?.backend?.isWebGPUBackend !== true) {
      return _orig.call(this, builder, 'property');
    }
    return _orig.call(this, builder, output);
  };
}
```

**Import path note**: `THREE` in `matrix-rain-webgpu.js` is imported from
`'three/webgpu'`. Verify `THREE.TextureNode` is accessible via that entry point at
the start of implementation. If it is not, import `TextureNode` directly:
`import { TextureNode } from 'three/tsl'` and reference `TextureNode.prototype.generate`.

This patch is applied once at module evaluation time. ES modules are singletons so
repeated imports do not chain the wrapper.

### `copyTextureToTexture` on WebGL2

The phosphor pass calls:

```js
rdr.copyTextureToTexture(rttPhosphor.renderTarget.texture, prevRT.texture);
```

Three.js `WebGL2Backend` provides the same `copyTextureToTexture` API surface as the
WebGPU backend. This is confirmed to work by the `telescreen-crt-webgpu` project,
which uses the same pattern on WebGL2.

No change required.

### `HalfFloatType` render targets on WebGL2

`HalfFloatType` render targets require the `EXT_color_buffer_float` WebGL2 extension,
which is widely supported but not guaranteed. Three.js probes for this internally and
exposes `HalfFloatType` on both backends; no change to render target creation is
required.

### TSL constructs used by matrix-rain

| Construct | GLSL ES 3.0 transpilation | Status |
|-----------|--------------------------|--------|
| `Fn()` node builder | → plain GLSL function | ✓ supported |
| `Loop()` / `Break()` | → `for` loop with `break` | ✓ supported |
| `If()` / `Return()` | → `if` / `return` | ✓ supported |
| `varying()` | → `in`/`out` qualifiers | ✓ supported |
| `texture(node, uv)` | → `texture(sampler2D, vec2)` | ✓ (after patch) |
| `storageTexture` / compute | not used | n/a |

No dual WGSL / GLSL shader implementations are needed.

---

## Implementation

### 1. TextureNode sampler patch — `matrix-rain-webgpu.js`

Apply the patch in the module preamble, immediately after the import block. It must
run before any renderer or material is created:

```js
// ── WebGL2 TextureNode sampler fix (Three.js r183) ───────────────────────
// On WebGL2, TextureNode.generate('sampler2D') appends '_sampler' to the
// uniform name; WebGL2 GLSL has no separate sampler binding.
// Redirecting to 'property' returns the bare name, which is correct.
{
  const _orig = THREE.TextureNode.prototype.generate;
  THREE.TextureNode.prototype.generate = function _patchedGenerate(builder, output) {
    if (/^sampler/.test(output) && builder.renderer?.backend?.isWebGPUBackend !== true) {
      return _orig.call(this, builder, 'property');
    }
    return _orig.call(this, builder, output);
  };
}
```

### 2. Backend detection and event — `matrix-rain-webgpu.js`

`handle` is assigned synchronously and returned before `renderer.init()` resolves, so
`handle.backend` cannot be set at construction time. The two-step pattern:

**a) Initialise to `null` when the handle is created:**

```js
handle = {
  // ...existing methods...
  backend: null,
  get crt() { return crtHandle; },
};
```

**b) Set it and fire a `CustomEvent` inside `renderer.init().then()`, after `buildPP()` /
the CRT branch:**

```js
// At the end of the try block, before the closing } catch (err) { ... }:
const _isWebGPU = renderer.backend?.isWebGPUBackend === true;
handle.backend  = _isWebGPU ? 'webgpu' : 'webgl2';
element.dispatchEvent(
  new CustomEvent('matrixrain:ready', { bubbles: false, detail: { backend: handle.backend } })
);
```

This lets embedders observe the event before calling `initMatrixRain`, and also read
`handle.backend` at any point after init completes.

### 3. Backend badge — `demo.html` and `matrix-3d.html`

Listen for `'matrixrain:ready'` on the container element before calling
`initMatrixRain`. Insert a small status badge once the event fires:

```js
container.addEventListener('matrixrain:ready', ({ detail }) => {
  const badge = document.createElement('div');
  badge.id = 'backend-badge';
  badge.style.cssText =
    'position:fixed;bottom:8px;right:12px;font:11px/1 monospace;' +
    'color:rgba(0,255,112,0.4);pointer-events:none;z-index:9999;';
  badge.textContent = detail.backend === 'webgpu' ? 'WebGPU' : 'WebGL2';
  document.body.appendChild(badge);
}, { once: true });

const rain = initMatrixRain(container, opts);
```

Read `matrix-3d.html` before implementing to confirm the init pattern and container
variable name.

---

## Files Changed

| File | Change |
|------|--------|
| `matrix-rain-webgpu.js` | TextureNode sampler patch at module preamble; `handle.backend = null` at handle construction; `_isWebGPU` detection + `handle.backend` assignment + `'matrixrain:ready'` event dispatch inside `renderer.init().then()` |
| `demo.html` | `'matrixrain:ready'` listener + backend badge |
| `matrix-3d.html` | Same badge (read file before implementing) |

No new files. No shader files modified.

---

## Testing

1. **Chrome / Edge 113+** (WebGPU available): badge shows "WebGPU"; all effects work
   as before; no regression.

2. **Firefox** (WebGPU absent): badge shows "WebGL2"; glyph rain renders; all six
   post-processing passes compile and run; no console errors about `_sampler`.

3. **Chrome with `--disable-features=Vulkan,UseGPUInRendererProcess`** (forces WebGL2
   fallback): same as Firefox test.

Manual test checklist:
- [ ] `THREE.TextureNode` accessible from `'three/webgpu'` import (verify at start of impl)
- [ ] Glyph material compiles without errors on WebGL2
- [ ] Heat, phosphor, soften, streak, holo, god-rays all render on WebGL2
- [ ] Phosphor temporal feedback accumulates correctly (not blank or flickering)
- [ ] Resize rebuilds the post-processing graph cleanly on WebGL2
- [ ] `setCharSet()` hot-swap works on WebGL2
- [ ] `applyPreset()` works on WebGL2
- [ ] `postProcessing: 'crt'` mode works on WebGL2
- [ ] `destroyMatrixRain()` tears down cleanly; no leaked RTs or listeners
- [ ] `'matrixrain:ready'` fires exactly once per `initMatrixRain` call
- [ ] `handle.backend` is `null` before init resolves, then `'webgpu'` or `'webgl2'`
- [ ] Badge appears promptly after init on both backends
- [ ] No badge duplicate on hot-reload / re-init (badge ID allows CSS targeting)

---

## Non-Goals

- Canvas 2D (`matrix-rain-2d-tsl.js`) — unaffected; uses `CanvasRenderingContext2D`.
- WebGL1 support — out of scope; WebGL2 is the minimum.
- Disabling effects on WebGL2 — all effects should work after the sampler patch. If
  a specific TSL construct fails on WebGL2 during testing, address it as a separate fix.
