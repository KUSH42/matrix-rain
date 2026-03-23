# SPEC-matrix-presets

**Status**: Implemented
**Priority**: P1
**Reference**: `specs/matrix-rain-analysis.md` §2 "Colour Science", §3 "Animation & Simulation Rules"

---

## Motivation

All post-processing and glyph parameters are individually controllable via handle methods,
but there is no way to apply a coherent named look in one call. Reaching the film-accurate
1999 appearance requires tuning a dozen values simultaneously — colour, bloom, phosphor
decay, streaks, scanlines, chromatic aberration — with the wrong value for any one ruining
the result.

This spec adds:
1. A `PRESETS` table in `matrix-rain-presets.js` with four named looks
2. Four missing handle methods needed for full preset coverage
3. `handle.applyPreset(name)` that applies all values in one call
4. A `preset` init option that applies the named preset after the PP graph is ready
5. A preset dropdown in `demo.html`

---

## Missing Handle Methods

The following handle methods do not currently exist and are required for presets to control
the full pipeline. They must be added to `initMatrixRain`'s returned handle object and to
the public API JSDoc.

### `setBloomThreshold(v)`

Sets the static bloom threshold on `postProcessing._bloomNode.threshold.value`. The burst
bloom feature (`burstBloomActive`) overrides this dynamically; when burst bloom is on the
threshold reverts to the static value between bursts. If PP is not yet ready, no-ops.

```js
setBloomThreshold(v) {
  if (postProcessing?._bloomNode) postProcessing._bloomNode.threshold.value = v;
},
```

### `setVignette(v)`

Sets `postProcessing._holoBuild.uVignetteStrength.value`. Range 0–1, default 0.42.

```js
setVignette(v) {
  if (postProcessing?._holoBuild) postProcessing._holoBuild.uVignetteStrength.value = v;
},
```

### `setScanlines(v)`

Sets `postProcessing._holoBuild.uScanlineOpacity.value`. Range 0–0.2, default 0.045.

```js
setScanlines(v) {
  if (postProcessing?._holoBuild) postProcessing._holoBuild.uScanlineOpacity.value = v;
},
```

### `setHoloAberration(v)`

Sets `postProcessing._holoBuild.uAberrationAmt.value`. Screen-space chromatic aberration in
the holo pass — separate from the per-glyph `uGlyphChroma` aberration in the TSL shader.
Range 0–0.015, default 0.0025.

```js
setHoloAberration(v) {
  if (postProcessing?._holoBuild) postProcessing._holoBuild.uAberrationAmt.value = v;
},
```

---

## Presets

Four named presets. Each entry is a plain object; fields map 1:1 to handle method calls.
Absent fields are not changed, allowing partial overrides.

### `default` — current factory values

Restores every parameter to its out-of-the-box value. Useful as a reset button.

```js
default: {
  color:           '#00ff70',
  opacity:          0.82,
  depth:            0.04,
  normalStrength:   6.0,
  glyphChroma:      true,
  glyphChromaScale: 1.0,
  speed:            1.0,
  bloomStrength:    1.15,
  bloomThreshold:   0.20,
  phosphorDecay:    0.88,
  heat:             0.004,
  soften:           0.002,
  streaks:          0.055,
  burstBloom:       true,
  vignette:         0.42,
  scanlines:        0.045,
  holoAberration:   0.0025,
  godRays: { enabled: true, lightX: 0.5, lightY: 0.75,
             density: 0.93, decay: 0.96, weight: 0.35, exposure: 0.45 },
}
```

### `matrix1999` — film-accurate

Tuned from `specs/matrix-rain-analysis.md` §2.

**Colour**: `#00FF41` — P31 phosphor green (H=135°, slightly cyan-shifted). The current
default `#00ff70` is too blue-shifted; the film green has `b = 65/255 = 0.255` not `0.44`.

**Bloom**: Slightly stronger and lower threshold so more glyph heads bloom faintly, matching
the film's characteristic soft corona around every lit character.

**Phosphor decay**: Raised to 0.92 (from default 0.88). The film ran at 24 fps; the
persistence smear on fast streams was a temporal averaging of 2–3 frames. At 60 fps render,
a slightly higher per-frame decay preserves roughly the same real-time smear duration.

**Heat**: Zero. Heat shimmer is a CRT thermal artefact; the 1999 effect was composited from
pre-rendered layers on film, not displayed on a CRT. No shimmer.

**Streaks**: Zero. Lens rain streaks are a creative addition to the library; the film does
not have them.

**Scanlines**: Zero. The film was not displayed on a CRT in the production pipeline.

**God rays**: Enabled but subtle — lower exposure (0.22) and weight (0.20). Some shots
have atmospheric scatter but it is barely perceptible, not the dramatic crepuscular rays of
the default setting.

**Holo aberration**: Raised slightly (0.003). The research documents a real lens/optical-
print fringing in the film (red channel lags ~0.5 px, blue ~1 px).

**Glyph chroma**: On but at lower scale (0.4). The per-glyph TSL aberration is a creative
exaggeration; the film shows only the screen-space fringing documented above, not per-glyph
colour splitting.

**CharSet**: `'matrix1999'` — half-width katakana with mirrored glyphs, as in the film.

```js
matrix1999: {
  color:           '#00FF41',
  opacity:          0.90,
  depth:            0.04,
  normalStrength:   4.0,
  glyphChroma:      true,
  glyphChromaScale: 0.4,
  speed:            1.0,
  bloomStrength:    1.4,
  bloomThreshold:   0.15,
  phosphorDecay:    0.92,
  heat:             0.0,
  soften:           0.0015,
  streaks:          0.0,
  burstBloom:       true,
  vignette:         0.55,
  scanlines:        0.0,
  holoAberration:   0.003,
  godRays: { enabled: true, lightX: 0.5, lightY: 0.30,
             density: 0.90, decay: 0.94, weight: 0.20, exposure: 0.22 },
  charSet:          'matrix1999',
}
```

### `ghost` — slow, ethereal

Very slow columns, heavy phosphor smear, peripheral softening, dim. Evokes the look of
Cypher's monitor — "reading the Matrix" at reduced density and pace.

```js
ghost: {
  color:           '#00CC44',
  opacity:          0.55,
  depth:            0.02,
  normalStrength:   2.0,
  glyphChroma:      false,
  glyphChromaScale: 0.0,
  speed:            0.45,
  bloomStrength:    0.65,
  bloomThreshold:   0.28,
  phosphorDecay:    0.96,
  heat:             0.0,
  soften:           0.007,
  streaks:          0.0,
  burstBloom:       false,
  vignette:         0.70,
  scanlines:        0.0,
  holoAberration:   0.001,
  godRays: { enabled: false, lightX: 0.5, lightY: 0.75,
             density: 0.93, decay: 0.96, weight: 0.35, exposure: 0.0 },
}
```

### `overdrive` — maximum intensity

High speed, heavy bloom, lens rain, streaks — evokes the lobby fight / rooftop sequences.

```js
overdrive: {
  color:           '#00FF70',
  opacity:          1.0,
  depth:            0.06,
  normalStrength:   8.0,
  glyphChroma:      true,
  glyphChromaScale: 1.8,
  speed:            2.8,
  bloomStrength:    2.2,
  bloomThreshold:   0.10,
  phosphorDecay:    0.80,
  heat:             0.009,
  soften:           0.001,
  streaks:          0.12,
  burstBloom:       true,
  vignette:         0.28,
  scanlines:        0.03,
  holoAberration:   0.004,
  godRays: { enabled: true, lightX: 0.5, lightY: 0.65,
             density: 0.95, decay: 0.97, weight: 0.45, exposure: 0.70 },
}
```

---

## `matrix-rain-presets.js` (new file)

Exports `PRESETS` — the plain object above — and `applyPreset(name, handle)`, a standalone
helper for callers who hold a preset name and a handle reference but don't want to use the
handle method directly.

```js
export const PRESETS = { default: {...}, matrix1999: {...}, ghost: {...}, overdrive: {...} };

/**
 * Apply a named preset to a rain handle.
 * @param {string} name    Key from PRESETS
 * @param {object} handle  Control handle returned by initMatrixRain
 */
export function applyPreset(name, handle) {
  handle.applyPreset(name);
}
```

Keeping the module thin: no Three.js imports, no state, pure data + one convenience
re-export.

---

## `handle.applyPreset(name)` Implementation

Added to the handle object in `matrix-rain-webgpu.js`. Calls existing and new handle
methods for each field present in the preset. Fields absent from the preset are silently
skipped — presets are *partial by default*, allowing selective application.

```js
applyPreset(name) {
  const p = PRESETS[name];
  if (!p) {
    console.warn(`matrix-rain: unknown preset '${name}'. Valid: ${Object.keys(PRESETS).join(', ')}`);
    return;
  }
  if (p.color           !== undefined) handle.setColor(p.color);
  if (p.opacity         !== undefined) handle.setOpacity(p.opacity);
  if (p.depth           !== undefined) handle.setDepth(p.depth);
  if (p.normalStrength  !== undefined) handle.setNormalStrength(p.normalStrength);
  if (p.glyphChroma     !== undefined) handle.setGlyphChroma(p.glyphChroma, p.glyphChromaScale ?? 1.0);
  if (p.speed           !== undefined) handle.setSpeed(p.speed);
  if (p.bloomStrength   !== undefined) handle.setBloomStrength(p.bloomStrength);
  if (p.bloomThreshold  !== undefined) handle.setBloomThreshold(p.bloomThreshold);
  if (p.phosphorDecay   !== undefined) handle.setPhosphorDecay(p.phosphorDecay);
  if (p.heat            !== undefined) handle.setHeat(p.heat > 0, p.heat);
  if (p.soften          !== undefined) handle.setSoften(p.soften > 0, p.soften);
  if (p.streaks         !== undefined) handle.setStreaks(p.streaks > 0, p.streaks);
  if (p.burstBloom      !== undefined) handle.setBurstBloom(p.burstBloom);
  if (p.vignette        !== undefined) handle.setVignette(p.vignette);
  if (p.scanlines       !== undefined) handle.setScanlines(p.scanlines);
  if (p.holoAberration  !== undefined) handle.setHoloAberration(p.holoAberration);
  if (p.godRays) {
    const g = p.godRays;
    handle.setGodRays(
      g.enabled, g.lightX, g.lightY,
      g.density, g.decay, g.weight, g.exposure,
    );
  }
  if (p.charSet         !== undefined) handle.setCharSet(p.charSet);
},
```

Note: `p.glyphChroma` is a boolean but `glyphChromaScale` is a separate key. The preset
object stores both for readability; the implementation reads them together.

Note: `handle` inside `applyPreset` refers to the same object returned from
`initMatrixRain`. Use a `let handle;` forward declaration at the top of `initMatrixRain`
and assign it before the return statement, so the `renderer.init().then(...)` callback (and
`applyPreset` itself) can reference it via closure.

---

## `preset` Init Option

```js
initMatrixRain(el, { preset: 'matrix1999' })
```

Applied after `renderer.init()` resolves and the PP graph is built, ensuring all
`postProcessing?._X` guards pass. The existing `charSet` init option is still resolved
before any preset — if both are given, `charSet` wins for the atlas, then the preset's
`charSet` field overrides it via `setCharSet` (async).

Implementation in `initMatrixRain`:

```js
let handle;   // forward declaration — used by init callback and applyPreset closure

renderer.init().then(() => {
  postProcessing = buildPP();
  animRef.id = requestAnimationFrame(animate);
  if (preset) handle?.applyPreset(preset);
});

// ... rest of init ...

handle = {
  // ... all handle methods including applyPreset ...
};
return handle;
```

---

## Demo Changes (`demo.html`)

Add a preset `<select>` dropdown above the existing controls. Changing it calls
`rain.applyPreset(name)` and, where relevant, updates the UI control values to reflect the
new state (so sliders don't lie).

```html
<label>Preset
  <select id="ctl-preset">
    <option value="">— custom —</option>
    <option value="matrix1999">matrix1999</option>
    <option value="ghost">ghost</option>
    <option value="overdrive">overdrive</option>
    <option value="default">default</option>
  </select>
</label>
```

UI sync: after `applyPreset`, update `#ctl-color`, `#ctl-opacity`, `#ctl-speed`,
`#ctl-bloom`, `#ctl-phosphor`, `#ctl-heat`, `#ctl-soften`, `#ctl-streaks`, `#ctl-godrays`,
`#ctl-burst`, `#ctl-charset` values to match the applied preset. This avoids stale slider
positions.

Additionally, add sliders for the four new handle methods (vignette, scanlines,
holoAberration, bloomThreshold) since they are now exposed and useful in isolation.

---

## Tasks

1. **`matrix-rain-presets.js`** — create file with `PRESETS` object and `applyPreset`
   re-export. *(No dependencies.)*

2. **Four new handle methods** — add `setBloomThreshold`, `setVignette`, `setScanlines`,
   `setHoloAberration` to the handle object in `matrix-rain-webgpu.js`. *(No
   dependencies.)*

3. **`handle.applyPreset(name)`** — add method to handle; add `let handle` forward
   declaration; import `PRESETS` from `matrix-rain-presets.js`. *(Depends on Tasks 1–2.)*

4. **`preset` init option** — add to opts destructuring and `renderer.init().then`
   callback. *(Depends on Task 3.)*

5. **Demo wiring** — add preset dropdown, four new sliders, UI sync after preset apply.
   *(Depends on Task 4.)*

---

## Out of Scope

- Scene-triggered automatic preset transitions (e.g., on camera movement).
- Animated interpolation between preset values (crossfade).
- User-defined custom presets at runtime.
- Exporting the current state as a preset object.
