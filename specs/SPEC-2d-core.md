# SPEC-2d-core

**Status**: Ready for implementation
**Priority**: P0 — prerequisite for SPEC-2d-layers and SPEC-2d-organic
**Reference**: `specs/matrix-rain-analysis.md` §3, §5.1–5.3; `specs/AUDIT-analysis-vs-code.md` §3

---

## Motivation

The existing 3D component renders 600 instanced billboard columns on a spherical shell.
This is the right architecture for the globe/telescreen context, but it cannot faithfully
reproduce several film-accurate properties that emerge from the original flat-screen grid:

- Two-stage colour ramp keyed on *brightness* (not distance), matching measured Blu-ray values
- Position-based flicker rates (head 15 Hz → deep trail static)
- Log-biased speed distribution with the full 1.2–8 c/s range
- Multi-layer depth parallax (separate SPEC-2d-layers)
- Traveling waves of activity (separate SPEC-2d-organic)

The 2D component is also useful as a **video source** for the CRT bridge: wrap its output
node in `rtt()` and pass to `buildCRTNodesFromSource`, replacing the 3D scene render.

---

## Files

| File | Role |
|---|---|
| `matrix-rain-2d-tsl.js` | TSL node factory + uniforms + public API |
| `demo-2d.html` | Standalone demo with controls panel |

No new pass builders. No new atlas files — the 2D rain reuses the existing
`CHAR_SETS` table and MSDF atlases from `matrix-rain-webgpu.js`.

---

## Architecture

The 2D rain is a fullscreen fragment evaluation. No vertex instancing.

```
OrthographicCamera (-1,1,1,-1,0,1)
    └─ PlaneGeometry(2,2)
         └─ MeshBasicNodeMaterial
              └─ colorNode = buildRain2DNode(uniforms, atlasTexNode)
                              ├─ screenUV * screenSize  → pixel coords
                              ├─ cell decomposition      → (col, row, cellUV)
                              ├─ evalCell(col, row, t)   → (brightness, charId, isHead)
                              ├─ sampleGlyph2D           → mask scalar
                              └─ colourMap + alpha        → vec4 output
```

The node is also directly composable: `rtt(buildRain2DNode(uniforms, atlasTexNode))` gives
a `TextureNode` that can feed any downstream pass or the CRT bridge.

> **Two-renderer limitation**: each `init2DRain` call creates its own `WebGPURenderer`.
> Running the 2D rain simultaneously with the 3D component on the same page means two
> WebGPU device contexts. This is valid but wastes resources. If co-rendering, pass the
> existing renderer to `init2DRain` via an `externalRenderer` option (not in this spec —
> defer to future work), or use `headless: true` and drive the node from the 3D
> component's renderer.

---

## Uniforms

Exported from `makeRain2DUniforms()`:

| Uniform | Type | Default | Description |
|---|---|---|---|
| `uCellW` | float | 16.0 | Cell width in pixels |
| `uCellH` | float | 24.0 | Cell height in pixels |
| `uSpeedMin` | float | 1.2 | Min stream speed, cells/s |
| `uSpeedMax` | float | 8.0 | Max stream speed, cells/s |
| `uTrailMin` | float | 6.0 | Min trail length, cells |
| `uTrailMax` | float | 30.0 | Max trail length, cells |
| `uDensity` | float | 0.72 | Active column fraction [0,1] |
| `uNStreams` | float | 2.0 | Concurrent streams per column [1–4] |
| `uSpeedRamp` | float | 1.0 | Global speed multiplier |
| `uGlitchAmt` | float | 0.0 | Glitch intensity [0,1] — see SPEC-2d-organic |
| `uBrightness` | float | 1.0 | Global brightness multiplier |
| `uGlobalAlpha` | float | 1.0 | Global alpha |
| `uGlyphCount` | float | 64.0 | Glyphs in atlas |
| `uAtlasGridW` | float | 8.0 | Atlas columns |
| `uAtlasGridH` | float | 8.0 | Atlas rows |

The colour ramp colours are **compile-time constants** in the TSL node (not uniforms) since
they represent measured film values and are not intended to be varied at runtime.

`makeRain2DUniforms()` also returns `_time: uniform(0)` — an internal float updated every
RAF with the pre-wrapped elapsed time (see Time Precision). It is not exposed as a public
handle method.

---

## State Machine

### Cell coordinates

```js
const px      = screenUV.mul(screenSize.xy);           // pixel position
const cellSz  = vec2(uCellW, uCellH);
const cellUV  = fract(px.div(cellSz));                 // [0,1)² within cell
const cell    = floor(px.div(cellSz));                 // integer cell coords
const col     = cell.x;
const row     = cell.y;
const numRows = ceil(screenSize.y.div(uCellH)).add(4.0); // +4 off-screen overhang
```

### Hash functions

Use the same float-domain hash as the analysis §5.3 TSL section:

```js
// h21: vec2 → float [0,1)
const h21 = Fn(([p]) => {
  const p3 = fract(vec3(p.x.mul(0.1031), p.y.mul(0.1030), p.x.mul(0.0973)));
  const dot_ = p3.dot(p3.yzx.add(33.33));
  return fract(p3.x.add(p3.y).mul(p3.z).add(dot_));
});

// h22: vec2 → vec2 [0,1)²
const h22 = Fn(([p]) => {
  const p3  = fract(vec3(p.x.mul(0.1031), p.y.mul(0.1030), p.x.mul(0.0973)));
  const dot_ = p3.dot(p3.yzx.add(33.33));
  return fract(vec2(p3.x.add(p3.y), p3.x.add(p3.z)).mul(p3.zy.add(dot_)));
});
```

### Stream parameters

Derived entirely from `(col, streamIndex)` — no GPU-side state buffer.

```js
// JS helper (NOT a TSL Fn) — returns a plain object of TSL node expressions.
// Called once per unrolled slot inside buildRain2DNode; each call produces
// distinct TSL nodes for that slot's hash seeds.
function getStreamNodes(col, sif) {
  const h  = h22(vec2(col.mul(0.37).add(sif.mul(13.73)), sif.mul(7.31).add(col.mul(0.19))));
  const h2 = h22(vec2(col.mul(1.73).add(sif.mul(5.17)),  col.mul(0.23).add(sif)));

  // Log-biased speed: squaring h.x concentrates weight toward speedMin
  const speedT   = h.x.mul(h.x);
  const speed    = mix(uSpeedMin, uSpeedMax, speedT).mul(uSpeedRamp);
  const trail    = mix(uTrailMin, uTrailMax, h.y);
  const gap      = trail.mul(mix(float(0.5), float(3.0), h2.x));
  const phase    = h2.y.mul(57.3);
  // TSL select signature: select(condition, trueVal, falseVal)
  const enabled  = select(
    h21(vec2(col.mul(7.77).add(sif.mul(3.33)), float(17.1))).lessThan(uDensity),
    float(1), float(0));

  return { speed, trail, gap, phase, enabled };
}
```

`getStreamNodes` is a **JS build-time helper**, not a GPU-side TSL Fn. TSL `Fn`s can only
return a single node type (scalar or vector); they cannot return a JS object of multiple
nodes. Calling `getStreamNodes` from inside the JS `for` loop unrolls the hash computations
as distinct TSL graph branches for each slot.

The `mix(min, max, h.x * h.x)` squaring is the log-biased distribution from analysis §3:
most columns run at 1–3 c/s, thin tail extends to 8 c/s.

### Cycle and brightness

For each stream slot `si` in a JS unrolled loop (`for si in 0..3`). The loop is always 4 iterations; slots at or beyond `uNStreams` are masked out with a `siActive` flag computed inside the loop:

```js
const sif      = float(si);
const siActive = sif.lessThan(uniforms.uNStreams);  // bool → used as select condition
```

`uNStreams` therefore controls stream count at runtime without requiring a variable-length GPU loop.

```
cycleLen = numRows + trail + gap
pos      = ((t + phase) * speed) mod cycleLen     ← fmod via floor to avoid f32 loss
```

If `pos > numRows + trail`: column is in gap phase → skip.

```
head_y   = pos
d        = head_y - row                           ← distance from head (0 = head)
```

If `d < 0 || d > trail`: this cell is not lit by stream `si` → skip.

```
λ        = 4.605 / trail                          ← ensures B(trail) ≈ 0.01
brightness = exp(-λ * d)
```

Take the **maximum brightness** across all stream slots. Use `select()` not `mix()` — `.greaterThan()` returns a `bool` node and `mix()` requires a `float` third argument:

```js
// select(condition, trueVal, falseVal) — if bri > bestBri, take new values
const takeBetter = bri.greaterThan(bestBri);
bestBri.assign(select(takeBetter, bri,  bestBri));
bestCid.assign(select(takeBetter, cid,  bestCid));
```

### Position-based flicker rates

Gated on `d` (distance from head). Four tiers match analysis §3 Character Change Rates:

| `d` range | Rate | `charTick` expression |
|---|---|---|
| `d < 1.0` | 15 Hz | `floor(t * 15.0)` |
| `1.0 ≤ d < 4.0` | ~0.5 Hz | `floor(t * 0.5 + cellSeed * 31.0)` |
| `4.0 ≤ d < trail/2` | ~0.1 Hz | `floor(t * 0.1 + cellSeed * 13.0)` |
| `d ≥ trail/2` | static | `float(0)` |

`cellSeed = h21(vec2(col * 9.73 + sif * 3.17, row * 7.41))` — per-cell random offset,
prevents all mid-trail cells from flipping simultaneously. (`sif = float(si)` from the
outer unrolled loop; use `sif` not the raw JS `si` inside TSL expressions.)

```js
const cellSeed = h21(vec2(col.mul(9.73).add(sif.mul(3.17)), row.mul(7.41)));
const charTick = select(
  d.lessThan(float(1.0)),    floor(t.mul(15.0)),
  select(
    d.lessThan(float(4.0)),  floor(t.mul(0.5).add(cellSeed.mul(31.0))),
    select(
      d.lessThan(trail.div(2.0)), floor(t.mul(0.1).add(cellSeed.mul(13.0))),
      float(0)
    )
  )
);
const charId = h21(vec2(
  col.mul(73.1).add(row.mul(19.3)).add(sif.mul(11.7)),
  charTick.mul(0.13)
));
```

The best `charId` is taken alongside best `brightness` (same stream slot).

---

## Colour Mapping

Film-measured values from analysis §2 (4K Blu-ray):

```js
const deepTrail   = vec3(0.000, 0.176, 0.039);   // #002D0A
const matrixGreen = vec3(0.000, 1.000, 0.255);   // #00FF41
const headWhite   = vec3(0.784, 1.000, 0.824);   // #C8FFD2
```

Two-stage lerp keyed on brightness (not distance):

```js
const t1  = smoothstep(float(0.01), float(0.15), bestBri);  // deep → green
const t2  = smoothstep(float(0.75), float(1.00), bestBri);  // green → white
let col3  = mix(deepTrail, matrixGreen, t1);
col3      = mix(col3,      headWhite,   t2);
col3      = col3.mul(bestBri).mul(glyphMask).mul(uBrightness);
```

The deep-trail colour floor (`#002D0A`) ensures even the faintest trail cells retain a
faint green cast rather than going pure black — matching the film's phosphor appearance.

---

## Glyph Sampling

Reuse the same MSDF atlas infrastructure as the 3D component. `CHAR_SETS` in
`matrix-rain-webgpu.js` is currently a module-local `const` (not exported). The 2D module
must either:

- **Option A (preferred):** Add `export` to `CHAR_SETS` in `matrix-rain-webgpu.js` and
  import it: `import { CHAR_SETS } from './matrix-rain-webgpu.js'`
- **Option B:** Duplicate the four-entry descriptor object directly in
  `matrix-rain-2d-tsl.js` (simple, no cross-dependency)

Pick Option A if the atlas system is treated as shared infrastructure; Option B if the
2D module should be independently usable without importing the 3D module. Document the
choice in Task 1.

```js
// Atlas texture node — created without a fixed UV so it can be sampled at
// arbitrary UVs inside sampleGlyph2D. Hot-swapped by setCharSet() via .value.
let atlasTexNode = texture(atlasTex);  // bare TextureNode, no UV baked in

const sampleGlyph2D = Fn(([cellUV, charId]) => {
  const gIdx = floor(charId.mul(uGlyphCount));
  const cx   = mod(gIdx, uAtlasGridW);
  const cy   = floor(gIdx.div(uAtlasGridW));
  const uv   = vec2(cx, cy).add(cellUV).div(vec2(uAtlasGridW, uAtlasGridH));
  // .uv(uv) samples the bare TextureNode at the computed UV
  const samp = atlasTexNode.uv(uv);
  // MSDF: median of RGB channels
  const r = samp.r, g = samp.g, b = samp.b;
  const med = max(min(r, g), min(max(r, g), b));
  return smoothstep(float(0.48), float(0.52), med);  // narrow band → crisp edges
});
```

The smoothstep threshold `0.48–0.52` is tighter than the 3D POM version since the 2D rain
renders at fixed screen pixel scale without perspective distortion.

`atlasTexNode` must be stored in module state and its `.value` property updated on
`setCharSet()` without rebuilding the material. This is the same `.value` hot-swap used
for `phosphorPrevTex` in the 3D component — note that `setCharSet` in the 3D component
does NOT do this (it rebuilds the material), but the 2D component should use the cheaper
`.value` swap instead.

---

## Glitch Pass

`uGlitchAmt` is wired in this spec (uniform defined, zero by default) but the actual
glitch logic and trigger API are specified in SPEC-2d-organic. The node must reserve
the uniform slot now so SPEC-2d-organic can add the node logic without a uniform refactor.

The pixel coordinates `px` computed at the top of `buildRain2DNode` must be declared as
a `toVar` so downstream glitch displacement can modify it:

```js
const px = screenUV.mul(screenSize.xy).toVar('px');
// SPEC-2d-organic inserts glitch displacement here
```

---

## Node Structure

```js
// matrix-rain-2d-tsl.js

export function makeRain2DUniforms() { /* returns uniform object */ }

export function buildRain2DNode(uniforms, atlasTexNode) {
  return Fn(() => {
    const px      = screenUV.mul(screenSize.xy).toVar('px');
    // [glitch displacement placeholder — SPEC-2d-organic]

    const cellSz  = vec2(uniforms.uCellW, uniforms.uCellH);
    const cellUV  = fract(px.div(cellSz));
    const cell    = floor(px.div(cellSz));
    const col     = cell.x;
    const row     = cell.y;
    const numRows = ceil(screenSize.y.div(uniforms.uCellH)).add(4.0);

    // Mutable best-stream accumulators
    const bestBri = float(0).toVar('bestBri');
    const bestCid = float(0).toVar('bestCid');

    // Unrolled stream slots (JS loop builds 4 identical TSL branches)
    // siActive masks out slots at or beyond uNStreams at runtime
    for (let si = 0; si < 4; si++) {
      const sif      = float(si);
      const siActive = sif.lessThan(uniforms.uNStreams);
      const sp       = getStreamNodes(col, sif);  // JS helper, returns object of TSL nodes
      // [stream evaluation — see §State Machine above; gate all contributions on siActive]
    }

    // Early discard — consistent with CLAUDE.md: Discard() in fragment Fn
    If(bestBri.lessThan(float(0.005)), () => { Discard(); });

    const glyphMask = sampleGlyph2D(cellUV, bestCid);
    If(glyphMask.lessThan(float(0.01)), () => { Discard(); });

    // [two-stage colour mapping]
    // [alpha]
    return vec4(col3, uniforms.uGlobalAlpha);
  })();
}
```

`Discard()` is used for fragment early-exit (see CLAUDE.md). With `THREE.NormalBlending`
and `transparent: true`, discarded fragments leave the background unchanged, which is the
correct behaviour for a transparent overlay. This is also consistent with the 3D
component's use of `Discard()` in its outputNode Fn.

---

## Public API

### `init2DRain(element, opts?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `charSet` | string | `'matrix1999'` | Named atlas; falls back to `matrixcode` if 1999 atlas not found |
| `atlasPath` | string\|null | null | Explicit atlas URL, overrides charSet |
| `cellSize` | `[w, h]` | `[16, 24]` | Cell dimensions in pixels |
| `speedRange` | `[min, max]` | `[1.2, 8.0]` | Speed c/s |
| `trailRange` | `[min, max]` | `[6, 30]` | Trail length cells |
| `density` | number | 0.72 | Active column fraction |
| `nStreams` | number | 2 | Concurrent streams per column (1–4) |
| `brightness` | number | 1.0 | Global brightness |
| `opacity` | number | 1.0 | Global alpha |
| `preset` | string\|null | null | Apply named preset after init |
| `headless` | boolean | false | Skip scene/renderer/RAF creation; return only the node + uniforms handle (for CRT bridge use) |

Returns a control handle (see Handle Methods below).

Internally creates:
- `WebGPURenderer` attached to a `<canvas>` inside `element`
- Orthographic camera `(-1, 1, 1, -1, 0, 1)`
- `PlaneGeometry(2, 2)` fullscreen quad
- `MeshBasicNodeMaterial` with `colorNode = buildRain2DNode(uniforms, atlasTexNode)`
- `material.depthWrite = false`, `material.toneMapped = false`
- `material.transparent = true`, `material.blending = THREE.NormalBlending`
- RAF loop with `animRef` pattern (same as 3D component)
- `ResizeObserver` for responsive layout

Time pre-wrap: `uniforms._time.value = (ts / 1000.0) % 3600` where `ts` is the RAF
timestamp in ms. `_time` is a plain `uniform(0)` (internal, not in the public table);
it is referenced by name inside `buildRain2DNode` and updated each frame. Do not use the
TSL `time` builtin — it is not pre-wrapped.

### `destroy2DRain(element)`

Cancels RAF, disconnects ResizeObserver, disposes geometry, material, atlas texture,
renderer. Removes canvas from DOM.

### Handle Methods

| Method | Description |
|---|---|
| `destroy()` | Same as `destroy2DRain(element)` |
| `setCharSet(name)` | Hot-swap atlas texture + update grid uniforms |
| `setCellSize(w, h)` | Update `uCellW`, `uCellH` |
| `setSpeedRange(min, max)` | Update `uSpeedMin`, `uSpeedMax` |
| `setTrailRange(min, max)` | Update `uTrailMin`, `uTrailMax` |
| `setDensity(v)` | Update `uDensity` [0,1] |
| `setNStreams(n)` | Update `uNStreams` [1–4]; clamps to int |
| `setBrightness(v)` | Update `uBrightness` |
| `setOpacity(v)` | Update `uGlobalAlpha` |
| `setSpeedMul(v)` | Update `uSpeedRamp` (base for speed ramp — SPEC-2d-organic) |
| `applyPreset(name)` | Apply named preset from `matrix-rain-presets.js` |
| `getOutputNode()` | Returns the raw TSL node (for CRT bridge / PostProcessing wiring) |

`getOutputNode()` returns the **already-built** node captured when `init2DRain` called
`buildRain2DNode(uniforms, atlasTexNode)`. It must NOT call `buildRain2DNode` again —
that would create a second, disconnected node graph. The caller can wrap it in `rtt()`
and feed it to `buildCRTNodesFromSource`.

### Preset compatibility

The 2D component uses the same `matrix-rain-presets.js` `PRESETS` table and `applyPreset`
helper as the 3D component. Any preset fields that reference 3D-only uniforms (e.g.
`uDepth`, `uNormalStrength`) are silently ignored.

---

## CRT Bridge Integration

To use the 2D rain as a CRT video source:

```js
import { init2DRain } from './matrix-rain-2d-tsl.js';
import { buildCRTNodesFromSource } from './telescreen-crt-webgpu.js';
import { rtt } from 'three/tsl';

const rain2d = init2DRain(el, { charSet: 'matrix1999' });
const rainNode = rtt(rain2d.getOutputNode());
const crtNodes = buildCRTNodesFromSource(rainNode, renderer, opts);
// wire crtNodes into PostProcessing
```

The 2D rain does not set up its own PostProcessing graph when used this way — the CRT
bridge owns the renderer loop. `init2DRain` with `headless: true` (see Options table)
skips scene/RAF creation and returns only the node + uniforms handle.

---

## `demo-2d.html`

Standalone demo. Importmap uses `three@0.183.0` (same as `demo.html`).

### Controls panel

| Control | Type | Uniform |
|---|---|---|
| Char set | dropdown (`matrixcode` / `matrix1999` / `latin` / `ascii`) | `setCharSet` |
| Cell width | slider 8–32 | `setCellSize(w, h)` |
| Cell height | slider 12–48 | `setCellSize(w, h)` |
| Speed min | slider 0.5–4.0 | `setSpeedRange` |
| Speed max | slider 2.0–12.0 | `setSpeedRange` |
| Trail min | slider 3–15 | `setTrailRange` |
| Trail max | slider 10–50 | `setTrailRange` |
| Density | slider 0.2–1.0 | `setDensity` |
| Streams/col | slider 1–4 step 1 | `setNStreams` |
| Brightness | slider 0.2–2.0 | `setBrightness` |
| Opacity | slider 0.0–1.0 | `setOpacity` |
| Preset | dropdown | `applyPreset` |

---

## Time Precision

Use the same pre-wrap pattern as the 3D component:

```js
const WRAP_S = 3600.0;
function animate(ts) {
  animRef.id = requestAnimationFrame(animate);
  uniforms._time.value = (ts / 1000.0) % WRAP_S;
  renderer.renderAsync(scene, camera);
}
```

`_time` is a plain `uniform(0)` that is referenced directly inside `buildRain2DNode` as
the time variable — the same pattern the 3D component uses for `uniforms.uTime`. Do NOT
use the TSL `time` builtin or `timerLocal()` — the builtin is not pre-wrapped and
will lose f32 precision beyond ~3600 s. Update `_time.value` each RAF with the pre-wrapped
value as shown above.

---

## Tasks

1. **`makeRain2DUniforms()`** — define all uniforms in the table above plus the internal
   `_time: uniform(0)`. Decide and document the CHAR_SETS import strategy (Option A or B).
   *(No dependencies.)*

2. **Hash functions** (`h21`, `h22`) — implement as TSL `Fn`s; consider extracting to a
   shared `matrix-rain-hash-tsl.js` if the 3D component uses compatible versions.
   *(No dependencies.)*

3. **`getStreamNodes` helper** — JS build-time function returning TSL node expressions
   for one stream slot; includes log-biased speed. Not a TSL `Fn`.
   *(Depends on Task 1, 2.)*

4. **Cell evaluation loop** — unrolled stream slots, brightness accumulation, position-based
   flicker tier selection, `charId` derivation.
   *(Depends on Task 3.)*

5. **`sampleGlyph2D` Fn** — MSDF atlas sampling with narrow smoothstep threshold.
   *(Depends on Task 1.)*

6. **Two-stage colour mapping** — implement with film-accurate colour constants.
   *(Depends on Task 4.)*

7. **`buildRain2DNode`** — assemble Tasks 2–6 into the full node; confirm `Discard()`
   early-exit pattern works with `MeshBasicNodeMaterial` on fullscreen quad.
   *(Depends on Tasks 4, 5, 6.)*

8. **`init2DRain` / `destroy2DRain` / handle** — setup, RAF, ResizeObserver, `getOutputNode`.
   *(Depends on Task 7.)*

9. **`setCharSet` hot-swap** — load atlas PNG via `TextureLoader`, update
   `atlasTexNode.value = newTex` and grid uniforms without rebuilding the material.
   Use the `.value` hot-swap pattern (not the 3D component's full material rebuild).
   *(Depends on Task 8.)*

10. **`demo-2d.html`** — standalone demo with controls panel.
    *(Depends on Task 8.)*

11. **Manual browser test** — verify: glyph rendering at multiple cell sizes, flicker rate
    gradient visible (head flickers noticeably faster than deep trail), colour ramp shows
    dark-green floor on faint trail cells (not pure black), atlas hot-swap works.

---

## Out of Scope

- Glitch displacement logic — uniform reserved here; implementation in SPEC-2d-organic
- Speed ramp trigger — uniform reserved here; implementation in SPEC-2d-organic
- Phase correlation, clustering, weighted glyphs — SPEC-2d-organic
- Multi-layer compositing — SPEC-2d-layers
- `prefers-reduced-motion` — SPEC-2d-organic
- POM, sway, globe pulse, drip stretch — 3D-only, not ported
