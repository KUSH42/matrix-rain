# Progress

## Done

- [x] Project bootstrapped — `package.json`, `vitest.config.js`, `.gitignore`, `.npmignore`, `CLAUDE.md`
- [x] `data/matrixcode_msdf.png` — 512×512 MSDF glyph atlas (8×8 grid, Katakana + symbols) copied from source
- [x] `matrix-rain-tsl.js` — instanced glyph material (TSL vertex + fragment Fns)
  - `h2()` hash, `median3()` MSDF helper, `sampleGlyph()` atlas sampler
  - Vertex: boot cascade, burst cycle, head sweep, death fade, globe proximity, billboard, sway, Z-rotation, drip stretch, cull via `Return(vec4(2,2,2,1))`
  - Fragment: trail decay, globe occlusion, MSDF with POM (8+3 steps), chroma aberration, edge glow, globe pulse, normals+lighting, pre-multiplied alpha
  - Material: `MeshBasicNodeMaterial`, `CustomBlending/AddEquation/OneFactor`, `DoubleSide`, `toneMapped=false`
- [x] `matrix-rain-passes-tsl.js` — six TSL post-processing pass builders
  - `buildHeatPass` — UV warp from pixel brightness (shimmer around bright heads)
  - `buildPhosphorPass` — `max(current, prev * decay)` temporal persistence
  - `buildSoftenPass` — 4-sample radial blur, peripheral softening, alpha preserved
  - `buildStreakPass` — 3 drifting vertical lens streaks with shimmer
  - `buildHoloPass` — edge-weighted chroma aberration + scrolling scanlines + vignette
  - `buildGodRaysPass` — 80-sample radial crepuscular rays
- [x] `matrix-rain-webgpu.js` — public API, 9-stage PostProcessing pipeline, phosphor temporal feedback, resize handling, RAF ref pattern
  - Pipeline: scene → bloom → heat → phosphor → soften → streaks → holo → god rays → FXAA
  - `initMatrixRain(element, opts)` → handle with full control surface
  - `destroyMatrixRain(element)` — disposes renderer, geometry, textures, RT, observer
  - `animRef` pattern — cancelAnimationFrame always cancels the live frame ID
- [x] `demo.html` — standalone demo: controls panel (color, opacity, depth, normal, soften, heat, streaks, phosphor, god rays, burst bloom, globe, chroma), importmap `three@0.183.0`

- [x] **SPEC-katakana-atlas** — multi-set glyph atlas system
  - `data/matrixcode-glyph-manifest.json` — 56-glyph inventory of the existing atlas (full-width katakana + symbols)
  - `data/glyph-sets.js` — canonical set definitions: `matrix1999` (64 half-width katakana + numerals + 8 custom path glyphs), `latin` (36), `ascii` (95)
  - `tools/gen-atlas.html` — standalone browser tool: MSDF-approx (single-channel SDF) + bitmap output, SDF spread control, mirror support, per-glyph progress, PNG download
  - Shader fix: `uAtlasCols`+`uAtlasGrid` → `uAtlasGridW`+`uAtlasGridH` in `makeUniforms`, `buildGlyphMaterial` destructuring, `sampleGlyph` (4 refs), and `matrix-rain-webgpu.js` constants
  - Runtime API: `CHAR_SETS` table, `charSet` init opt, `handle.setCharSet(name)` (async material rebuild on atlas load)
  - `demo.html`: Char set dropdown wired to `setCharSet()`
  - Atlas PNGs generated via `tools/gen-atlas.html` (Playwright automation) and committed: `matrix1999_msdf.png` (21K), `matrix1999_bitmap.png` (14K), `latin_msdf.png` / `latin_bitmap.png` (7K each), `ascii_msdf.png` / `ascii_bitmap.png` (11K each)

- [x] **SPEC-matrix-presets** — named preset system
  - `matrix-rain-presets.js` — `PRESETS` table (default / matrix1999 / ghost / overdrive) + `applyPreset(name, handle)` helper
  - Four new handle methods: `setBloomThreshold(v)`, `setVignette(v)`, `setScanlines(v)`, `setHoloAberration(v)`
  - `handle.applyPreset(name)` — partial-field application; calls existing + new methods
  - `let handle` forward declaration so `renderer.init().then()` can apply a `preset` init option
  - `bloomThreshold` variable replaces hardcoded `0.20` in burst bloom logic; survives PP graph rebuilds
  - `demo.html`: preset dropdown with full UI sync, 4 new sliders (bloom threshold, vignette, scanlines, holo aberration)

## Backlog

All items go in `specs/` before implementation.

- [x] **SPEC-matrix-crt-integration** — single PostProcessing graph composing matrix-rain + telescreen-crt (Path C)
  - `matrix-rain-webgpu.js`: `externalLoop`, `buildNodes`, `tick`, `onResize`, `setGlobeInteract`, `currentRainNodes?.dispose()` resize leak fix, `scene`/`camera`/`renderer` getters
  - `matrix-rain-tsl.js`: `uGlobeInteract` uniform + globe proximity pulse
  - `telescreen-crt-webgpu.js`: `_tick`/`_postRender`/`_setSourceNode` internals; `buildCRTNodesFromSource` export; `_externalSource` mode
  - `matrix-rain-crt-bridge.js`: glue module (single RAF loop, ResizeObserver, re-entry guard, `pp.outputNode` swap on CRT rebuild)
  - `demo-crt.html`: standalone demo with rain + CRT + signal preset stacking

- [ ] Tests — `tests/` for any pure-JS logic extracted to a `matrix-rain-math.js`
- [ ] `prefers-reduced-motion` — disable/reduce heat, god rays, burst bloom
- [ ] README.md — public documentation before any npm/gh-pages publish
- [ ] `package.json` npm publish — subpath exports already wired
