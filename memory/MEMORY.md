# Agent Session Memory

This file persists across agent runs. Read at session start for recent context.
Append notable events at session end. Prune entries older than 30 days.

- [Future: real contagion](future_real_contagion.md) — true neighbor-propagation burst needs ping-pong storage texture; current "cluster sync" is simultaneous cluster firing

- 2026-03-28: **SPEC-eol-effects** implemented. 3 new uniforms (`uEolFlash=0.6`, `uEolFreezeStart=0.80`, `uEolFadeStart=0.88`), `vCyclePhase` varying, terminal flash Gaussian block, glyph freeze `select()` on `changeTick`, death fade threshold promoted. 3 handle methods + 3 sliders in matrix-3d.html. Changes on by default (flash=0.6, freeze=0.80).

- 2026-03-27: **SPEC-webgl-fallback** implemented. Three.js WebGPURenderer auto-falls
  back to WebGL2 — the only required fix is the TextureNode sampler patch (appended to
  module preamble of `matrix-rain-webgpu.js`). Added `handle.backend` property (null →
  'webgpu'|'webgl2') and `'matrixrain:ready'` CustomEvent dispatch in `renderer.init()`.
  `matrix-3d.html` gets `registerBadge()` helper wired to all 3 `initMatrixRain` call sites.
  Note: `demo.html` does not exist in this project (only `matrix-3d.html` and `demo-crt.html`).

- 2026-03-23: Project bootstrapped as Three.js WebGPU matrix rain. All core files created:
  `matrix-rain-tsl.js` (glyph material), `matrix-rain-passes-tsl.js` (6 post-processing passes),
  `matrix-rain-webgpu.js` (public API, 9-stage pipeline), `demo.html`.
  Key fix: `animRef = { id: 0 }` ref object pattern so `destroyMatrixRain` always cancels
  the live animation frame ID (the closure variable `animId` was not kept in sync with the
  state object snapshot).
  MSDF atlas at `data/matrixcode_msdf.png` (512×512, 8×8 glyph grid).
