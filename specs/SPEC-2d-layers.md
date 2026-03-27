# SPEC-2d-layers

**Status**: Ready for implementation
**Priority**: P1 — depends on SPEC-2d-core
**Reference**: `specs/matrix-rain-analysis.md` §5.5 "Variations — Multi-Layer Depth Pass";
`specs/AUDIT-analysis-vs-code.md` §3.6

---

## Motivation

The 1999 film composited the rain from **three depth layers** rendered separately and
blended additively:

| Layer | Cell size | Speed max | Brightness | Density | Character |
|---|---|---|---|---|---|
| Background | 12 × 18 px | 2.5 c/s | 0.35 | 0.72 | small = far away |
| Midground | 16 × 24 px (default) | 7.0 c/s | 1.0 | 0.72 | standard |
| Foreground | 20 × 30 px | 8.0 c/s | 1.0 | 0.50 | large = close, sparser |

The visual result is a sense of volumetric depth: the background drifts slowly with tiny
characters, the foreground races with larger ones. A single-pass implementation cannot
reproduce this because every cell is the same size and the speed distribution, though
biased, applies to all columns uniformly.

This spec adds a **multi-layer mode** to the 2D component as an opt-in configuration.

---

## Architecture

Three independent `buildRain2DNode` evaluations with per-layer uniforms, composited
additively in a single PostProcessing graph.

```
layer[0] (background) → rtt → TextureNode bg
layer[1] (midground)  → rtt → TextureNode mid
layer[2] (foreground) → rtt → TextureNode fg

composite node = bg.add(mid).add(fg)   ← additive blend, clamped to [0,1]
```

Each layer gets its own `makeRain2DUniforms()` instance. The atlas texture node is
**shared** across all layers — the same `atlasTexNode` object reference is passed to all
three `buildRain2DNode` calls. TSL deduplicates texture bindings by node object identity,
so the compiled shader uses a single sampler binding regardless of how many times the node
appears in the graph — no extra VRAM cost.

The composite node is the final `outputNode` of the PostProcessing graph (or the
`colorNode` of the fullscreen quad material in headless/node-only mode). The fullscreen
quad material retains `THREE.NormalBlending` from SPEC-2d-core — the additive merge is
handled analytically inside the composite TSL node, not via Three.js blending state.

### Why additive in the node graph rather than Three.js blending?

Using `THREE.AdditiveBlending` on three separate draw calls would require three separate
fullscreen scene renders with correct draw order. The TSL node graph approach composites
analytically using four passes: three `rtt`-wrapped layer passes (one per layer) and one
final composite pass that reads all three layer RTTs and additively blends them. This
keeps the entire compositing chain in a single `PostProcessing` / `MeshBasicNodeMaterial`
graph with no external draw-call ordering.

The cost is 4 render passes (3 layer passes + 1 composite pass) instead of 1. The
fragment work per pass is a full-screen evaluation, so total fragment cost is roughly 4×
that of single-layer. At 1080p the three layers evaluate ~5400 (midground) + ~9600
(background) + ~3456 (foreground) = ~18 500 cells per frame. On mobile see §Performance.

---

## Layer Preset Params

Stored as `LAYER_PRESETS` in `matrix-rain-2d-tsl.js`:

```js
export const LAYER_PRESETS = {
  background: {
    cellW: 12, cellH: 18,
    speedMin: 0.8, speedMax: 2.5,
    trailMin: 4,   trailMax: 20,   // design choice — analysis §5.5 does not specify trail range for background
    density: 0.72,
    brightness: 0.35,
  },
  midground: {
    cellW: 16, cellH: 24,
    speedMin: 1.2, speedMax: 7.0,
    trailMin: 6,   trailMax: 30,   // matches SPEC-2d-core defaults
    density: 0.72,
    brightness: 1.0,
  },
  foreground: {
    cellW: 20, cellH: 30,
    speedMin: 3.0, speedMax: 8.0,
    trailMin: 6,   trailMax: 20,   // design choice — narrower than 3D default (6–30); shorter trails suit the sparser, faster foreground
    density: 0.50,
    brightness: 1.0,
  },
};
```

These are defaults. Every field is overridable per-layer via `setLayerParams`.

---

## Column Independence Across Layers

A column at screen position `x` will have the same `col` index in all three layers only
if cell widths are equal. With different `cellW` per layer (12 / 16 / 20), `col =
floor(px.x / cellW)` produces **different column grids** — background has more columns,
foreground fewer. This is correct and desirable: it means the three layers are not
spatially correlated at the column level, giving the impression of independent depth
planes.

The `h21` / `h22` hash functions hash `col` without any layer-index mixing. This means
a given screen column **does not share stream parameters between layers**, which is the
correct behaviour (the background and foreground columns are on different depth planes).
If correlated columns were desired for some reason, pass a per-layer seed offset to the
hash inputs.

---

## API Changes

### `init2DRain` options

Add `layers` option:

```js
init2DRain(element, {
  layers: true,   // false (default) = single-layer mode
  // layerParams: { background: {...}, midground: {...}, foreground: {...} }
  // optional per-layer overrides; merged with LAYER_PRESETS
})
```

When `layers: true`, three uniform sets are created and three nodes are built and
composited. When `layers: false` (default), behaviour is identical to SPEC-2d-core.

### New handle methods

| Method | Description |
|---|---|
| `setLayerParams(layer, params)` | Update any subset of params for `'background'`, `'midground'`, or `'foreground'`. Accepts partial object; only the keys present in `params` update their corresponding uniforms — unspecified keys are not touched. Implementation iterates over `Object.keys(params)` and assigns `layerUniforms[layer]['u' + capitalise(key)].value = params[key]`. |
| `setLayerBrightness(layer, v)` | Convenience — updates `uBrightness` for one layer. |
| `setLayersEnabled(bg, mid, fg)` | Enable/disable individual layers. Disabled layer's `uBrightness` uniform is set to `0.0`, zeroing its contribution without a graph rebuild. The `rtt` pass for that layer still executes (no cost saving), but the composite output is black for that layer. If a full pass skip is required, use the mode-switch rebuild sequence instead. |

`layer` parameter is a string: `'background'` | `'midground'` | `'foreground'`.

### Preset compatibility

`applyPreset` in multi-layer mode applies the preset's colour/opacity/bloom fields that
are shared across all layers (e.g. `color`, `opacity`), but does **not** overwrite the
per-layer structural params (`cellW`, `cellH`, `speedMin`, `speedMax`, `trailMin`,
`trailMax`, `density`, `brightness`). Those remain at their `LAYER_PRESETS` values (or
whatever `setLayerParams` has set). Applying a preset must not destroy the depth
differentiation that defines layered mode. If a preset needs to reset those fields, the
consumer must call `setLayerParams` explicitly for each layer after `applyPreset`.

---

## Composite Node

```js
function buildLayeredRain2DNode(layerUniforms, atlasTexNode) {
  const bg  = rtt(buildRain2DNode(layerUniforms.background, atlasTexNode));
  const mid = rtt(buildRain2DNode(layerUniforms.midground,  atlasTexNode));
  const fg  = rtt(buildRain2DNode(layerUniforms.foreground, atlasTexNode));

  // Additive composite, clamped
  return Fn(() => {
    const bgC  = texture(bg,  screenUV);
    const midC = texture(mid, screenUV);
    const fgC  = texture(fg,  screenUV);
    return vec4(
      clamp(bgC.rgb.add(midC.rgb).add(fgC.rgb), vec3(0), vec3(1)),
      float(1)
    );
  })();
}
```

The `rtt()` wrapping of each layer is required so that `texture(bg, screenUV)` (and
similarly for `mid` and `fg`) works correctly in the composite Fn. `texture()` expects a
`TextureNode` — i.e., a node backed by a concrete render target — not a raw TSL expression
node. Without `rtt()`, TSL cannot produce a `TextureNode` from the upstream node.
See CLAUDE.md: "Custom UV sampling requires `rtt()`." Each `rtt()` call allocates one
full-resolution render target; the composite Fn then reads all three at `screenUV`.
Sampling at the canonical `screenUV` still requires `rtt()` because the composite Fn is
a separate shader scope that cannot inline the upstream Fn body.

---

## `demo-2d.html` Additions

Add to the existing controls panel:

| Control | Type | Description |
|---|---|---|
| Layers toggle | checkbox | Switches between single-layer and layered mode. Rebuilds graph using the four-step sequence in §Node Rebuild on Mode Switch. |
| Layer selector | radio (bg / mid / fg) | Selects which layer the sliders below affect |
| Per-layer brightness | slider 0.1–2.0 | `setLayerBrightness(selectedLayer, v)` |
| Per-layer speed max | slider 1.0–12.0 | `setLayerParams(selectedLayer, {speedMax: v})` |
| Per-layer cell size | slider (linked W/H) | `setLayerParams(selectedLayer, {cellW, cellH})` |

Switching layers mode tears down and rebuilds the material/node graph. Show a brief
loading indicator (canvas opacity 0.5) while rebuilding.

---

## Performance

### Desktop WebGPU
4 render passes (3 layer + 1 composite). Total cells evaluated per frame at 1080p:
- Background (12×18): 160 × 60 = 9600 cells
- Midground (16×24): 120 × 45 = 5400 cells
- Foreground (20×30): 96 × 36 = 3456 cells
- Total: ~18 500 cells per frame, each running the stream loop (4 slots × hash chains)

Expect ~60 fps on discrete GPU, 45–60 fps on integrated GPU (Intel/Apple). These are
estimates; actual performance depends on GPU fragment throughput, not cell count alone.

### Mobile
Fragment cost may exceed frame budget on low-end mobile. Mitigation options:
1. **`layers: false` default** — single-layer on mobile, multi-layer on desktop. Detect
   via `navigator.hardwareConcurrency` or `GPU.requestAdapterInfo()` tier hints.
2. **Increase cell size** — `setLayerParams('background', {cellW: 18, cellH: 27})` etc.
   reduces number of cell evaluations proportionally to (cellW × cellH).
3. **Disable foreground layer** — `setLayersEnabled(true, true, false)`.

No automatic downgrade is implemented in this spec. The consumer is responsible for
detecting capability and passing appropriate options.

---

## Node Rebuild on Mode Switch

Switching `layers: true ↔ false` at runtime requires rebuilding the node graph (different
number of `rtt` nodes and composite topology). The rebuild sequence:

1. Cancel RAF
2. Dispose existing PostProcessing / material colorNode
3. Rebuild with new graph
4. Restart RAF

This is the same rebuild pattern used by the 3D component's resize handler. The operation
takes one frame to execute; no visible stutter on desktop.

Switching is not expected to be frequent — it is a configuration-time decision. Do not
expose a `setLayers(bool)` handle method that invites casual per-frame toggling.
The `demo-2d.html` toggle is for authoring purposes only.

### Resize handling in layered mode

The three `rtt()` nodes in `buildLayeredRain2DNode` allocate render targets at the
renderer's current resolution. On viewport resize, these targets are stale (wrong
dimensions) and must be rebuilt. Use the same RTT resize detection pattern as the 3D
component (CLAUDE.md §RTT Resize Detection): in the render loop, check whether any layer
RTT's `renderTarget.width/height` differs from the current renderer output size. If so,
trigger the same rebuild sequence (cancel RAF → dispose → rebuild graph → restart RAF)
before rendering the next frame.

The `demo-2d.html` controls reference the mode-switch sequence above for both layer toggle
and resize rebuilds; they share the same four-step procedure.

---

## Tasks

1. **`LAYER_PRESETS` constant** — add to `matrix-rain-2d-tsl.js`.
   *(Depends on SPEC-2d-core complete.)*

2. **`buildLayeredRain2DNode`** — composite function using three `rtt`-wrapped layer nodes.
   *(Depends on Task 1.)*

3. **`init2DRain` — `layers` option** — when `layers: true`, create three uniform sets
   from `LAYER_PRESETS` merged with any `layerParams` overrides, call
   `buildLayeredRain2DNode`, use as `material.colorNode`.
   *(Depends on Task 2.)*

4. **Handle methods** — `setLayerParams`, `setLayerBrightness`, `setLayersEnabled`.
   *(Depends on Task 3.)*

5. **`demo-2d.html` layer controls** — layers toggle, layer selector, per-layer sliders,
   rebuild-on-toggle with loading indicator.
   *(Depends on Task 3.)*

6. **Manual browser test** — verify: background characters visibly smaller/slower than
   foreground; additive composite produces correct brightening at column overlaps; layer
   disable zeroes contribution; mode switch does not crash or leak.

---

## Out of Scope

- More than three layers (trivially extensible later if needed)
- Per-layer `charSet` (all layers use the same atlas)
- Per-layer post-processing (bloom per layer, etc.)
- Automatic mobile capability detection and layer downgrade
