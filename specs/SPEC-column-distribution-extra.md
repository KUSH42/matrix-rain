# SPEC-column-distribution-extra

**Status**: Implemented
**Priority**: P2 (Options C, G) / P3 (Option H)
**Depends on**: SPEC-column-distribution (Implemented)
**Reference**: `specs/SPEC-column-distribution.md` §Deferred Options

---

## Motivation

Three options were deferred from SPEC-column-distribution after the core rebuild controls shipped.
They are specced together because they share the same demo sub-panel and compose cleanly — Options
G and H both multiply into the same `zonedDensity` expression in the vertex shader.

| Option | Name | Rebuild? | Priority |
|---|---|---|---|
| C | Cluster uniform blend | Yes | P2 |
| G | Angular sector density | No | P2 |
| H | Height fade | No | P3 |

---

## Baseline (relevant excerpt)

`matrix-rain-tsl.js` — vertex Fn, lines ~222–225:

```js
const zonedDensity = uDensity.mul(mix(uDensityInner, uDensityOuter, t_zone)).clamp(0.0, 1.0);
If(h2(vec2(aColIdxAttr.mul(0.137).add(0.5), float(42.7))).lessThanEqual(zonedDensity), () => {
  If(bootFadeVal.greaterThanEqual(0.001), () => {
    // ... placement
  }); // boot cull
}); // density cull
```

`clipPos` defaults to `vec4(2,2,2,1)` (offscreen) at the top of the vertex Fn, so any column
that falls through without entering the density `If` block is automatically clipped.

Attribute layout (both attributes are vec4 instanced buffers):
- `aColA` → `.x = aWX`, `.y = aWZ`, `.z = aSpeed`, `.w = aSeed`
- `aColB` → `.x = aYOff`, `.y = aScale`, `.z = aAlpha`, `.w = aTrail`

---

## Option C — Cluster uniform blend

### What it does

A single `clusterUniform` param [0–1] lerps each column's angular position between its
clustered assignment and a fully uniform random angle, without touching `clusterCount` or
`clusterSpread`. At 0 the existing clustering is preserved; at 1 columns scatter uniformly
around the shell.

### Implementation

**`matrix-rain-webgpu.js` — `buildGeometry(params)`**

Add `clusterUniform` to the `_geomParams` default object (default `0`) and destructure it
alongside the existing cluster params. In the per-column theta loop:

```js
// existing:
const theta = clusterCenters[clusterIdx] + gaussRand() * sigma;

// replace with:
const clustered    = clusterCenters[clusterIdx] + gaussRand() * sigma;
const uniformTheta = Math.random() * Math.PI * 2;
const theta        = clustered + (uniformTheta - clustered) * clusterUniform;
```

No shader changes — pure geometry.

**Handle method:**
```js
setClusterUniform(v) { _geomParams.clusterUniform = Math.max(0, Math.min(1, v)); rebuildGeom(); }
```

**`demo.html`** — add to the existing "Columns" sub-panel alongside the cluster count/spread
sliders:
```
Cluster uniform  [slider 0–1, step 0.01, default 0]  [numeric input]
```

Wire into `collectSettings` / `applySettings` so the value is preserved across PP mode
re-inits (same pattern as the existing cluster count/spread sliders).

### Unit test note

The `clusterUniform` lerp is pure JS and testable without a GPU. A test in `tests/` should
verify: at `v=0`, `theta === clustered`; at `v=1`, `theta === uniformTheta`. Relevant once the
`tests/matrix-rain-math.js` extraction backlog item is addressed.

---

## Option G — Angular sector density

### What it does

Thin or mask columns outside a directional arc anchored in world XZ space. `uSectorStrength=0`
disables the effect entirely regardless of `uSectorWidth`. `uSectorStrength=1` with a narrow
`uSectorWidth` produces a tight front curtain; wide `uSectorWidth` leaves most of the shell
active and only thins a small antipodal band.

World-fixed: the sector is anchored in world XZ space. Rotating the camera reveals different
arcs of the shell.

### Disabling the feature

The effect is controlled exclusively by `uSectorStrength`. Setting `strength=0` is the correct
"off" state regardless of `uSectorWidth`. `uSectorWidth` does not have a "disabled" value —
it controls how wide the active arc is. `setSectorStrength(0)` is the API to turn the feature
off.

### New uniforms (`matrix-rain-tsl.js` → `makeUniforms()`)

```js
uSectorCenter:   uniform(0.0),          // world XZ angle of arc center (radians)
uSectorWidth:    uniform(Math.PI),      // half-angle of arc (radians); default π = widest single arc
uSectorStrength: uniform(0.0),          // 0 = off (default), 1 = full mask outside arc
```

All three must be added to the destructure list at the top of `buildGlyphMaterial()`.
`abs` and `smoothstep` are already imported from `three/tsl`; confirm `atan` is also in scope.

### Vertex shader change

Replace the `zonedDensity` line with the block below. Check `buildGlyphMaterial` for existing
`TWO_PI` or `twoPI` declarations before adding the constant; use `float(6.2831853)` inline
if there is a collision.

```js
// Sector mask — world-fixed, operates on baked XZ column position
const colAngle    = atan(aColAAttr.y, aColAAttr.x);               // atan2(wz, wx) → [−π, π]
const TWO_PI      = float(Math.PI * 2);
const rawDiff     = colAngle.sub(uSectorCenter);
const wrapped     = fract(rawDiff.div(TWO_PI).add(0.5)).mul(TWO_PI).sub(Math.PI); // [−π, π]
const sectorMask  = float(1).sub(
  uSectorStrength.mul(smoothstep(uSectorWidth.mul(0.85), uSectorWidth, abs(wrapped)))
);
// smoothstep gives a soft 15 % falloff at the arc edge instead of a hard cut.

const zonedDensity = uDensity
  .mul(mix(uDensityInner, uDensityOuter, t_zone))
  .mul(sectorMask)
  .clamp(0.0, 1.0);
```

### Handle methods

`setSectorWidth` clamps to a minimum of 1° to avoid `smoothstep(0, 0, x)` undefined
behaviour (GLSL spec leaves `edge0 === edge1` implementation-defined):

```js
setSectorCenter(deg)    { uniforms.uSectorCenter.value   = deg * Math.PI / 180; }
setSectorWidth(deg)     { uniforms.uSectorWidth.value    = Math.max(1, deg) * Math.PI / 180; }
setSectorStrength(v)    { uniforms.uSectorStrength.value = Math.max(0, Math.min(1, v)); }
```

### Demo controls

Add to the "Columns" sub-panel. Place a visual `<hr>` or section label (e.g. `"— Runtime
(no rebuild) —"`) between the rebuild controls (topology, radii, cluster, clusterUniform)
and these no-rebuild controls to make the rebuild boundary clear:

```
Sector strength  [range 0–1, step 0.01, default 0]              [numeric]
Sector center    [range −180–180, step 1, default 0, unit °]    [numeric]
Sector width     [range 1–180, step 1, default 180, unit °]     [numeric]
```

Wire into `collectSettings` / `applySettings`.

---

## Option H — Height fade

### What it does

A sine envelope that fades column density toward the top and bottom of the vertical extent.
At `heightFade=0` there is no effect. At `heightFade=1` column density follows
`sin(normY × π)` — zero at the poles, full at the equator.

**Coupling note:** `aYOff` values are baked at geometry build time using the JS constant
`WORLD_H=16`. The shader divides by `uWorldH` (also 16). These must stay in sync — `uWorldH`
is a read-only shader constant, not a runtime setter. If `WORLD_H` ever changes, both values
must be updated together.

### New uniform

```js
uHeightFade: uniform(0.0),    // 0 = off, 1 = full sine envelope; range 0–1
```

Add to `makeUniforms()` and the `buildGlyphMaterial()` destructure list.

### Vertex shader change

When implementing H alone (before G), insert `heightMask` directly into the `zonedDensity`
expression:

```js
// aYOff = aColBAttr.x; baked range [−WORLD_H/2, WORLD_H/2] = [−8, 8]
// normY: 0 at bottom pole, 1 at top pole (assumes uWorldH === build-time WORLD_H)
const normY      = aColBAttr.x.div(uWorldH).add(0.5);
const heightMask = mix(float(1), sin(normY.mul(Math.PI)), uHeightFade);

const zonedDensity = uDensity
  .mul(mix(uDensityInner, uDensityOuter, t_zone))
  .mul(heightMask)
  .clamp(0.0, 1.0);
```

When G is also implemented, add `.mul(heightMask)` to the combined expression (see §Combined
below).

### Handle method

```js
setHeightFade(v) { uniforms.uHeightFade.value = Math.max(0, Math.min(1, v)); }
```

### Demo control

Add below the sector controls in the "Columns" sub-panel (same no-rebuild section):

```
Height fade  [range 0–1, step 0.01, default 0]  [numeric]
```

Wire into `collectSettings` / `applySettings`.

---

## Combined `zonedDensity` (final form with all three options)

This is the authoritative implementation when both G and H are in place. Replace only the
existing `const zonedDensity = …` line with the Option G + H computation block below.
The `If(h2…)` line is repeated here for context — it is unchanged; only the variable it
reads from changes:

```js
// ── Option G: angular sector mask (world-fixed) ──────────────────────────
const colAngle    = atan(aColAAttr.y, aColAAttr.x);               // atan2(wz, wx) → [−π, π]
const TWO_PI      = float(Math.PI * 2);
const rawDiff     = colAngle.sub(uSectorCenter);
const wrapped     = fract(rawDiff.div(TWO_PI).add(0.5)).mul(TWO_PI).sub(Math.PI); // [−π, π]
const sectorMask  = float(1).sub(
  uSectorStrength.mul(smoothstep(uSectorWidth.mul(0.85), uSectorWidth, abs(wrapped)))
);

// ── Option H: height fade ─────────────────────────────────────────────────
const normY      = aColBAttr.x.div(uWorldH).add(0.5);            // [0, 1] pole-to-pole
const heightMask = mix(float(1), sin(normY.mul(Math.PI)), uHeightFade);

// ── Combined density gate ─────────────────────────────────────────────────
const zonedDensity = uDensity
  .mul(mix(uDensityInner, uDensityOuter, t_zone))
  .mul(sectorMask)
  .mul(heightMask)
  .clamp(0.0, 1.0);

If(h2(vec2(aColIdxAttr.mul(0.137).add(0.5), float(42.7))).lessThanEqual(zonedDensity), () => {
  // ... existing boot cull + placement unchanged
```

---

## New handle methods summary

| Method | Rebuild? | Range | Default |
|---|---|---|---|
| `setClusterUniform(v)` | Yes | 0–1 | 0 |
| `setSectorCenter(deg)` | No | −180–180 | 0 |
| `setSectorWidth(deg)` | No | 1–180 | 180 |
| `setSectorStrength(v)` | No | 0–1 | 0 |
| `setHeightFade(v)` | No | 0–1 | 0 |

---

## CLAUDE.md API table additions

```
| `setClusterUniform(v)` | Cluster-to-uniform angular blend 0–1 (0=clustered, 1=scatter) — triggers geometry rebuild |
| `setSectorCenter(deg)` | World XZ angle of sector center −180–180° (default 0 = +Z axis) |
| `setSectorWidth(deg)` | Half-angle of active sector 1–180° (default 180 = widest arc) |
| `setSectorStrength(v)` | Fraction masked outside sector 0–1 (0 = off, default) |
| `setHeightFade(v)` | Sine density fade at vertical poles 0–1 (0 = off) |
```

---

## Implementation order

1. **Option H** — one uniform, two shader lines, zero interactions with existing code
2. **Option G** — three uniforms, replaces `zonedDensity` expression (incorporate H's `heightMask` if already done, giving the Combined form above)
3. **Option C** — pure JS geometry change, independent of shader work; can be done in any order

---

## Out of scope

- Camera-relative sector mode (the sector rotates with the camera) — too much UX complexity;
  implement as a follow-on if requested
- Animated sector sweep — user can call `setSectorCenter` in a `setInterval`
- Vertical yOff range control — deferred indefinitely per SPEC-column-distribution §Out of Scope
