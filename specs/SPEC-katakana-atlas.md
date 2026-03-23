# SPEC-katakana-atlas

**Status**: Implemented
**Priority**: P0 — blocks SPEC-matrix-rain-canvas and SPEC-matrix-rain-webgpu
**Reference**: `specs/matrix-rain-analysis.md` §2 "Visual & Typographic Anatomy"

---

## Motivation

The current library ships one atlas: `data/matrixcode_msdf.png` — 512×512 MSDF, 8×8 grid,
48 glyphs. This is a solid foundation but has two gaps:

1. **Character set is undocumented.** No manifest exists for which glyphs are in the atlas
   or how they map to grid slots. This makes it hard to reason about correctness or extend
   the set.

2. **Single set only.** Different use-cases want different characters: the authentic 1999
   film set, the existing matrixcode set, Latin, ASCII. The shader and API have no mechanism
   to switch between them at runtime.

This spec adds a formal glyph inventory, a bitmap atlas generation tool for sets that the
canvas-2D renderer needs, and a runtime `charSet` API backed by a small shader fix that
removes the square-grid assumption.

---

## Existing Assets

| File | Format | Grid | Slots | Used | Notes |
|---|---|---|---|---|---|
| `data/matrixcode_msdf.png` | MSDF (3-channel SDF) | 8×8 | 64 | 48 | Katakana + custom symbols |

The MSDF format is ideal for the WebGPU path (anti-aliased at any scale). It is **not**
suitable for canvas 2D (which needs plain RGBA pixel data), so the canvas rain path needs
its own bitmap atlas generated from the same glyph definitions.

---

## Glyph Sets

Four named sets. Each set is defined by a glyph list in `data/glyph-sets.js` (see §
Implementation). The atlas tool and the shader consume the same definition.

### `'matrixcode'` — current default, 48 glyphs

The existing `data/matrixcode_msdf.png`. A manifest file
`data/matrixcode-glyph-manifest.json` will be created by inspecting the atlas (see Task 1).
Grid: 8×8. `uGlyphCount = 48`, `uAtlasGridW = uAtlasGridH = 8`.

This set is untouched by this spec; we only document it.

### `'matrix1999'` — film-accurate, 64 glyphs

Sources: `specs/matrix-rain-analysis.md` §2.

- **~46 half-width katakana** (U+FF65–U+FF9F), with ~15 mirrored horizontally
- **10 Arabic numerals** (0–9)
- **~8 custom/modified glyphs**: ψ-like, Ω-like, mirrored-Z, rotated-T, and 4 others
  approximated from film-frame analysis in the research document

Total: **64 glyphs**. Fills an 8×8 grid (64 slots) exactly.
`uGlyphCount = 64`, `uAtlasGridW = uAtlasGridH = 8`.

Mirrored glyphs are baked into the atlas as pre-flipped images — the shader does not need
to know which glyphs are mirrored.

Cell size in the generator: **64×64 px** per cell (matching existing atlas dimensions).
The 3:2 character aspect documented in the research (16×24 film-native pixels) is
reproduced by rendering glyphs at ~48 px font size centred within the 64×64 cell.
Atlas output: **512×512 px** (8 cols × 64 px = 512, 8 rows × 64 px = 512).

### `'latin'` — A–Z + 0–9, 36 glyphs

Western character aesthetic: 26 uppercase letters plus 10 digits. Fits in 8×8 (64 slots,
28 unused). `uGlyphCount = 36`, `uAtlasGridW = uAtlasGridH = 8`.

### `'ascii'` — all 95 printable ASCII chars (U+0020–U+007E)

Requires **10×10 grid** (100 slots, 5 unused). This is the only set that exceeds 64 glyphs
and requires the rectangular-grid shader fix described below.
`uGlyphCount = 95`, `uAtlasGridW = 10`, `uAtlasGridH = 10`.
Atlas output: **640×640 px** (10 × 64 px = 640).

---

## Shader Fix: Rectangular Grid Support

### Problem

In `matrix-rain-tsl.js`, `sampleGlyph` uses `uAtlasCols` for glyph-index decomposition and
`uAtlasGrid` for UV scaling. Both are always set to the same value (8) and both represent
"columns per row in the atlas grid" — they are redundant aliases. Replacing them with a
clearly named pair (`uAtlasGridW`, `uAtlasGridH`) removes the aliasing confusion and makes
non-square grids correct on the Y axis:

```js
// Current — uAtlasCols and uAtlasGrid are redundant aliases, both = 8
const col = mod(gIdx, uAtlasCols);
const row = floor(gIdx.div(uAtlasCols));
const atlasUV = vec2(
  col.add(su).div(uAtlasGrid),
  row.add(float(1).sub(faceUV.y)).div(uAtlasGrid),  // wrong for non-square grids
);
```

### Fix

Replace the pair (`uAtlasCols`, `uAtlasGrid`) with (`uAtlasGridW`, `uAtlasGridH`).
`uAtlasGridW` = columns per row; `uAtlasGridH` = total rows in the atlas.

**`makeUniforms()` in `matrix-rain-tsl.js`:**

```js
// Before:
uAtlasCols: uniform(8),
uAtlasGrid: uniform(8),

// After:
uAtlasGridW: uniform(8),   // columns in atlas grid
uAtlasGridH: uniform(8),   // rows in atlas grid
```

**`sampleGlyph` — all four references updated:**

```js
const col = mod(gIdx, uAtlasGridW);
const row = floor(gIdx.div(uAtlasGridW));
const atlasUV = vec2(
  col.add(su).div(uAtlasGridW),
  row.add(float(1).sub(faceUV.y)).div(uAtlasGridH),
);
```

**`buildGlyphMaterial` destructuring:**

```js
// Before:
const { uGlyphCount, uAtlasCols, uAtlasGrid, ... } = uniforms;

// After:
const { uGlyphCount, uAtlasGridW, uAtlasGridH, ... } = uniforms;
```

**`matrix-rain-webgpu.js` constants and assignments:**

```js
// Before:
const ATLAS_COLS = 8;
const ATLAS_GRID = 8;
uniforms.uAtlasCols.value = ATLAS_COLS;
uniforms.uAtlasGrid.value = ATLAS_GRID;

// After:
const ATLAS_GRID_W = 8;
const ATLAS_GRID_H = 8;
uniforms.uAtlasGridW.value = ATLAS_GRID_W;
uniforms.uAtlasGridH.value = ATLAS_GRID_H;
```

`uAtlasCols` and `uAtlasGrid` are **removed** (minor breaking change — both were internal).
For all square-grid sets `uAtlasGridW === uAtlasGridH` so behaviour is identical. The
`matrixcode` set continues to work with `W = H = 8`.

---

## `charSet` Runtime API

### `initMatrixRain` option

```js
initMatrixRain(el, {
  charSet: 'matrix1999',   // 'matrixcode' | 'matrix1999' | 'latin' | 'ascii'
  atlasPath: null,         // optional override: explicit path takes precedence over charSet
})
```

`charSet` maps to a pre-built atlas path and grid dimensions in `CHAR_SETS` (see below). If
`atlasPath` is provided explicitly it takes precedence; in that case `uGlyphCount`,
`uAtlasGridW`, and `uAtlasGridH` must also be supplied as opts or they fall back to defaults
(8×8, 48 glyphs). Custom atlases outside the named sets are therefore supported via
`atlasPath` with explicit dimension opts.

### Handle method

```js
handle.setCharSet('ascii')   // hot-swap atlas + update uniforms at runtime
```

Implementation in `matrix-rain-webgpu.js`:

1. Look up the descriptor from `CHAR_SETS`. If the name is not found, log a warning and
   return without changes.
2. Use `THREE.TextureLoader().load(descriptor.path, onLoad)` with an `onLoad` callback so
   the swap only occurs once the PNG is fully decoded. Apply the same texture settings as
   `loadMSDF` inside the callback:

```js
new THREE.TextureLoader().load(descriptor.path, (newTex) => {
  newTex.flipY           = false;
  newTex.minFilter       = THREE.LinearMipMapLinearFilter;
  newTex.magFilter       = THREE.LinearFilter;
  newTex.colorSpace      = THREE.LinearSRGBColorSpace;
  newTex.generateMipmaps = true;
  newTex.needsUpdate     = true;

  s.atlasTex.dispose();
  s.atlasTex = newTex;
  s.atlasTexNode.value = newTex;   // hot-swap the TSL TextureNode (see Task 6)
  uniforms.uGlyphCount.value = descriptor.glyphCount;
  uniforms.uAtlasGridW.value = descriptor.gridW;
  uniforms.uAtlasGridH.value = descriptor.gridH;
});
```

3. `s.atlasTexNode` is a reference to the TSL `TextureNode` created by the
   `texture(atlasTexture, atlasUV)` call inside `sampleGlyph` in `buildGlyphMaterial`.
   Task 6 requires this node to be returned from (or stored via) `buildGlyphMaterial` and
   saved in the state object `s`. Setting `node.value = newTex` hot-swaps the texture
   without rebuilding the material or post-processing graph.

### `CHAR_SETS` descriptor table (internal, `matrix-rain-webgpu.js`)

```js
const CHAR_SETS = {
  matrixcode: { path: '/data/matrixcode_msdf.png', glyphCount: 48, gridW: 8,  gridH: 8  },
  matrix1999: { path: '/data/matrix1999_msdf.png', glyphCount: 64, gridW: 8,  gridH: 8  },
  latin:      { path: '/data/latin_msdf.png',      glyphCount: 36, gridW: 8,  gridH: 8  },
  ascii:      { path: '/data/ascii_msdf.png',      glyphCount: 95, gridW: 10, gridH: 10 },
};
```

For the canvas-2D rain path (SPEC-matrix-rain-canvas), the same set names map to bitmap
(non-MSDF) atlases at `data/<name>_bitmap.png`. The canvas renderer uses `drawImage` slices
from these rather than MSDF sampling.

---

## Atlas Generation Tool

**File**: `tools/gen-atlas.html`

A standalone browser tool (no npm). Renders a selected glyph set to a canvas, exports the
atlas as a downloadable PNG.

### UI

- Dropdown: `charSet` selector (`matrixcode` excluded — its atlas pre-exists)
- Output format: **MSDF-approx** (single-channel SDF, for WebGPU path) | **Bitmap** (for
  canvas path)
- Cell size: 64×64 px (fixed, matching existing atlas)
- Preview: renders all cells in a grid
- Export button: `canvas.toBlob()` → download link

### MSDF-approx generation

True MSDF (multi-channel SDF) generation requires a signed-distance field computation with
multi-channel corner-preservation per glyph. Options:

1. **`msdf-atlas-gen` via WASM** — preferred for accuracy. This is a **dev-tool-only
   dependency** (used exclusively in `tools/gen-atlas.html`, never in the runtime library),
   so it does not violate the zero-external-runtime-dependencies rule.
2. **Approximate single-channel SDF**: render each glyph to an offscreen canvas, run a JS
   distance-field pass, write the scalar SDF value into all three RGB channels. The
   `median3(r, g, b)` call in `sampleGlyph` degenerates to a single-channel SDF lookup —
   functional but corners may appear slightly rounded at extreme scale changes compared to
   true MSDF. Acceptable for the scale range used in this effect.

For the initial implementation use option 2. Add a `TODO` comment in the tool for option 1.

### Bitmap generation

Render each glyph with `ctx.fillText()` at ~48 px font size, white on black, onto a 64×64
cell canvas. Canvas 2D text rendering applies greyscale anti-aliasing regardless of the
`imageSmoothingEnabled` setting (that flag only affects `drawImage` scaling, not text
rasterisation). The greyscale-antialiased result is appropriate for the canvas rain path,
which reads luminance as alpha. For katakana: use system font `'monospace'` or embed a
small web font. For `matrix1999` custom glyphs: draw programmatically using path commands
from `data/glyph-sets.js` (see below).

---

## `data/glyph-sets.js`

Single source of truth for all sets **except `matrixcode`** (which pre-exists as a binary
atlas with no regeneration path in this spec). Exports:

```js
export const GLYPH_SETS = {
  matrix1999: {
    gridW: 8, gridH: 8,
    glyphs: [
      // { char, mirror: bool } for Unicode chars;
      // { path: [...commands] } for custom drawn glyphs.
      { char: 'ｦ', mirror: false },
      { char: 'ｱ', mirror: true },
      // ... ~46 katakana, ~15 with mirror: true
      { char: '0' }, { char: '1' }, /* ... */ { char: '9' },
      { path: PSI_PATH },    // ψ-like custom glyph
      { path: OMEGA_PATH },  // Ω-like
      { path: MIRZ_PATH },   // mirrored Z
      { path: ROTT_PATH },   // rotated T
      // ... remaining custom glyphs to fill 64 slots
    ],
  },
  latin: {
    gridW: 8, gridH: 8,
    glyphs: [ /* A–Z (26) + 0–9 (10) = 36 glyphs */ ],
  },
  ascii: {
    gridW: 10, gridH: 10,
    glyphs: [ /* U+0020–U+007E, 95 glyphs */ ],
  },
};
```

Custom glyph paths use a simple micro-format: `['M', x, y]` (moveTo), `['L', x, y]`
(lineTo), `['C', cx1, cy1, cx2, cy2, x, y]` (bezierCurveTo), `['Z']` (closePath).
Coordinates are normalised 0–1 within the cell. The atlas tool renders them via:

```js
function drawPath(ctx, commands, cellW, cellH) {
  ctx.beginPath();
  for (const cmd of commands) {
    switch (cmd[0]) {
      case 'M': ctx.moveTo(cmd[1] * cellW, cmd[2] * cellH); break;
      case 'L': ctx.lineTo(cmd[1] * cellW, cmd[2] * cellH); break;
      case 'C': ctx.bezierCurveTo(
        cmd[1] * cellW, cmd[2] * cellH,
        cmd[3] * cellW, cmd[4] * cellH,
        cmd[5] * cellW, cmd[6] * cellH); break;
      case 'Z': ctx.closePath(); break;
    }
  }
  ctx.fill();
}
```

---

## Tasks

1. **Inventory existing atlas** — visually inspect `data/matrixcode_msdf.png`, document
   which glyphs occupy which grid slots, write `data/matrixcode-glyph-manifest.json`.
   *(No dependencies.)*

2. **Shader fix** — replace `uAtlasCols` + `uAtlasGrid` with `uAtlasGridW` + `uAtlasGridH`
   in `matrix-rain-tsl.js` (`makeUniforms`, `buildGlyphMaterial` destructuring, all four
   references in `sampleGlyph`) and `matrix-rain-webgpu.js` (constants, uniform
   assignments). Update unit tests. *(No dependencies.)*

3. **`data/glyph-sets.js`** — define `matrix1999`, `latin`, `ascii` sets including custom
   glyph path arrays. *(No dependencies.)*

4. **`tools/gen-atlas.html`** — build the generator tool; export both MSDF-approx and
   bitmap variants. *(Depends on Task 3.)*

5. **Generate and commit atlases** — run the tool, export and commit:
   - `data/matrix1999_msdf.png`, `data/matrix1999_bitmap.png`
   - `data/latin_msdf.png`, `data/latin_bitmap.png`
   - `data/ascii_msdf.png`, `data/ascii_bitmap.png`
   *(Depends on Task 4.)*

6. **Runtime API** — add `CHAR_SETS` lookup, `charSet` init option, `setCharSet()` handle
   method in `matrix-rain-webgpu.js`. Return (or store in state) the TSL `TextureNode`
   from `buildGlyphMaterial` to enable texture hot-swap without material rebuild.
   *(Depends on Task 2.)*

7. **Demo wiring** — add a charSet dropdown to `demo.html`. *(Depends on Tasks 5 and 6.)*

---

## Out of Scope

- True multi-channel MSDF generation (msdf-atlas-gen WASM) — tracked as a TODO in the
  tool's source.
- Sub-pixel hinting or font-hinting tuning.
- Right-to-left or vertical text layout.
- Dynamic glyph addition at runtime.
- Lowercase letters in the `latin` set (can be added as a separate set variant later).
