# SPEC-demo-scene-controls — Speed range, trail range, density, radial zones

**Status**: Implemented
**Priority**: Medium
**Reference**: `demo-2d.html` controls panel, `SPEC-demo-params.md` (audit row "Skip")
**Depends on**: SPEC-demo-params — must be implemented first (adds the "Organic" sub-panel
that §8 places the new panels after).

---

## Motivation

`SPEC-demo-params` already ported the uniform-only 2D controls to 3D. The remaining 2D
controls were deferred because each has a non-trivial 3D mapping:

| 2D control | 3D situation | Resolution |
|---|---|---|
| Speed min/max | geometry-baked in `aColA.z` | parameterise `buildGeometry()`; rebuild on change |
| Trail min/max | geometry-baked in `aColB.w` | same |
| Density | no column-count uniform | add `uDensity`; vertex shader culls columns via hash |
| Streams/col | single-head-per-column model | **N/A** — see §5 |
| Multi-layer depth + per-layer controls | 3D is inherently volumetric | add radial zone controls — §4 |

---

## §1  Speed range (geometry rebuild)

### 1a  Parameterise `buildGeometry()`

Change the signature from `buildGeometry()` to `buildGeometry(params)`:

```js
function buildGeometry({
  speedMin = 1.2,
  speedMax = 8.0,
  trailMin = 0.015,
  trailMax = 0.050,
} = {}) {
  // Guard against inverted ranges — clamp min to max so the distribution
  // always has non-negative spread (caller gets all-same value at min==max).
  const sMin = Math.min(speedMin, speedMax);
  const sMax = Math.max(speedMin, speedMax);
  const tMin = Math.min(trailMin, trailMax);
  const tMax = Math.max(trailMin, trailMax);
  // ...
  const speed = sMin + sr * sr * (sMax - sMin);  // log-biased over range
  const trail = tMin + Math.random() * (tMax - tMin);
  // ...
}
```

The `sr * sr` quadratic bias is preserved: at the default range `[1.2, 8.0]` it gives the
existing distribution (mode ≈ 1.2, median ≈ 2.9, mean ≈ 3.5). At a narrowed range the same
log-bias applies within the new bounds. If min > max (e.g., user drags sliders past each
other), `Math.min/max` normalises the range without crashing.

### 1b  Closure state

Add `speedRange` and `trailRange` to the destructured opts block:

```js
const {
  // ... existing opts ...
  speedRange = null,
  trailRange = null,
} = opts;
```

Then resolve into a geometry-params object immediately after:

```js
const _geomParams = {
  speedMin: speedRange?.[0] ?? 1.2,
  speedMax: speedRange?.[1] ?? 8.0,
  trailMin: trailRange?.[0] ?? 0.015,
  trailMax: trailRange?.[1] ?? 0.050,
};
```

`const` (not `let`) — the reference is never reassigned; only properties are mutated by handle methods.

Pass `_geomParams` to the initial `buildGeometry(_geomParams)` call (line ~351).

### 1c  Rebuild helper

Add inside `initMatrixRain`, **after the `const s = { ... }` state object is created** (~line 695).
The function closes over both `mesh` and `s`; handle methods are only called after `initMatrixRain`
returns, so `s` is always fully assigned before `rebuildGeom()` runs.

```js
function rebuildGeom() {
  const newGeom = buildGeometry(_geomParams);
  mesh.geometry.dispose();
  mesh.geometry = newGeom;
  s.geom = newGeom;
}
```

`s.geom` must point to the current geometry so `destroyMatrixRain` disposes the right object.

### 1d  Handle methods

```js
setSpeedRange(min, max) {
  _geomParams.speedMin = min;
  _geomParams.speedMax = max;
  rebuildGeom();
},
setTrailRange(min, max) {
  _geomParams.trailMin = min;
  _geomParams.trailMax = max;
  rebuildGeom();
},
```

The rebuild is synchronous CPU + GPU buffer upload for 72 000 instances (~4.6 MB). No debounce
is needed — it completes well within a frame.

---

## §2  Density (vertex shader cull, no rebuild)

### 2a  New uniform

Add to `makeUniforms()` in `matrix-rain-tsl.js`:

```js
uDensity: uniform(1.0),   // fraction of columns active — range [0.1, 1.0]
```

### 2b  Destructure in `buildGlyphMaterial`

Add `uDensity` to the destructure block alongside the other uniforms.

### 2c  Vertex shader cull

In `vertexNode`, **after `vBootFade.assign(bootFadeVal)` at line ~180** and before the
`If(bootFadeVal.greaterThanEqual(0.001))` block at line ~182.

Placement is critical: the comment at line ~153 documents that "WGSL requires all varyings to
be assigned on every execution path before they are read in the fragment." `vBootFade` is the
last varying to be assigned (line 180). The density cull's `Return(clipPos)` must not skip
any varying assignment — placing it after line 180 satisfies this requirement.

```js
// Density cull — deterministic hash per column: fraction (1 - uDensity) of
// columns stay at the off-screen default and never reach the placement block.
// Placed after all varying defaults so WGSL is satisfied on the early-return path.
If(h2(vec2(aColIdxAttr.mul(0.137).add(0.5), float(42.7))).x.greaterThan(uDensity), () => {
  Return(clipPos);   // clipPos is still vec4(2,2,2,1) here — off-screen cull
});
```

`h2` returns a `vec2`; `.x` gives one stable scalar per column. At `uDensity = 1.0`
the hash is never `> 1.0`, so all columns render. At `uDensity = 0.5` roughly half are
culled via a fixed, spatially distributed pattern.

### 2d  Handle method

```js
setDensity(v) { uniforms.uDensity.value = v; },
```

---

## §3  Trail units note

In the 2D rain `trailMin/Max` are in *rows* (integers, 6–30). In the 3D shader the baked
`trail` value (stored in `aColB.w`) is a world-unit reciprocal-decay constant (0.015–0.050)
used in the fragment trail-falloff formula. These are not the same scale. The demo.html
slider for 3D trail uses the internal world-unit range; no conversion is needed.

---

## §4  Radial zone controls (3D multi-layer equivalent)

The 2D multi-layer mode composites three independent passes (BG / Mid / FG) with different
cell sizes, speed ranges, and brightness. The 3D scene is inherently volumetric: 600 columns
are scattered at radii `R_MIN = 3.5 … R_MAX = 8.0`. The per-column radial position `t`
(0 = inner / close, 1 = outer / far) already drives scale variation in the geometry.

The 3D equivalent of layering is **radial zone biasing**: two zone multipliers for speed and
brightness that are linearly interpolated across the shell by `t`. Default 1.0 = no effect;
deviating from 1.0 makes inner (close) and outer (far) columns behave differently.

This requires no geometry rebuild — all four new parameters are uniforms.

### 4a  New uniforms

Add to `makeUniforms()` in `matrix-rain-tsl.js`:

```js
uZoneSpeedInner:  uniform(1.0),   // speed bias at r = R_MIN  (inner / close)
uZoneSpeedOuter:  uniform(1.0),   // speed bias at r = R_MAX  (outer / far)
uZoneBrightInner: uniform(1.0),   // brightness bias at r = R_MIN
uZoneBrightOuter: uniform(1.0),   // brightness bias at r = R_MAX
```

### 4b  Destructure in `buildGlyphMaterial`

Add the four new uniforms to the destructure block.

### 4c  Vertex shader — compute `t_zone` from baked world position

In `vertexNode`, immediately after the density cull in §2c (i.e., also after line ~180,
before the `If(bootFadeVal...)` block):

```js
// Radial zone factor: 0 = inner (R_MIN), 1 = outer (R_MAX).
// Derived from the baked world column position (aWX, aWZ) so no extra attribute needed.
// Uses the module-level constants R_MIN = 3.5 and R_MAX = 8.0 directly — TSL inlines them
// as float literals, so no new uniforms are required.
const r_zone = sqrt(aWX.mul(aWX).add(aWZ.mul(aWZ)));
const t_zone = r_zone.sub(float(R_MIN)).div(float(R_MAX - R_MIN)).clamp(0.0, 1.0);
```

### 4d  Vertex shader — apply zone speed bias

**Replace** the existing `const speedMul = ...` declaration at line ~219 with:

```js
const zoneSpeedBias = mix(uZoneSpeedInner, uZoneSpeedOuter, t_zone);
const speedMul = breathMul
  .mul(float(1).add(burstActive.mul(burstFrac).mul(2)))
  .mul(uSpeedMul)
  .mul(zoneSpeedBias);
```

Do not add a second `const speedMul` — re-declaring a `const` in the same scope is a JS
`SyntaxError`. This is a full replacement of the three-line block.

`zoneSpeedBias` is 1.0 everywhere when both uniforms are 1.0 — no change to default behaviour.

### 4e  Vertex shader — apply zone brightness bias

The `vAlpha` assignment at line ~198:

```js
vAlpha.assign(aAlpha.mul(alphaJitter));
```

Replace with:

```js
const zoneBrightBias = mix(uZoneBrightInner, uZoneBrightOuter, t_zone);
vAlpha.assign(aAlpha.mul(alphaJitter).mul(zoneBrightBias));
```

### 4f  Handle methods

```js
setZoneSpeed(inner, outer) {
  uniforms.uZoneSpeedInner.value = inner;
  uniforms.uZoneSpeedOuter.value = outer;
},
setZoneBrightness(inner, outer) {
  uniforms.uZoneBrightInner.value = inner;
  uniforms.uZoneBrightOuter.value = outer;
},
```

---

## §5  Streams/col — N/A

**Not implemented.** The 3D model allocates one head per column; each column head is a single
`InstancedBufferGeometry` instance. Supporting N streams per column would require either
(a) `N × N_COLS × N_ROWS` total instances — a geometry rebuild on every change — or (b)
unrolling N stream loops in the vertex shader — a shader recompile. Neither is viable as
a live slider.

The visual complexity that streams/col provides in 2D (multiple independently-timed heads
within one column) is covered in 3D by the 600 independently seeded columns, the column
clustering pattern, and density control. No action.

---

## §6  New handle methods summary

| Method | Description |
|---|---|
| `setSpeedRange(min, max)` | Per-column speed distribution bounds — triggers geometry rebuild |
| `setTrailRange(min, max)` | Per-column trail length bounds (world units) — triggers geometry rebuild |
| `setDensity(v)` | Fraction of columns active 0.1–1.0 (no rebuild) |
| `setZoneSpeed(inner, outer)` | Speed multiplier for inner/outer radial zone — both default 1.0 |
| `setZoneBrightness(inner, outer)` | Brightness multiplier for inner/outer radial zone — both default 1.0 |

---

## §7  `initMatrixRain` opts additions

| Opt | Type | Default | Description |
|---|---|---|---|
| `opts.speedRange` | `[number, number]` | `[1.2, 8.0]` | Initial per-column speed distribution |
| `opts.trailRange` | `[number, number]` | `[0.015, 0.050]` | Initial per-column trail bounds (world units) |

`density`, `zoneSpeed`, and `zoneBrightness` are **not** exposed as init opts — their uniform
defaults (1.0) represent the identity / no-effect state, so passing them at construction time
adds no value over calling the handle method immediately after. The rebuild-cost params
(`speedRange`, `trailRange`) need init opts because their values are baked during geometry
construction and cannot be changed after the fact without a rebuild.

---

## §8  demo.html changes

### New "Columns" sub-panel

Add after the existing "Organic" sub-panel (before CRT section):

```html
<!-- Columns sub-panel -->
<div style="border-top:1px solid #00ff7044;margin-top:4px;padding-top:4px;
            display:flex;flex-direction:column;gap:4px;">
  <label style="color:#7fffaa;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;">
    — Columns —
  </label>

  <label title="Rebuilds geometry">Speed min ⟳
    <input id="ctl-spd-min" type="range" min="0.5" max="4.0" step="0.1" value="1.2">
  </label>
  <label title="Rebuilds geometry">Speed max ⟳
    <input id="ctl-spd-max" type="range" min="2.0" max="12.0" step="0.5" value="8.0">
  </label>

  <label title="Rebuilds geometry">Trail min ⟳
    <input id="ctl-trl-min" type="range" min="0.005" max="0.060" step="0.001" value="0.015">
  </label>
  <label title="Rebuilds geometry">Trail max ⟳
    <input id="ctl-trl-max" type="range" min="0.020" max="0.080" step="0.002" value="0.050">
  </label>

  <label>Density
    <input id="ctl-density-3d" type="range" min="0.1" max="1.0" step="0.05" value="1.0">
  </label>
</div>
```

The `⟳` suffix and `title` tooltip indicate geometry rebuild cost without adding UI clutter.

### New "Radial zones" sub-panel

```html
<!-- Radial zones sub-panel -->
<div style="border-top:1px solid #00ff7044;margin-top:4px;padding-top:4px;
            display:flex;flex-direction:column;gap:4px;">
  <label style="color:#7fffaa;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;">
    — Radial zones —
  </label>
  <span style="color:#5f9a6f;font-size:9px;line-height:1.3;">
    Inner = close (fast/bright) · Outer = far (slow/dim)
  </span>

  <label>Inner speed
    <input id="ctl-zone-spd-in" type="range" min="0.2" max="3.0" step="0.05" value="1.0">
  </label>
  <label>Outer speed
    <input id="ctl-zone-spd-out" type="range" min="0.2" max="3.0" step="0.05" value="1.0">
  </label>

  <label>Inner bright
    <input id="ctl-zone-br-in" type="range" min="0.1" max="2.5" step="0.05" value="1.0">
  </label>
  <label>Outer bright
    <input id="ctl-zone-br-out" type="range" min="0.1" max="2.5" step="0.05" value="1.0">
  </label>
</div>
```

### JS wiring

Speed/trail sliders are coupled (min must stay ≤ max), so use explicit listeners:

```js
function pushSpeedRange() {
  rain.setSpeedRange(
    parseFloat(document.getElementById('ctl-spd-min').value),
    parseFloat(document.getElementById('ctl-spd-max').value),
  );
}
function pushTrailRange() {
  rain.setTrailRange(
    parseFloat(document.getElementById('ctl-trl-min').value),
    parseFloat(document.getElementById('ctl-trl-max').value),
  );
}
document.getElementById('ctl-spd-min').addEventListener('input', pushSpeedRange);
document.getElementById('ctl-spd-max').addEventListener('input', pushSpeedRange);
document.getElementById('ctl-trl-min').addEventListener('input', pushTrailRange);
document.getElementById('ctl-trl-max').addEventListener('input', pushTrailRange);
```

Density uses the existing `bind` helper:

```js
bind('ctl-density-3d', v => rain.setDensity(v));
```

Zone sliders push both zone values together:

```js
function pushZoneSpeed() {
  rain.setZoneSpeed(
    parseFloat(document.getElementById('ctl-zone-spd-in').value),
    parseFloat(document.getElementById('ctl-zone-spd-out').value),
  );
}
function pushZoneBright() {
  rain.setZoneBrightness(
    parseFloat(document.getElementById('ctl-zone-br-in').value),
    parseFloat(document.getElementById('ctl-zone-br-out').value),
  );
}
document.getElementById('ctl-zone-spd-in').addEventListener('input', pushZoneSpeed);
document.getElementById('ctl-zone-spd-out').addEventListener('input', pushZoneSpeed);
document.getElementById('ctl-zone-br-in').addEventListener('input', pushZoneBright);
document.getElementById('ctl-zone-br-out').addEventListener('input', pushZoneBright);
```

### Settings import/export

Add to `collectSettings()`:

```js
spdMin:      fv('ctl-spd-min'),
spdMax:      fv('ctl-spd-max'),
trlMin:      fv('ctl-trl-min'),
trlMax:      fv('ctl-trl-max'),
density3d:   fv('ctl-density-3d'),
zoneSpeedIn: fv('ctl-zone-spd-in'),
zoneSpeedOut:fv('ctl-zone-spd-out'),
zoneBrIn:    fv('ctl-zone-br-in'),
zoneBrOut:   fv('ctl-zone-br-out'),
```

Add to `applySettings()` (set slider values first, then live-push):

```js
set('ctl-spd-min',      s.spdMin);
set('ctl-spd-max',      s.spdMax);
set('ctl-trl-min',      s.trlMin);
set('ctl-trl-max',      s.trlMax);
set('ctl-density-3d',   s.density3d);
set('ctl-zone-spd-in',  s.zoneSpeedIn);
set('ctl-zone-spd-out', s.zoneSpeedOut);
set('ctl-zone-br-in',   s.zoneBrIn);
set('ctl-zone-br-out',  s.zoneBrOut);

if (s.spdMin   !== undefined || s.spdMax   !== undefined) pushSpeedRange();
if (s.trlMin   !== undefined || s.trlMax   !== undefined) pushTrailRange();
if (s.density3d !== undefined) rain.setDensity(s.density3d);
if (s.zoneSpeedIn !== undefined || s.zoneSpeedOut !== undefined) pushZoneSpeed();
if (s.zoneBrIn    !== undefined || s.zoneBrOut    !== undefined) pushZoneBright();
```

---

## §9  CLAUDE.md handle method table additions

```
| `setSpeedRange(min, max)` | Per-column speed range — triggers geometry rebuild |
| `setTrailRange(min, max)` | Per-column trail bounds (world units) — triggers geometry rebuild |
| `setDensity(v)` | Fraction of columns active 0.1–1.0 (uniform, no rebuild) |
| `setZoneSpeed(inner, outer)` | Radial speed multiplier inner/outer shell (default 1.0, 1.0) |
| `setZoneBrightness(inner, outer)` | Radial brightness multiplier inner/outer shell (default 1.0, 1.0) |
```

---

## §10  Files changed

| File | Change |
|---|---|
| `matrix-rain-webgpu.js` | `buildGeometry(params)` signature; `_geomParams` closure state; `rebuildGeom()` helper; `setSpeedRange`, `setTrailRange`, `setDensity`, `setZoneSpeed`, `setZoneBrightness` handle methods; `speedRange`/`trailRange` opts |
| `matrix-rain-tsl.js` | 5 new uniforms (`uDensity`, `uZoneSpeedInner/Outer`, `uZoneBrightInner/Outer`); density cull in vertex shader; `t_zone` derivation; `zoneSpeedBias` in `speedMul` (replacement); `zoneBrightBias` in `vAlpha` |
| `demo.html` | "Columns" sub-panel (5 controls); "Radial zones" sub-panel (4 controls); JS wiring; extend `collectSettings`/`applySettings` |
| `CLAUDE.md` | Handle Methods table — 5 new entries; opts table — 2 new entries |
| `PROGRESS.md` | Mark spec as Implemented |

No changes to `matrix-rain-passes-tsl.js`, `matrix-rain-presets.js`, or `demo-2d.html`.

---

## §11  Verification

1. **Speed range**: set `[0.5, 2.0]` — rain should slow noticeably; no column moves faster
   than ~2× the global speed. Set `[4.0, 12.0]` — all columns fast with little slow-tail.
   Drag slider while watching; each drag fires one geometry rebuild with no flash or stutter.

2. **Trail range**: set `[0.040, 0.060]` — short trails; glyphs flash with little ghost-fade.
   Set `[0.005, 0.015]` — long ghost trails. No bloom or phosphor regression.

3. **Density**: at 0.1 roughly 60 of 600 columns visible; at 1.0 all 600 render. The
   pattern of which columns are culled should be visually even (no spatial clustering).
   Drag is smooth — no rebuild.

4. **Zone speed**: set `inner=2.0, outer=0.5` — inner columns (close) should visibly race;
   outer (far, small) should drift slowly. The existing global `ctl-speed` multiplier
   applies on top. Zone uniforms default to 1.0 so presets are unaffected.

5. **Zone brightness**: set `inner=0.4, outer=2.0` — foreground columns dim, background
   columns bright. Verify this compounds multiplicatively with `uBrightness` (zone bias
   multiplies `vAlpha` in the vertex stage; `uBrightness` multiplies final fragment RGB —
   both apply independently, not as a replacement for each other).

6. **Settings round-trip**: export JSON, reload, import — all nine new params restore; speed
   and trail sliders trigger one rebuild each.

7. **PP mode switch**: switching PP mode destroys and recreates the instance with defaults
   — `_geomParams` resets to `[1.2, 8.0]` / `[0.015, 0.050]`; zone uniforms reset to 1.0;
   density to 1.0. Sliders reset accordingly.

8. **Min > max guard**: drag speed-min above speed-max (or trail-min above trail-max). The
   rebuild must not crash; `buildGeometry` normalises the range with `Math.min/max`, so
   all columns spread evenly across `[min(min, max), max(min, max)]`. Verify at the
   speed slider extremes: min=4.0, max=2.0 should produce a slow-biased cloud with the
   same spread as min=2.0, max=4.0.

9. **Zone controls at defaults**: confirm inner = outer = 1.0 produces output visually
   identical to a fresh instance — no brightening, no speed change.

10. **Density at floor**: at `density = 0.1` confirm at least some columns remain visible
    (the hash distributes evenly, so roughly 60 of 600 should render).
