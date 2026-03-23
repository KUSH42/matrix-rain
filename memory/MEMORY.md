# Agent Session Memory

This file persists across agent runs. Read at session start for recent context.
Append notable events at session end. Prune entries older than 30 days.

- 2026-03-23: Project bootstrapped as Three.js WebGPU matrix rain. All core files created:
  `matrix-rain-tsl.js` (glyph material), `matrix-rain-passes-tsl.js` (6 post-processing passes),
  `matrix-rain-webgpu.js` (public API, 9-stage pipeline), `demo.html`.
  Key fix: `animRef = { id: 0 }` ref object pattern so `destroyMatrixRain` always cancels
  the live animation frame ID (the closure variable `animId` was not kept in sync with the
  state object snapshot).
  MSDF atlas at `data/matrixcode_msdf.png` (512×512, 8×8 glyph grid).
