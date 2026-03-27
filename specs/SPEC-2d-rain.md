# SPEC-2d-rain — 2D flat fullscreen rain component

**Status**: Implemented
**Priority**: Medium
**Reference**: `specs/AUDIT-analysis-vs-code.md` §5, `specs/matrix-rain-analysis.md` §5.3

---

## Motivation

The existing 3D component is volumetric, billboard-based, and requires depth/camera. The
analysis describes a film-accurate **flat fullscreen** rain that is:
- Directly compositable with CRT (`setSourceNode` input) for a pure flat-screen aesthetic
- Self-contained — no Three.js scene/camera setup required by the consumer
- Film-accurate: two-stage colour ramp, position-based flicker, log-biased speeds, multi-layer

This component is also the natural home for column clustering and inter-column phase
correlation (they are structurally simpler in 2D than in 3D).

---

## Architecture: analytical fragment shader

Rather than a CPU column-state machine, the 2D rain is computed **analytically per fragment**
using the same hash-based approach as the 3D TSL shader. No compute pass, no storage textures.
A TSL `colorNode` function takes UV, time, and uniforms and returns the rain colour.

### Module: `matrix-rain-2d-tsl.js`

Exports:
```js
// Build a reusable TSL colour node (no scene/renderer dependency).
// Returns a TSL node that can be used as colorNode in any MeshBasicNodeMaterial
// or fed into pp.outputNode / setSourceNode for CRT integration.
export function buildMatrix2DColorNode(uniforms2d);

// Full convenience init — creates a scene, ortho camera, fullscreen quad, renderer.
// opts mirrors initMatrixRain where applicable.
export function initMatrix2DRain(element, opts);

// Tear down.
export function destroyMatrix2DRain(element);
```

The 2D component shares the same `CHAR_SETS` atlas table and `loadMSDF` from
`matrix-rain-webgpu.js` (re-export or duplicate as needed).

`makeUniforms2D(opts)` accepts an options object:
```js
// All keys optional; defaults from the Uniforms table above.
makeUniforms2D({ color, globalAlpha, nRows, cellAspect, speedMul, brightness, charSet })
```
It returns a plain JS object `{ uTime2D, uColor2D, uGlobalAlpha2D, uNRows2D, ... }` with
TSL uniform nodes as values — same pattern as `makeUniforms` in `matrix-rain-tsl.js`.
When `charSet` is provided, `makeUniforms2D` also sets `uGlyphCount2D`, `uAtlasGridW2D`,
and `uAtlasGridH2D` from the `CHAR_SETS` table; the caller does not need to set these
separately. If `charSet` is omitted, the defaults (64-glyph, 8×8) apply.

### `h2` hash dependency

The `h2` Fn defined in `matrix-rain-tsl.js` is currently a private closure inside
`buildGlyphMaterial`. Before implementing this spec, **export `h2` from `matrix-rain-tsl.js`**:
```js
// matrix-rain-tsl.js — add to exports:
export const h2 = Fn(([p]) => { ... });  // the existing hash Fn body, unchanged
```
Then import it in `matrix-rain-2d-tsl.js`:
```js
import { h2 } from './matrix-rain-tsl.js';
```
Alternatively, define a local copy in `matrix-rain-2d-tsl.js` — either is acceptable.

---

## Coordinate system

Screen UV: `(0,0)` = top-left, `(1,1)` = bottom-right (standard WebGPU `screenUV`).

Columns: vertical stripes, `colIdx = floor(uv.x.mul(nCols))` where `nCols` is computed
in the shader as `uNRows2D.div(uCellAspect2D)` (derived from the two uniforms, not a
separate input).

Glyph cells: `cellH_uv = 1.0 / uNRows2D` (rows fill the screen height).
Cell aspect ratio: `cellW_uv = cellH_uv * uCellAspect2D`.

Head falls **downward** (UV Y increases over time).
Trail is **above** the head (smaller UV Y), distance measured in cells:
```
dist = (headY_uv - uv.y) / cellH_uv    (0 at head, >0 going upward into trail)
```

---

## Uniforms (`makeUniforms2D`)

| Uniform | Type | Default | Description |
|---|---|---|---|
| `uTime2D` | `float` | 0 | Seconds, updated each frame |
| `uColor2D` | `vec3` | `(0, 1, 0.44)` | Glyph tint |
| `uGlobalAlpha2D` | `float` | 1.0 | Global alpha |
| `uNRows2D` | `float` | 30 | Rows filling screen height |
| `uCellAspect2D` | `float` | 0.5 | Cell width / cell height (nCols derived as nRows / aspect) |
| `uSpeedMul2D` | `float` | 1.0 | Speed multiplier |
| `uBrightness2D` | `float` | 1.0 | Brightness multiplier |
| `uGlyphCount2D` | `float` | 64 | Glyph count from atlas |
| `uAtlasGridW2D` | `float` | 8 | Atlas columns |
| `uAtlasGridH2D` | `float` | 8 | Atlas rows |
| `uGlyphTex2D` | `texture` | — | MSDF atlas |

---

## Core algorithms

### Column index

```js
const nCols   = uNRows2D.div(uCellAspect2D);        // derived: nCols = nRows / aspect
const colIdx  = floor(uv.x.mul(nCols));
const cellH_uv = float(1.0).div(uNRows2D);
```

### Speed distribution (log-biased)

```js
const speedR = h2(vec2(colIdx.mul(0.73), 0.10));
const speed  = float(1.2).add(speedR.mul(speedR).mul(6.8));   // [1.2, 8.0] c/s
```

### Speed micro-oscillation

Reuse exact same expression as 3D SPEC-3d-feel, keyed on `colIdx` instead of `aSeed`:
```js
const breathFreq  = float(0.1).add(h2(vec2(colIdx.mul(13.7), 0.1)).mul(0.4));
const breathPhase = h2(vec2(colIdx.mul(7.3),  0.5)).mul(6.2832);
const breathMul   = float(1).add(
  sin(uTime2D.mul(breathFreq).mul(6.2832).add(breathPhase)).mul(0.15)
);
```

### Inter-column phase correlation (traveling wave)

A slow sinusoidal wave sweeps left-to-right over ~60 s, with 4 crests across 120 columns:
```js
// Spatial: 4 crests / 120 cols → 4 × 2π / 120 = 0.2094 rad/col
// Temporal: period 60 s → 2π / 60 = 0.1047 rad/s
const waveOff = sin(colIdx.mul(0.2094).add(uTime2D.mul(0.1047))).mul(0.12);
```
`waveOff` ∈ [−0.12, +0.12] is a fractional offset added to the cycle start phase
(multiplied by `cycleH` to convert to UV units before adding).

### Column clustering

A "rivulet density" factor modulates per-column activity via a slow sinusoidal density wave:
```js
// Cluster activity: ~60 % of column slots active on average.
// Period: 2π / (0.01666 × 6.2832) ≈ 60 s — slow enough to be atmospheric.
const clusterSeed  = h2(vec2(colIdx.mul(0.19), 0.37));   // ∈ [0, 1)
const clusterPhase = uTime2D.mul(0.01666).add(colIdx.mul(0.0173));
const isActive     = step(0.40,
  sin(clusterPhase.mul(6.2832)).mul(0.5).add(0.5)   // sine remapped → [0, 1]
    .add(clusterSeed)                                 // → [0, 2)
    .mul(0.5)                                         // → [0, 1)
);
```

Range of the full expression ∈ [0, 1). `step(0.40, x)` returns 1 when `x ≥ 0.40`.
At `sin = 0` (mid): expression = `(0.5 + clusterSeed) × 0.5 = 0.25 + 0.5×clusterSeed`.
For `isActive = 1` at mid: `clusterSeed ≥ 0.30` → ~70 % of columns active.
At `sin = −1` (trough): expression = `0.5 × clusterSeed`. Active when `clusterSeed ≥ 0.80` → ~20 %.
At `sin = +1` (peak): expression ≥ `0.5` always → 100 % active.
Average across uniform `clusterSeed` and sine cycle ≈ 60 % active.

When `isActive = 0`, the fragment returns `vec4(0)` (fully transparent).

### Cycle position and head Y

```js
const colSeed  = h2(vec2(colIdx.mul(0.41), 0.50));
const trailLen = float(0.015).add(h2(vec2(colIdx.mul(0.61), 0.3)).mul(0.035));
const cycleRows = float(4.42).div(trailLen);              // visible trail length in rows
const cycleH    = float(1.0).add(cycleRows.div(uNRows2D)); // cycle height in UV units

const cyclePos = mod(
  uTime2D.mul(speed).mul(breathMul).mul(cellH_uv).mul(uSpeedMul2D)
    .add(colSeed.mul(cycleH))
    .add(waveOff.mul(cycleH)),
  cycleH
);
const headY_uv = cyclePos;   // head UV Y (0=top, 1=bottom); wraps through cycleH
```

### Trail distance and culling

```js
const dist = headY_uv.sub(uv.y).div(cellH_uv);   // 0 at head, + into trail (above)
If(dist.lessThan(-0.5).or(dist.greaterThan(cycleRows.add(1.0))), () => { Discard(); });
```

### Trail attenuation (same formula as 3D)

```js
const halfDist = float(0.6931).div(trailLen);
const accel    = select(dist.greaterThan(halfDist), float(1.5), float(1.0));
const trailAtt = exp(dist.negate().mul(trailLen).mul(accel));
If(trailAtt.lessThan(0.012), () => { Discard(); });
```

### Position-based flicker rates (film-accurate)

Reuse the same `holdSec` table as the 3D shader, keyed on `(colIdx, rowIdx)`:
```js
const rowIdx   = floor(dist.add(0.5));
const cellId   = vec2(colIdx, rowIdx);
const holdRand = float(0.45).add(h2(cellId.mul(0.29)).mul(7.15));
const isHead   = dist.lessThan(1.0);
const isNear   = dist.lessThan(4.0);
const holdSec  = select(isHead, float(0.067),
  select(isNear,
    float(2.0).add(holdRand.mul(0.3)),
    float(10.0).add(holdRand.mul(2.0))
  )
);
const changeTick = floor(h2(cellId.mul(0.37)).mul(holdSec).add(uTime2D).div(holdSec));
```

### Glyph selection and atlas sampling

Direct port of the 3D glyph selection logic. Uses `cellId` and `changeTick` already
computed in the flicker rates section above — no re-declaration needed:

```js
// cellId, changeTick already defined in the flicker section above
const stability   = h2(cellId.mul(0.91));
const baseGlyph   = floor(h2(cellId.mul(0.47).add(0.5)).mul(uGlyphCount2D));
const mutGlyph    = floor(
  h2(cellId.mul(0.37).add(changeTick.mul(vec2(0.11, 0.07)))).mul(uGlyphCount2D)
);
const isDeepTrail = dist.greaterThanEqual(halfDist);
const glyphIdx    = select(
  isDeepTrail.or(stability.lessThan(0.30)),
  baseGlyph,
  mutGlyph
);
```

`baseGlyph` is static per cell — used for deep-trail (settled) cells and the ~30 %
of cells that are "stable" regardless of position. `mutGlyph` changes each `holdSec`
tick. `glyphIdx` ∈ `[0, uGlyphCount2D)`.

Glyph UV derived from `glyphIdx`:

### Film-accurate two-stage colour ramp

Direct port of the 3D SPEC-3d-accuracy colour ramp:
```js
const headFrac      = float(1).sub(smoothstep(0.0, 0.8, dist));
const normDist      = dist.div(halfDist);
const deepTrailFrac = smoothstep(0.5, 1.0, normDist);
const deepTrailCol  = uColor2D.mul(0.18);
const trailCol      = mix(uColor2D.mul(1.6), deepTrailCol, deepTrailFrac);
const col           = mix(trailCol, uColor2D.mul(3.0).add(vec3(0.3)), headFrac);
```

### Alpha compositing

```js
// Cell UV within glyph quad: U = X within column, V = Y relative to head
const cellU = fract(uv.x.mul(nCols));
const cellV = fract(headY_uv.sub(uv.y).negate().div(cellH_uv));
```

MSDF sampling: export `sampleGlyph` from `matrix-rain-tsl.js` alongside `h2`, or
duplicate it in `matrix-rain-2d-tsl.js`. The full implementation is in
`matrix-rain-tsl.js` in `buildGlyphMaterial` — port the `sampleGlyph` Fn and its
`median3` helper directly. The call site:

```js
// glyphCol/glyphRow = grid position for glyphIdx
const glyphCol  = mod(glyphIdx, uAtlasGridW2D);
const glyphRow  = floor(glyphIdx.div(uAtlasGridW2D));
const glyphBase = vec2(glyphCol, glyphRow).div(vec2(uAtlasGridW2D, uAtlasGridH2D));
const glyphUV   = glyphBase.add(vec2(cellU, cellV).div(vec2(uAtlasGridW2D, uAtlasGridH2D)));
// sampleGlyph applies the MSDF alpha formula (median3 + smoothstep threshold):
const msdfAlpha = sampleGlyph(uGlyphTex2D, glyphUV);

return vec4(col.mul(msdfAlpha).mul(trailAtt).mul(uGlobalAlpha2D).mul(uBrightness2D).mul(isActive), 1.0);
```

---

## Multi-layer compositing

Three `buildMatrix2DColorNode` instances with different params, composited additively.
More rows = smaller cells = background; fewer rows = larger cells = foreground:

| Layer | `uNRows2D` | `speedMax` | `uBrightness2D` | `uCellAspect2D` | Layer offset |
|---|---|---|---|---|---|
| Background | 40 | 2.5 | 0.35 | 0.45 | `colIdx + 0` |
| Midground  | 30 | 5.0 | 0.70 | 0.50 | `colIdx + 1000` |
| Foreground | 20 | 8.0 | 1.00 | 0.55 | `colIdx + 2000` |

When `initMatrix2DRain` is called with `opts.layers: true`, build three materials and
composite with `add()`. The layer offset is added to `colIdx` **globally at the top of the
shader** (before any hash call): `const effectiveColIdx = colIdx.add(float(layerOffset))`.
Use `effectiveColIdx` in place of `colIdx` for every hash and computation in that layer's
node. The offsets are integer constants — any three sufficiently different values work.

---

## Handle API

```js
handle.setColor(hex)
handle.setOpacity(v)
handle.setSpeed(v)           // sets uSpeedMul2D
handle.setBrightness(v)      // sets uBrightness2D
handle.setCharSet(name)      // hot-swap atlas (async, same pattern as 3D)
handle.destroy()
```

No post-processing handle methods — the 2D component has no built-in post-processing.
Consumer is expected to wire it into the existing 3D PostProcessing graph via CRT bridge
or use standalone.

---

## CRT bridge integration

`setSourceNode` is a public method on the CRT handle returned by `buildCRTNodesFromSource`
(confirmed at `matrix-rain-webgpu.js:518`):

```js
const { buildMatrix2DColorNode, makeUniforms2D } = await import('./matrix-rain-2d-tsl.js');
const u2d      = makeUniforms2D({ color: '#00ff41' });
const rainNode = buildMatrix2DColorNode(u2d);
// Wire into CRT handle:
crtHandle.setSourceNode(rainNode);
```

`buildMatrix2DColorNode` returns a TSL node that accepts `screenUV` internally, suitable
as a PostProcessing source. Update `uTime2D` in the external RAF loop.

---

## Files Changed

| File | Change |
|---|---|
| `matrix-rain-tsl.js` | Export `h2` and `sampleGlyph` (+ `median3`) as module-level exports |
| `matrix-rain-2d-tsl.js` | **New file** — full 2D analytical rain TSL shader + handle |
| `demo-2d.html` | **New file** — standalone 2D demo with layer toggle, color, speed, char set controls |

---

## Verification

1. **Colour ramp**: deep trail cells show dark green (not black), head burns white.
2. **Flicker**: head `holdSec = 0.067 s → 1/0.067 ≈ 15 Hz`; a mid-trail cell (`holdSec ≈ 10 s`)
   should change only 1–2 times over 10 s; a deep-trail cell is essentially static.
3. **Speed distribution**: clearly some columns are 3–5× faster than others — persistent
   "streakers" visible at all times, not just during burst surges.
4. **Breathing**: a medium-speed column oscillates ±15 % over 2–10 s.
5. **Traveling wave**: watching for 30 s, a wave of density sweeps left-to-right (~60 s period).
6. **Clustering**: some screen-X bands are denser than their neighbours (~60 s cycle).
7. **Multi-layer** (`layers: true`): background layer (40 rows) has visibly smaller glyphs
   than the foreground layer (20 rows). Foreground cell height is 2× that of background;
   foreground cell width is ~2.4× (also scales with aspect ratio: 0.55 vs 0.45). The three
   layers should be perceptibly distinct in cell size and brightness.
8. **CRT integration**: `buildMatrix2DColorNode` feeding into `crtHandle.setSourceNode`
   produces a flat-screen rain aesthetic — scanlines and CRT curvature overlay correctly
   on the 2D rain.
