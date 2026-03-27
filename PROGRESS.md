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

- [x] **SPEC-webgl-fallback** — WebGL2 fallback support
  - `matrix-rain-webgpu.js`: TextureNode sampler patch at module preamble; `handle.backend` property (null → 'webgpu'|'webgl2'); `_isWebGPU` detection + `'matrixrain:ready'` CustomEvent dispatch inside `renderer.init().then()`
  - `matrix-3d.html`: `registerBadge()` helper + backend badge (bottom-right, low-opacity, reused on re-init)

## Backlog

All items go in `specs/` before implementation.

- [x] **SPEC-matrix-crt-integration** — single PostProcessing graph composing matrix-rain + telescreen-crt (Path C)
  - `matrix-rain-webgpu.js`: `externalLoop`, `buildNodes`, `tick`, `onResize`, `setGlobeInteract`, `currentRainNodes?.dispose()` resize leak fix, `scene`/`camera`/`renderer` getters
  - `matrix-rain-tsl.js`: `uGlobeInteract` uniform + globe proximity pulse
  - `telescreen-crt-webgpu.js`: `_tick`/`_postRender`/`_setSourceNode` internals; `buildCRTNodesFromSource` export; `_externalSource` mode
  - `matrix-rain-crt-bridge.js`: glue module (single RAF loop, ResizeObserver, re-entry guard, `pp.outputNode` swap on CRT rebuild)
  - `demo-crt.html`: standalone demo with rain + CRT + signal preset stacking

- [x] **SPEC-pp-mode** — `postProcessing` mode selector for `initMatrixRain`
  - `matrix-rain-webgpu.js`: renamed internal `let postProcessing` → `let pp` to avoid opt name collision; added `postProcessing` ('rain'|'crt'|'none') + `crtOpts` opts; `let pp_rainNodes`, `let crtHandle`; PP-pass method guards (`if (postProcessing !== 'rain') return`) on `setHeat`, `setSoften`, `setStreaks`, `setHoloAberration`, `setGodRays`, `setBurstBloom`, `setPhosphorDecay`, `setBloomThreshold`, `setBloomStrength`; `renderer.init().then()` branched into switch with async try/catch; `ro.observe` moved inside init callback; `animate()` extended with CRT tick + skipRender/newOutputNode handling, per-mode phosphor postRender + CRT postRender; CRT RTT resize detection; `handle.crt` getter; `_cleanup()` closure stored in state for `destroyMatrixRain`
  - `matrix-rain-crt-bridge.js`: replaced body with backward-compat shim delegating to `initMatrixRain({postProcessing:'crt'})` with `handle.rain = handle` self-reference
  - `demo.html`: PP mode dropdown (rain/crt/none diagnostic); mode-switch re-inits with current charSet, all other params reset; CRT sub-panel (initially hidden, shows when mode='crt') with shader dropdown; `updateCrtPanelVisibility` helper; CRT shader wired through `rain.crt?.setShader()`

- [x] **SPEC-3d-accuracy** — film-accurate 3D rain fixes
  - `matrix-rain-tsl.js`: position-based flicker rates (head ~15 Hz → near-head ~0.5 Hz → mid-trail ~0.1 Hz → deep-trail static, with burst override); two-stage colour ramp (dark-green floor `tintedColor×0.18` blending in past 50 % of `halfDist`)
  - `matrix-rain-webgpu.js`: speed range widened to `[1.2, 8.0]` c/s with `r²` log-bias (mode ≈ 1.2, median ≈ 2.9, mean ≈ 3.5)

- [x] **SPEC-3d-feel** — speed micro-oscillation + scale-R correlation
  - `matrix-rain-tsl.js`: per-column sinusoidal "breathing" `fv ∈ [0.1, 0.5]` Hz, ±15 % amplitude, derived from `aSeed` via `h2()` — multiplies into `speedMul` before burst factor
  - `matrix-rain-webgpu.js`: `scale` now linearly correlated with shell radius R — inner columns (R_MIN) scale ≈ [1.35, 1.55], outer (R_MAX) scale ≈ [0.40, 0.60], with ±0.1 jitter

- [x] **SPEC-traveling-waves** — inter-column phase correlation
  - `matrix-rain-tsl.js`: `thetaWave = atan(aWZ, aWX)`, `wavePhase = thetaWave × 3 + uTime × 0.15` (3 crests, ~42 s/revolution), `waveOffset = sin(wavePhase) × 4` (±4 world units) added to `cyclePos`
  - No new uniforms; wave parameters hardcoded per spec rationale

- [x] **SPEC-column-clustering** — angular cluster placement
  - `matrix-rain-webgpu.js`: `N_CLUSTERS = 12`; `_gaussRand()` Box-Muller helper; `clusterThetas` array inside `buildGeometry()` (per-instance random); `theta` now = random cluster center + σ=6° Gaussian jitter — 30° spacing, 6° visible gap between cluster bands

- [x] **SPEC-glyph-weights** — weighted glyph sampling
  - `matrix-rain-webgpu.js`: `GLYPH_WEIGHTS` map (matrix1999 64-entry weight table; others null/uniform); `buildGlyphWeightLUT(weights, glyphCount)` builds 256-sample inverse-CDF `DataTexture`; `applyGlyphWeightLUT(charSet, count, uniforms)` uploads LUT; called after init `buildGlyphMaterial` and inside `setCharSet` async callback
  - `matrix-rain-tsl.js`: `uGlyphWeightLUT` added to `makeUniforms()` (placeholder built inline if null); `baseGlyph`/`mutGlyph` now sampled via `texture(uGlyphWeightLUT, vec2(hash, 0.5)).r.mul(255.0).floor()`
  - `h2` and `median3` exported for 2D module use

- [x] **SPEC-2d-rain** — 2D flat fullscreen rain component
  - `matrix-rain-tsl.js`: `h2` and `median3` exported at module level
  - `matrix-rain-2d-tsl.js`: existing rich implementation (`makeRain2DUniforms`, `buildRain2DNode`, `init2DRain`, `destroy2DRain`, `LAYER_PRESETS`, `buildLayeredRain2DNode`) augmented with spec API aliases: `makeUniforms2D`, `buildMatrix2DColorNode`, `initMatrix2DRain`, `destroyMatrix2DRain`

- [x] **SPEC-demo-params** — port 2D organic controls to 3D demo
  - `matrix-rain-tsl.js`: 5 new uniforms (`uBrightness`, `uBreathAmt`, `uWaveSpeed`, `uWaveAmt`, `uWeightedGlyphs`); hardcoded breath amplitude 0.15 → `uBreathAmt.mul(0.15)`; wave speed/amount → uniforms; weighted glyph selection uses per-cell coin-flip `select` node (0=uniform, 1=LUT); final color multiplied by `uBrightness`
  - `matrix-rain-webgpu.js`: 6 new handle methods (`setBrightness`, `setBreathAmt`, `setWaveSpeed`, `setWaveAmt`, `setWeightedGlyphs`, `setCellSize`)
  - `demo.html`: "Organic" sub-panel with 7 controls; JS wiring; collectSettings/applySettings extended

- [x] **SPEC-demo-scene-controls** — speed range, trail range, density, radial zones
  - `matrix-rain-tsl.js`: 5 new uniforms (`uDensity`, `uZoneSpeedInner/Outer`, `uZoneBrightInner/Outer`); density cull in vertex shader (after all varying defaults); `t_zone` derivation from baked world position; `zoneSpeedBias` in `speedMul`; `zoneBrightBias` in `vAlpha`; `Return` added to imports
  - `matrix-rain-webgpu.js`: `buildGeometry(params)` parameterised with `speedMin/Max`, `trailMin/Max`; `_geomParams` closure state; `rebuildGeom()` helper; `speedRange`/`trailRange` opts; 5 new handle methods (`setSpeedRange`, `setTrailRange`, `setDensity`, `setZoneSpeed`, `setZoneBrightness`)
  - `demo.html`: "Columns" sub-panel (5 controls); "Radial zones" sub-panel (4 controls); JS wiring; collectSettings/applySettings extended

- [x] **SPEC-text-reveal** — `handle.showMessage(text, opts?)` API
  - Left-to-right wave sweep crystallises glyphs out of rain chaos, holds, then dissolves back
  - `uRevealActive`, `uRevealProgress`, `uRevealCols`, `uRevealMap` uniforms; `DataTexture` column map; `showMessage` queues by column x-position; auto-cancels on destroy

- [x] **SPEC-2d-core** — `matrix-rain-2d-tsl.js` flat fullscreen rain component
  - `initMatrix2DRain(canvas, opts)` / `destroyMatrix2DRain(canvas)` public API
  - Per-column state (seed, phase, speed, trail length) baked into `DataTexture`; TSL node graph renders on a single full-screen quad
  - Handles resize, RAF ref pattern, column rebuild on resize

- [x] **SPEC-2d-organic** — film-accurate 2D organic behaviour additions
  - Per-column speed micro-oscillation (breathing), wave phase correlation, Gaussian cluster placement
  - Glitch displacement (`uGlitchAmt`), speed-ramp trigger (`uSpeedRamp`), weighted glyph sampling via LUT

- [x] **SPEC-2d-layers** — multi-layer parallax depth compositing for 2D rain
  - Three independently-animated depth layers (near/mid/far) blended additively
  - `buildLayeredRain2DNode(layers, opts)` composites layers with per-layer cell size, speed, brightness, density

- [x] **SPEC-glyph-fx-controls** — expose 10 hardcoded shader constants as uniforms
  - `matrix-rain-tsl.js`: 11 new uniforms (`uDripAmt`, `uEdgeGlow`, `uZRotRange`, `uGrainAmt`, `uDepthTintAmt`, `uBootEnabled`, `uStability`, `uHoldMult`, `uBurstGlyphRate`, `uHueRange`, `uBurstProb`)
  - `matrix-rain-webgpu.js`: `setDrip`, `setEdgeGlow`, `setZRotation`, `setFilmGrain`, `setDepthTint`, `setStartupCascade`, `setStability`, `setHoldMult`, `setBurstGlyphRate`, `setPomSteps`, `setHueRange`, `setBurstProb`
  - `demo.html`: "Glyph FX" sub-panel + debug `<details>` block; companion numeric inputs on all sliders

- [x] **SPEC-column-distribution** — column placement distribution controls
  - `matrix-rain-webgpu.js`: `setColumnCount`, `setTopology` (`'sphere'`|`'cylinder'`|`'curtain'`), `setShellRadii`, `setClusterParams`, `setRadialBias`, `setRadialDensityTaper` (no-rebuild)
  - Options C (uniform blend), G (angular sector), H (height fade) deferred per spec

- [x] **SPEC-column-distribution-extra** — deferred column distribution options C, G, H
  - `matrix-rain-tsl.js`: 4 new uniforms (`uSectorCenter`, `uSectorWidth`, `uSectorStrength`, `uHeightFade`); combined `zonedDensity` with sector mask (`atan2` wrap + `smoothstep` falloff) and height fade (`sin` envelope)
  - `matrix-rain-webgpu.js`: `clusterUniform` param in `buildGeometry` + `_geomParams`; lerp between clustered and uniform theta; `setClusterUniform`, `setSectorCenter`, `setSectorWidth`, `setSectorStrength`, `setHeightFade` handle methods
  - `matrix-3d.html`: cluster uniform slider (rebuild); divider label; sector strength/center/width + height fade sliders (runtime); `collectSettings`/`applySettings` wired

- [ ] Tests — `tests/` for any pure-JS logic extracted to a `matrix-rain-math.js`
- [ ] `prefers-reduced-motion` — disable/reduce heat, god rays, burst bloom
- [ ] README.md — public documentation before any npm/gh-pages publish
- [ ] `package.json` npm publish — subpath exports already wired
