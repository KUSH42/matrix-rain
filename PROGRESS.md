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

## Backlog

All items go in `specs/` before implementation.

- [ ] Tests — `tests/` for any pure-JS logic extracted to a `matrix-rain-math.js`
- [ ] `prefers-reduced-motion` — disable/reduce heat, god rays, burst bloom
- [ ] README.md — public documentation before any npm/gh-pages publish
- [ ] `package.json` npm publish — subpath exports already wired
