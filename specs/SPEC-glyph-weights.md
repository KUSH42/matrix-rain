# SPEC-glyph-weights — Weighted glyph sampling

**Status**: Implemented
**Priority**: Low
**Reference**: `specs/AUDIT-analysis-vs-code.md` §3.5

---

## Motivation

Glyph selection is currently `floor(hash * uGlyphCount)` — uniform over all glyphs.
The film visibly favours katakana with dense vertical strokes (e.g. ﾆ ﾊ ﾃ ﾁ ﾘ ﾛ) and
rarely shows sparse ones (ｦ ﾟ ｰ). Weighting glyph selection toward stroke-dense characters
thickens the rain's visual texture and makes it closer to film reference.

---

## Design: 256-sample remapping LUT, always active

A 256-sample 1D `DataTexture` (`uGlyphWeightLUT`) stores precomputed glyph indices.
Each texel `i` holds the atlas index to use when `hash ∈ [i/256, (i+1)/256)`.
The LUT is the inverse CDF of the desired weight distribution.

The LUT is **always uploaded** — for charsets with `null` weights (uniform), a uniform
identity LUT is built. This eliminates the need for a flag uniform and the `texture(null)`
problem: the uniform node always has a valid texture.

In the shader, replace:
```js
const glyphRaw = floor(glyphHash.mul(uGlyphCount));
```
with:
```js
const glyphRaw = texture(uGlyphWeightLUT, vec2(glyphHash, 0.5)).r.mul(255.0).floor();
```

The texture stores normalised values `index / 255` in a single red channel (`RedFormat`,
`UnsignedByteType`), so `sample.r × 255` recovers the integer glyph index.

---

## Implementation

### 1. Weight table definitions (`matrix-rain-webgpu.js`)

Add a `GLYPH_WEIGHTS` map alongside `CHAR_SETS`. `null` → build a uniform-distribution LUT.

```js
// Per-glyph relative weights — higher = appears more often.
// Ordering matches the atlas left-to-right, top-to-bottom.
// null = uniform (identity LUT built automatically).
const GLYPH_WEIGHTS = {
  // matrix1999: 64 half-width katakana in atlas row order.
  // Rows 0–1 (ｦ–ｯ): mostly vowels/sparse — downweight.
  // Rows 2–5 (ﾀ–ﾜ): dense consonant forms — upweight.
  // Rows 6–7 (ﾝ–custom symbols): mixed.
  matrix1999: [
    0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4,  // ｦ ｧ ｨ ｩ ｪ ｫ ｬ ｭ
    0.4, 0.4, 0.4, 0.4, 0.6, 0.6, 0.6, 0.6,  // ｮ ｯ ｰ ｱ ｲ ｳ ｴ ｵ
    1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5,  // ｶ ｷ ｸ ｹ ｺ ｻ ｼ ｽ
    1.5, 1.5, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0,  // ｾ ｿ ﾀ ﾁ ﾂ ﾃ ﾄ ﾅ
    2.0, 2.0, 2.0, 2.0, 1.5, 1.5, 1.5, 1.5,  // ﾆ ﾇ ﾈ ﾉ ﾊ ﾋ ﾌ ﾍ
    1.5, 1.5, 2.0, 2.0, 2.0, 2.0, 1.5, 1.5,  // ﾎ ﾏ ﾐ ﾑ ﾒ ﾓ ﾔ ﾕ
    1.5, 1.5, 1.5, 2.0, 2.0, 2.0, 1.5, 1.5,  // ﾖ ﾗ ﾘ ﾙ ﾚ ﾛ ﾜ ﾝ
    0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8,  // ﾞ ﾟ + custom path glyphs
  ],
  matrixcode: null,   // uniform — pending glyph manifest review
  latin:      null,   // uniform — alpha-numeric strokes are similar density
  ascii:      null,   // uniform
};
```

### 2. LUT builder function (`matrix-rain-webgpu.js`)

```js
function buildGlyphWeightLUT(weights, glyphCount) {
  const lut = new Uint8Array(256);
  if (!weights) {
    // Uniform identity mapping
    for (let i = 0; i < 256; i++) lut[i] = Math.floor(i * glyphCount / 256);
  } else {
    // Weighted inverse-CDF
    const total = weights.reduce((a, b) => a + b, 0);
    const pdf   = weights.map(w => w / total);
    let cumul = 0, glyphIdx = 0;
    for (let i = 0; i < 256; i++) {
      const target = (i + 0.5) / 256;
      while (glyphIdx < glyphCount - 1 && cumul + pdf[glyphIdx] < target) {
        cumul += pdf[glyphIdx++];
      }
      lut[i] = glyphIdx;
    }
  }
  const tex = new THREE.DataTexture(lut, 256, 1, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
```

### 3. Uniform wiring (`matrix-rain-tsl.js`)

**`makeUniforms`**: replace the existing glyph-count uniform approach. The placeholder texture
is built once at module load time (uniform identity, 64-glyph default) and replaced on init:

```js
// At module level in matrix-rain-webgpu.js (near other module-level init).
// buildGlyphWeightLUT is declared with `function` so it is hoisted and available here.
// (placeholder built here; actual LUT uploaded in initMatrixRain after atlas loads)
const _placeholderLUT = buildGlyphWeightLUT(null, 64);

// In makeUniforms (matrix-rain-tsl.js):
uGlyphWeightLUT: texture(_placeholderLUT),
```

**Glyph selection node** (`matrix-rain-tsl.js`, inside the fragment `Fn`): replace the
existing `floor(glyphHash.mul(...))` expression for `baseGlyph` and `mutGlyph` with LUT
sampling. Since both use the same sampling pattern, define a helper:

```js
// Before (two occurrences):
const baseGlyph = floor(h2(cellId.mul(0.47).add(0.5)).mul(uGlyphCount));
const mutGlyph  = floor(h2(cellId.mul(0.37).add(changeTick.mul(vec2(0.11, 0.07)))).mul(uGlyphCount));

// After:
const baseGlyph = texture(uGlyphWeightLUT, vec2(h2(cellId.mul(0.47).add(0.5)), 0.5)).r.mul(255.0).floor();
const mutGlyph  = texture(uGlyphWeightLUT, vec2(h2(cellId.mul(0.37).add(changeTick.mul(vec2(0.11, 0.07)))), 0.5)).r.mul(255.0).floor();
```

Key corrections vs. earlier draft:
- Use `select()` or direct replacement instead of `If/Return` for value assignment in TSL
- Use `uGlyphCount` uniform node (not `float(uniforms.uGlyphCount.value)`)
- Use `.floor()` not `.round()` — the LUT stores exact integer values; rounding can produce
  an out-of-bounds index at the top of the range

### 4. Upload and hot-swap (`matrix-rain-webgpu.js`)

```js
function applyGlyphWeightLUT(charSet, uniforms) {
  const w     = GLYPH_WEIGHTS[charSet] ?? null;
  const count = CHAR_SETS[charSet].glyphCount;
  uniforms.uGlyphWeightLUT.value = buildGlyphWeightLUT(w, count);
}
```

**On init**: call `applyGlyphWeightLUT(charSet, uniforms)` after the initial material build
resolves (inside the `renderer.init().then()` callback, after `buildGlyphMaterial` returns).

**In `setCharSet()`**: call inside the atlas texture load callback — i.e., after the
`new THREE.TextureLoader().load(path, ...)` callback fires and `buildGlyphMaterial` is
re-called. This is critical: calling it in the synchronous path of `setCharSet` is too early
and the material won't have the new glyph count yet.

---

## Files Changed

| File | Change |
|---|---|
| `matrix-rain-webgpu.js` | Add `GLYPH_WEIGHTS`, `buildGlyphWeightLUT`, `_placeholderLUT`, `applyGlyphWeightLUT`; call on init and in `setCharSet` load callback |
| `matrix-rain-tsl.js` | Add `uGlyphWeightLUT` to `makeUniforms`; replace `baseGlyph`/`mutGlyph` expressions with LUT sampling |

No new handle methods. No `demo.html` changes.

---

## Verification

1. With `charSet: 'matrix1999'`, the rain should visibly favour denser katakana —
   fewer lone-dot or simple-stroke characters visible compared to uniform sampling.
2. Switch to `charSet: 'latin'` or `'ascii'` — glyph distribution is uniform (identity LUT).
3. Switch back to `matrix1999` from `ascii` via `setCharSet` — LUT re-uploads in load callback.
4. Atlas bounds: no black squares or out-of-range glyph reads (`.floor()` keeps indices safe).
5. No regressions in flicker, colour, speed, or glyph atlas sampling.

---

## Notes

- The `matrix1999` weight table is a reasonable first pass based on visual stroke density
  heuristics. It can be revised once there is a glyph manifest mapping indices to characters.
- `matrixcode` weights are left `null` (uniform) pending a proper glyph inventory review;
  the 56-glyph `matrixcode-glyph-manifest.json` could be used to assign weights later.
