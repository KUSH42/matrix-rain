# SPEC — MTSDF rendering stabilization

**Status**: Draft
**Target files**: `matrix-rain-tsl.js`, `matrix-rain-2d-tsl.js`,
`matrix-rain-webgpu.js`, `matrix-rain-glyphs.js`
**Optional target**: `matrix-rain-geometry.js` if atlas loading is centralized

---

## Overview

This spec defines a cleanup pass for the project's MSDF and MTSDF glyph
rendering. The current pipeline is functional, but it is not a robust MTSDF
implementation. Small or camera-moving glyphs can shimmer, and complex shapes
such as `E` and `R` are especially vulnerable.

The goal is to stabilize glyph edges without losing the current look. The
project keeps its existing atlas format and visual style, but it stops relying
on derivative-of-sampled-value heuristics and removes texture settings that are
unsafe for distance fields.

---

## Problem summary

The current implementation has several separate sources of instability. They
combine into visible flicker during camera motion, minification, and parallax.

### 3D path

The 3D renderer in `matrix-rain-tsl.js` does decode the RGB median correctly,
and it disables mipmaps on the atlas texture. That part is sound. The unstable
parts are downstream:

- The final anti-alias width is derived from `dFdx/dFdy` of the sampled glyph
  value, not from a proper screen-pixel distance range.
- The code switches between RGB MSDF and alpha SDF using a heuristic based on
  `vUvRain`, which is only an approximation of screen size.
- POM shifts the sample UV before the final mask evaluation, which creates
  unstable interior edges on complex glyphs.

### 2D path

The 2D renderer in `matrix-rain-2d-tsl.js` currently enables mipmaps for MSDF
atlases. That is unsafe for MSDF and MTSDF data because the generated lower mip
levels no longer encode a valid signed distance field.

The 2D path also uses a fixed threshold band:

- `smoothstep(0.48, 0.52, med)`

That is simple, but it is not scale-aware. It does not create the same screen-
space stability target as a proper derivative-based distance-field decode.

### Result

These issues show up as:

- Edge shimmer on thin strokes.
- Interior counter flicker on glyphs like `E`, `R`, `K`, and `B`.
- Shape instability when glyphs become small on screen.
- Different behavior between the 2D and 3D paths for the same atlas.

---

## Requirements

This change set must make the glyph renderer more technically correct without
changing the atlas format or removing the current art direction.

### Functional requirements

- The 2D and 3D paths must both treat MSDF and MTSDF atlases as non-mipmapped
  distance fields.
- Atlas descriptors must explicitly provide the metadata required for decode,
  including field mode and pixel range.
- The final glyph mask must be based on a screen-pixel-range decode, not on
  derivatives of an already-sampled scalar field.
- Tiny glyphs may still fall back to alpha SDF, but the transition must be
  predictable and not oscillate frame to frame.
- Lock-head message glyphs must remain stable even when other visual effects
  are active.

### Non-goals

This spec does not change:

- Atlas generation tooling.
- Glyph set contents.
- Message reveal logic.
- The post-processing stack.
- Arbitrary user-supplied atlases without metadata support beyond a documented
  compatibility path. If `atlasPath` remains supported, the caller must provide
  decode metadata or accept a documented compatibility fallback.

---

## Design

The implementation is split into four parts. Each part addresses a different
failure mode in the current renderer.

### 1. Add explicit atlas metadata

The current renderer infers too much from char set names and one-off defaults.
That is good enough for a prototype, but not for a stable MTSDF pipeline.

Each atlas descriptor must explicitly define:

- field mode: at minimum enough information to distinguish:
  - compatibility path for legacy handling
  - RGB MSDF path
  - RGB-plus-alpha MTSDF path
- atlas pixel range used at generation time
- grid width and height
- glyph count

This metadata must be available to both the 2D and 3D renderers, including
runtime atlas swaps.

One acceptable descriptor shape is:

```js
{
  path,
  glyphCount,
  gridW,
  gridH,
  fieldMode: 'compat' | 'msdf' | 'mtsdf',
  pxRange,
}
```

The exact property names are not important. The presence of equivalent data is.

### 2. Fix texture setup for 2D atlases

The 2D atlas loader must match the 3D loader's distance-field-safe settings.
All MTSDF and MSDF atlases must use:

- `LinearFilter` for minification.
- `LinearFilter` for magnification.
- `generateMipmaps = false`.

This applies to:

- initial atlas load
- runtime atlas swaps
- helper builders that create a 2D renderer from a char set descriptor

The 2D loader must not use `LinearMipMapLinearFilter`.

This part only fixes the texture setup. The 2D path's thresholding behavior is
addressed separately under decode correctness.

### 3. Replace mask AA with a proper screen-pixel-range decode

The final glyph mask in `matrix-rain-tsl.js` must stop using:

- `fw = abs(dFdx(sdfG)) + abs(dFdy(sdfG))`

for the final threshold width.

Instead, the shader must compute anti-alias width from the atlas-space UV
gradient and a fixed atlas pixel range.

The intended model is:

1. Sample the atlas and decode the signed distance value.
2. Compute how many screen pixels correspond to one atlas-distance unit using
   the local UV derivatives.
3. Convert the stored distance to a screen-space threshold width.
4. Apply `smoothstep()` around `0.5` using that width.

This is the standard MSDF and MTSDF approach and is less sensitive to camera
motion than taking derivatives of the already-decoded sample value.

Important distinction: this change applies to the final anti-aliased threshold
operations. It does not require rewriting the full POM march. The POM march may
continue to compare decoded values internally, but the final visible mask and
visible fringe masks must use the new screen-pixel-range decode.

### 4. Reduce unstable UV perturbation for small glyphs

The 3D path currently applies POM before final mask evaluation. That makes the
glyph surface more interesting, but it also destabilizes letters with enclosed
spaces and hard corners.

The renderer must clamp effect intensity when the glyph becomes too small.

Required behavior:

- For locked message head glyphs, keep the existing `pomDepth = 0` rule.
- For any glyph below a configurable on-screen size threshold, also reduce or
  disable POM.
- The same tiny-glyph threshold must drive the MSDF-to-alpha-SDF fallback, so
  both decisions respond to the same screen-size signal.

---

## Implementation details

This section describes the concrete code changes expected from the spec.

### `matrix-rain-2d-tsl.js`

The 2D loader must be brought in line with the 3D loader.

Required edits:

- Change atlas `minFilter` from `LinearMipMapLinearFilter` to `LinearFilter`.
- Set `generateMipmaps = false`.
- Preserve `magFilter = LinearFilter`.
- Apply the same texture policy to any runtime atlas swap path.
- Stop duplicating implicit atlas assumptions. Descriptor-driven metadata must
  be used here too.

The 2D glyph mask logic also needs to stop relying on a fixed threshold band
for distance-field atlases. Once metadata exists, the 2D path must either:

- adopt the same screen-pixel-range decode model as the 3D path, or
- document and intentionally keep a simpler decode path with known quality
  tradeoffs

The preferred direction is to unify decode behavior across 2D and 3D.

### `matrix-rain-glyphs.js`

This file should either become the source of truth for glyph atlas metadata or
be replaced by a new shared descriptor module consumed by both renderers.

Required edits:

- Extend glyph descriptors to include field mode and pixel range.
- Remove name-based assumptions where possible.
- Expose enough metadata for both the 2D and 3D paths to configure:
  - texture setup
  - decode mode uniforms
  - screen-pixel-range decode
  - tiny-glyph fallback behavior

Because `matrix-rain-2d-tsl.js` currently has its own atlas descriptor table,
this spec must not assume that editing `matrix-rain-glyphs.js` alone is
sufficient. The implementation must either:

- import shared descriptors into the 2D path, or
- keep both tables synchronized explicitly as part of the change

The same metadata rules must also cover explicit `atlasPath` loads. The current
renderer falls back to guessed compatibility behavior when metadata is unknown.
This spec requires one of these outcomes:

- `atlasPath` accepts explicit metadata parameters, or
- `atlasPath` is documented as compatibility-only, or
- `atlasPath` is rejected for decode modes that require missing metadata

### `matrix-rain-geometry.js`

This file already contains the correct 3D atlas loader policy. No behavioral
change is required here unless the loader logic is later centralized.

If the loader is unified, this file becomes the single source of truth for
distance-field texture setup.

### `matrix-rain-tsl.js`

The fragment shader must be updated in three places.

#### Add explicit atlas range inputs

The shader needs a declared distance-field pixel range and field mode instead
of relying on sample-value derivatives and name-based assumptions. This can be:

- a uniform, if atlases may vary in range
- a shared constant, if all generated atlases use the same range

The preferred approach is a uniform so the renderer can stay atlas-aware.

The current binary `uAtlasMTSDF` toggle is not expressive enough if the
renderer needs to distinguish between:

- compatibility handling
- pure RGB MSDF decode
- RGB-plus-alpha MTSDF decode with tiny-glyph alpha fallback

This does not require immediate removal of `uAtlasMTSDF`. A staged migration is
acceptable if:

- the new metadata-driven controls become authoritative
- `uAtlasMTSDF` becomes a compatibility layer or derived value
- name-based branching is removed from runtime selection

#### Replace final mask AA

The current final mask logic:

```js
const sdfG = sampleGlyph(spinFace, glyphIdx, useSDF);
const fw   = abs(dFdx(sdfG)).add(abs(dFdy(sdfG))).mul(0.7);
const mask = smoothstep(float(0.5).sub(fw), float(0.5).add(fw), sdfG);
```

must be replaced with a decode based on UV derivatives and atlas range.

The same change must also be applied to the chromatic aberration mask samples
and any other path that thresholds `sampleGlyph(...)` directly.

The same principle applies to the simpler message-column material path if it is
ever revived. This spec should not leave a second threshold implementation
behind with different edge behavior.

The decode helper must remain outside non-uniform control flow that forbids
derivatives. In practice that means:

- derivative-dependent AA width must be computed in uniform control flow
- the final threshold step must consume those precomputed values
- the POM march itself must not introduce new derivative calls inside the loop

The tiny-glyph selector also needs cleanup. The current code uses:

```js
const screenPx = float(1).div(abs(dFdx(vUvRain.x)).add(abs(dFdy(vUvRain.x))));
```

That is only a rough proxy for on-screen glyph size. The replacement must use a
more stable local screen-size estimate that is shared with the tiny-glyph POM
gate.

#### Gate POM for tiny glyphs

The current code already disables POM for locked message head glyphs. Extend
that rule so tiny glyphs also reduce or disable POM.

The chosen tiny-glyph signal must be stable. It must not oscillate visibly
around the threshold during small camera movements.

### `matrix-rain-webgpu.js`

This file must supply any new uniforms required by the shader, for example:

- atlas distance-field pixel range
- field mode or equivalent decode controls
- tiny-glyph threshold values
- optional POM clamp thresholds

If the renderer supports runtime char set swaps across atlases with different
generation parameters, those parameters must update together with the atlas.

This file also owns the current `atlasPath` compatibility behavior. The
implementation must make that path explicit instead of silently guessing decode
mode from missing metadata.

If `atlasPath` keeps a compatibility fallback, the fallback behavior must be
defined in code comments and user-facing documentation rather than inferred from
char set names.

---

## Acceptance criteria

This change is complete when the following are true.

### Visual criteria

- `E` and `R` no longer shimmer noticeably during ordinary camera motion.
- Tiny rain glyphs do not show color-fringed edge crawl.
- Locked message glyphs remain visually stable.
- 2D and 3D renderers behave consistently for the same atlas family.
- Runtime char set swaps do not silently reuse stale decode parameters.
- Explicit `atlasPath` loads either render correctly with supplied metadata or
  fail in a documented, deterministic way.

### Technical criteria

- No MTSDF or MSDF atlas path uses generated mipmaps.
- Atlas descriptors explicitly provide the metadata required for decode.
- The renderer no longer depends on char set names such as `matrixcode` to pick
  decode behavior.
- Final edge AA is computed from screen-pixel-range decode, not sampled-value
  derivatives.
- The 2D path no longer relies on mipmapped distance fields or an undocumented
  fixed-threshold shortcut for atlases that claim MSDF or MTSDF behavior.
- POM is suppressed or reduced for tiny glyphs.
- The implementation still supports legacy non-MTSDF atlases through the
  existing compatibility path.

---

## Testing plan

This change needs direct visual testing because the failure mode is temporal.

### Manual checks

Test these cases in both 2D and 3D:

1. Load a glyph set with Latin characters and watch `E`, `R`, `K`, and `B`.
2. Orbit the camera slowly and look for interior-edge shimmer.
3. Move far enough away for small glyph minification.
4. Trigger message reveal and verify locked characters remain stable.
5. Swap char sets at runtime and verify the atlas settings remain correct.
6. Verify that legacy `matrixcode` still renders through the compatibility
   path.

### Regression checks

Verify that:

- glyph sharpness at medium and large sizes is preserved
- the CRT and holo post effects still work
- the WebGL fallback path still renders the same glyph masks

---

## Next steps

After this spec is approved, implement the change in this order:

1. Fix the 2D atlas mipmap policy.
2. Add explicit atlas metadata and wire it into both renderers.
3. Add explicit distance-field range inputs to the 3D shader.
4. Replace final AA thresholding with screen-pixel-range decode.
5. Clamp POM on tiny glyphs.
