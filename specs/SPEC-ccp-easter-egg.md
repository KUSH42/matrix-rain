# SPEC-ccp-easter-egg

**Status**: Draft
**Priority**: P2 — easter egg / fun
**Depends on**: none
**Goal**: Typing "xijinping" at any time activates CCP mode — Xi Jinping braille ASCII art billboards flash dramatically in red from the distant background, with a hidden settings sub-panel for tweaking them.

---

## Problem

The demo has no secret. We want a konami-code-style easter egg that:
1. Triggers on a specific typed sequence with zero UI indication it exists.
2. Injects a visually distinct foreign element (red braille billboard planes) into the 3D scene.
3. Exposes a hidden control panel for that element, only visible once unlocked — scaffolding for future CCP-mode expansions.

---

## Goals

1. Typing `xijinping` (case-insensitive) in any focus state toggles CCP mode on/off.
2. On activation: 3 large canvas-texture billboard planes appear in the distant background (radius ~22–24 from origin), each displaying a Xi Jinping braille ASCII art portrait in red, flashing at a configurable rate.
3. Planes billboard to face the camera every frame. They do not interact with the rain glyph shader or uniforms.
4. A fade envelope (0→1 over 0.8 s, 1→0 over 0.5 s) gates the overall visibility.
5. A hidden `#ccp-panel` div in the settings panel is revealed on activation and hidden again on deactivation.
6. Panel contains: flash rate, peak opacity, scale, panel count, and orbit speed controls — useful for tuning now, scaffolding for future expansion.
7. A transient hint line reads `[ CCP MODE ]` in red for 2 s at bottom-left on toggle.
8. No functional changes to the rain renderer, shader, or any existing handle method.

## Non-Goals

- No shader changes. Braille planes use plain `THREE.MeshBasicMaterial` — no TSL, no MSDF.
- No modification to `matrix-rain-tsl.js`, `matrix-rain-passes-tsl.js`, or `matrix-rain-presets.js`.
- No `initMatrixRain` API change (keylogger lives in `matrix-3d.html`).
- No persistence across page reloads (mode resets to off on load).
- "Red override" (forcing the main rain red) is a stub checkbox wired to nothing — reserved for a future spec.

---

## Design

### Trigger — keylogger in `matrix-3d.html`

A `keydown` listener on `document` accumulates a rolling 9-character lowercase buffer.
No modifier keys. Buffer clears after 3 s of inactivity (via debounced `setTimeout`).
On match of `'xijinping'` the buffer is cleared and CCP mode is toggled:

```js
let _kbuf = '';
let _kTimer = null;
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1) return;
  _kbuf = (_kbuf + e.key.toLowerCase()).slice(-9);
  clearTimeout(_kTimer);
  _kTimer = setTimeout(() => { _kbuf = ''; }, 3000);
  if (_kbuf === 'xijinping') {
    _kbuf = '';
    _ccpActive = !_ccpActive;
    rain.setCCPMode(_ccpActive);
    // show/hide panel, flash hint (see HTML section)
  }
});
```

### Braille art constants — `CCP_ART` in `matrix-rain-webgpu.js`

Three multiline strings, each a classic Xi Jinping Unicode braille copypasta.
Stored as a module-level `const CCP_ART` array.  Each entry is a plain string with
`\n` line breaks; lines consist of Unicode braille characters (U+2800–U+28FF) only.

- `CCP_ART[0]` — the full portrait (~32 lines × 46 chars)
- `CCP_ART[1]` — a compact bust variant (~20 lines × 38 chars)
- `CCP_ART[2]` — a dense fill portrait (~28 lines × 42 chars)

The actual strings are included as literal constants in the implementation — they are
well-known public-domain counter-censorship art widely reproduced across the internet.

### Canvas texture builder — `buildBrailleTexture(artStr, opts)`

```
buildBrailleTexture(artStr, opts = {}) → THREE.CanvasTexture
```

- Parse `artStr` by `\n` into `lines`.
- Canvas size: `768 × 512` px (landscape; ~3:2 aspect ratio).
- Background: fully transparent (`clearRect` only — leave default transparent).
- Font: `'16px monospace'`, fill style `#ff2020`, text baseline `top`.
- Measure max line width; compute `xOffset` to center horizontally.
- Compute `yStep = canvas.height / (lines.length + 2)`, starting y at `yStep`.
- Draw each line with `fillText(lines[i], xOffset, y + i * yStep)`.
- `tex.needsUpdate = true` after creation; caller owns disposal.

Canvas size 768×512 intentionally leaves horizontal padding at both ends.

### Plane mesh

Each panel:
```
geom = new THREE.PlaneGeometry(panelW, panelH)
mat  = new THREE.MeshBasicMaterial({
  map:         canvasTex,
  transparent: true,
  opacity:     0,           // driven each frame
  depthWrite:  false,
  side:        THREE.DoubleSide,
  blending:    THREE.AdditiveBlending,
})
mesh = new THREE.Mesh(geom, mat)
```

`panelW = 16 * _ccpScale`, `panelH = panelW * (512/768)` (preserves canvas aspect).
`AdditiveBlending` — red light adds to the dark background without subtracting green from the rain.

### Panel positions and phases

Three panels at fixed azimuths, outside the rain shell:

| idx | Azimuth (rad) | Radius | Y offset | Flash phase (rad) |
|-----|--------------|--------|----------|-------------------|
| 0   | 0.0          | 22     | +1.5     | 0.0               |
| 1   | 2.094 (120°) | 24     | −1.0     | 2.094             |
| 2   | 4.189 (240°) | 21     | +2.5     | 4.189             |

Position: `x = Math.sin(az) * r`, `y = yOffset`, `z = -Math.cos(az) * r`
(−cos so az=0 places panel at −Z, directly behind the shell from the default camera position).

### CCP state in `initMatrixRain` closure

```js
let _ccpActive      = false;
let _ccpFadeT       = 0;      // 0 = hidden, 1 = fully visible
let _ccpFadeDir     = 0;      // +1 fading in, -1 fading out, 0 stable
let _ccpPanels      = [];     // { mesh, canvasTex, phase, yBase }
let _ccpFlashHz     = 1.2;    // default flash frequency
let _ccpPeakOpacity = 0.72;   // peak opacity at full fade
let _ccpScale       = 1.0;    // plane size multiplier
let _ccpPanelCount  = 3;      // active panels (1–3)
let _ccpOrbitSpeed  = 0.0;    // azimuthal orbit rad/s (default 0)
let _ccpOrbitAngle  = 0.0;    // accumulated orbit angle
```

### Per-frame update in `tick(t)`

Appended to the end of the existing `tick` function, just before it returns:

```js
// ── CCP mode panel animation ──────────────────────────────────────────
if (_ccpFadeDir !== 0 || _ccpPanels.length > 0) {
  if (_ccpFadeDir !== 0) {
    const speed = _ccpFadeDir > 0 ? (1 / 0.8) : (1 / 0.5);
    _ccpFadeT = Math.max(0, Math.min(1, _ccpFadeT + _ccpFadeDir * dt * speed));
    if (_ccpFadeT <= 0 && _ccpFadeDir < 0) {
      _destroyCCPPanels();
      _ccpFadeDir = 0;
    }
    if (_ccpFadeT >= 1) _ccpFadeDir = 0;
  }
  _ccpOrbitAngle += _ccpOrbitSpeed * dt;
  for (let i = 0; i < _ccpPanels.length; i++) {
    const p   = _ccpPanels[i];
    const az  = _CCP_POSES[i].az + _ccpOrbitAngle;
    const r   = _CCP_POSES[i].r;
    p.mesh.position.set(Math.sin(az) * r, p.yBase + Math.sin(t * 0.4 + p.phase) * 0.4, -Math.cos(az) * r);
    p.mesh.quaternion.copy(camera.quaternion);   // billboard
    const flash = 0.5 + 0.5 * Math.sin(t * _ccpFlashHz * Math.PI * 2 + p.phase);
    p.mesh.material.opacity = _ccpPeakOpacity * flash * _ccpFadeT;
  }
}
```

`Math.sin(t * 0.4 + p.phase) * 0.4` gives a slow ±0.4 world-unit vertical float per panel, staggered by phase.

### `_initCCPPanels()` helper

Creates canvas textures and meshes for `_ccpPanelCount` panels, adds to `scene`.
Uses `CCP_ART[i % CCP_ART.length]` for art selection.
Stores each as `{ mesh, canvasTex, phase: _CCP_POSES[i].phase, yBase: _CCP_POSES[i].y }` in `_ccpPanels`.

### `_destroyCCPPanels()` helper

For each panel: `scene.remove(p.mesh)`, `p.mesh.geometry.dispose()`,
`p.mesh.material.dispose()`, `p.canvasTex.dispose()`. Clears `_ccpPanels = []`.

Must also be called in `_cleanup()` to ensure disposal on `destroyMatrixRain`.

### Handle methods

| Method | Description |
|---|---|
| `setCCPMode(on)` | Activate (true) or deactivate (false) CCP mode. On activate: calls `_initCCPPanels()`, sets `_ccpFadeDir = +1`. On deactivate: sets `_ccpFadeDir = -1` (panels destroyed after fade). |
| `setCCPFlashRate(hz)` | Flash frequency 0.1–4 Hz (default 1.2). |
| `setCCPOpacity(v)` | Peak opacity 0–1 (default 0.72). |
| `setCCPScale(v)` | Panel size multiplier 0.5–3 (default 1.0). Recreates panels if active. |
| `setCCPPanelCount(n)` | Active panels 1–3 (default 3). Recreates panels if active. |
| `setCCPOrbitSpeed(v)` | Azimuthal orbit speed rad/s, default 0. |

`setCCPScale` and `setCCPPanelCount` destroy and reinit panels because geometry/count changes require rebuilding the mesh array. The pattern:
```js
setCCPScale(v) {
  _ccpScale = v;
  if (_ccpActive) { _destroyCCPPanels(); _initCCPPanels(); }
},
```

### `#ccp-panel` in `matrix-3d.html`

A `<div id="ccp-panel">` sub-panel appended after the last existing sub-panel.
Initially `style="display:none"`. Toggled by the keylogger handler.

Border/header styled in red (`#ff2020`) to visually distinguish it:
```
border-top: 1px solid #ff202044
header label color: #ff6060
```

Controls:
- `— ☭ CCP MODE ☭ —` section label (red)
- Flash rate slider (0.1–4, step 0.1, default 1.2) → `rain.setCCPFlashRate(v)`
- Peak opacity slider (0–1, step 0.01, default 0.72) → `rain.setCCPOpacity(v)`
- Scale slider (0.5–3, step 0.1, default 1.0) → `rain.setCCPScale(v)`
- Panel count select (1/2/3, default 3) → `rain.setCCPPanelCount(n)`
- Orbit speed slider (0–0.5, step 0.01, default 0) → `rain.setCCPOrbitSpeed(v)`
- `[DISABLE]` button — calls `rain.setCCPMode(false)`, hides panel (same as retyping the sequence)
- Red override checkbox (unchecked, disabled) — reserved label: `Rain red (TODO)`

### Hint flash — `matrix-3d.html`

The existing `#hint` element (bottom-left, green, low-opacity) is used.
On CCP mode toggle:
```js
const hint = document.getElementById('hint');
const prev = hint.textContent;
const prevColor = hint.style.color;
hint.textContent = _ccpActive ? '[ CCP MODE ACTIVATED ]' : '[ CCP MODE DEACTIVATED ]';
hint.style.color = '#ff2020';
hint.style.opacity = '0.9';
setTimeout(() => {
  hint.textContent = prev;
  hint.style.color  = prevColor;
  hint.style.opacity = '0.35';
}, 2000);
```

---

## Design Decisions

- **Library vs. HTML split**: Keylogger lives in `matrix-3d.html`; library exposes `setCCPMode()`. This keeps the library free of demo-specific keyboard hacks and lets other consumers decide whether/how to trigger the mode.
- **Plain MeshBasicMaterial, not TSL**: Braille planes are simple canvas textures. TSL would add complexity with zero benefit. TSL uniforms stay in the rain glyph material.
- **AdditiveBlending**: Red + black background = red. Red + green rain = orange/yellow in overlap zones — looks dramatic and intentional rather than like a layering bug.
- **No scene depth write**: `depthWrite: false` prevents the large background planes from occluding rain columns when the camera rotates.
- **Panels at `_CCP_POSES` fixed positions**: Consistent placement means the art is always fully visible from the default camera angle. If the user rotates, the other panels come into view.
- **No `opts.ccpEgg`**: The easter egg is always-on in the demo. It's a surprise; a config flag would break the illusion.

---

## Configuration

No config file entries. All parameters are adjustable via handle methods and the hidden panel at runtime.

---

## Files Changed

### Modified
- `matrix-rain-webgpu.js` — `CCP_ART` constants, `_CCP_POSES` table, CCP state vars in closure, `_initCCPPanels`, `_destroyCCPPanels`, tick update block, handle methods, `_cleanup` guard
- `matrix-3d.html` — keylogger, `#ccp-panel` HTML, hint flash JS, panel show/hide wiring

### New
*(none)*

---

## Implementation Plan

**Step 1** — Add `CCP_ART` array and `_CCP_POSES` table as module-level constants in `matrix-rain-webgpu.js`, just before `initMatrixRain`.

**Step 2** — Add `buildBrailleTexture(artStr)` helper in `matrix-rain-webgpu.js` (module scope, near other canvas helpers).

**Step 3** — Add CCP state variables (`_ccpActive`, `_ccpFadeT`, etc.) to the `initMatrixRain` closure, just below the message reveal state block.

**Step 4** — Add `_initCCPPanels()` and `_destroyCCPPanels()` as inner functions of `initMatrixRain`.

**Step 5** — Add the CCP animation block to the end of `tick(t)`, after the message state machine block.

**Step 6** — Add `_destroyCCPPanels()` call to `_cleanup()`.

**Step 7** — Add the 6 handle methods (`setCCPMode`, `setCCPFlashRate`, `setCCPOpacity`, `setCCPScale`, `setCCPPanelCount`, `setCCPOrbitSpeed`) to the handle object.

**Step 8** — Add `#ccp-panel` HTML sub-panel to `matrix-3d.html` (after the last existing sub-panel, before closing `</div>` of the controls flex container).

**Step 9** — Add keylogger + hint flash JS to `matrix-3d.html` script block, wired to the panel toggle.

---

## State Changes

No `OrchestratorState` (this is not the agent codebase). Closure state in `initMatrixRain`:

| Variable | Type | Added/Modified | Purpose |
|---|---|---|---|
| `_ccpActive` | bool | Added | Mode flag |
| `_ccpFadeT` | float | Added | Fade envelope 0–1 |
| `_ccpFadeDir` | int | Added | +1/−1/0 fade direction |
| `_ccpPanels` | array | Added | Active panel objects |
| `_ccpFlashHz` | float | Added | Flash frequency |
| `_ccpPeakOpacity` | float | Added | Max opacity |
| `_ccpScale` | float | Added | Size multiplier |
| `_ccpPanelCount` | int | Added | 1–3 active panels |
| `_ccpOrbitSpeed` | float | Added | Azimuthal orbit rad/s |
| `_ccpOrbitAngle` | float | Added | Accumulated orbit angle |

---

## Capabilities Required

None beyond existing (no GPU compute, no new imports).

---

## Cost Impact

- 3 extra draw calls per frame (one per braille panel) — negligible.
- 3 `768×512` canvas textures held in GPU memory when active — ~4.5 MB total.
- Zero cost when CCP mode is off and panels are destroyed.

---

## Error Conditions

| Scenario | Handling |
|---|---|
| `setCCPMode(true)` called when already active | `_initCCPPanels` is a no-op if `_ccpPanels.length > 0` |
| `destroyMatrixRain` called while CCP mode active | `_cleanup` calls `_destroyCCPPanels` before renderer disposal |
| `setCCPScale` / `setCCPPanelCount` called while fading out | Guard: only rebuild if `_ccpActive === true` |
| Canvas 2D text rendering with zero lines | `buildBrailleTexture` returns empty transparent texture |

---

## Determinism Impact

None — CCP panels use `Math.sin(t * ...)` which follows `uTime`, same as the rest of the rain. Freeze mode (`_frozen = true`) stops `uTime` from advancing; CCP panels would freeze too (flash holds last value). Acceptable.

---

## Backward Compatibility

No existing API changes. `setCCPMode` is new. The demo `matrix-3d.html` gains a hidden panel section with no visible effect until the sequence is typed.

---

## Test Plan

No automated tests possible (canvas 2D, Three.js scene mutation). Manual verification:

| Step | Action | Expected |
|---|---|---|
| 1 | Load `matrix-3d.html`, type `xijinping` | 3 red braille panels fade in behind the rain; `#ccp-panel` appears in settings |
| 2 | Observe panels for 5 s | Each panel flashes at ~1.2 Hz, floats vertically, faces camera |
| 3 | Orbit camera via mouse drag | Panels billboard correctly; all 3 rotate into/out of view |
| 4 | Adjust Flash rate slider to 0.1 | Flash rate visibly slows |
| 5 | Adjust Peak opacity to 0 | Panels invisible |
| 6 | Adjust Scale to 2 | Panels visibly larger |
| 7 | Set Panel count to 1 | Only one panel visible |
| 8 | Set Orbit speed to 0.2 | Panels slowly orbit around origin |
| 9 | Click `[DISABLE]` button | Panels fade out; `#ccp-panel` hides |
| 10 | Type `xijinping` again | Mode re-activates |
| 11 | Type `xijinping` to deactivate, immediately call `destroyMatrixRain` | No memory leak, no console errors |
| 12 | Type partial sequence `xijinpin` then wait 3 s, continue typing | Buffer expired; must retype full sequence |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Panels occlude rain in front | Low | Visual | `depthWrite: false` + far background position |
| Texture memory leak on destroy | Low | Memory | `_destroyCCPPanels` in `_cleanup`, confirmed by DevTools memory snapshot |
| Flash phase causes panels to all vanish simultaneously | Low | Visual | Phase offsets of 2π/3 between panels ensure at least one is always partially lit |
| `THREE.MeshBasicMaterial.opacity` + AdditiveBlending interaction | Low | Visual | Additive blending: opacity=0 → invisible (correct), no unexpected artefacts |

---

## Interaction with Other Specs

- **SPEC-katakana-atlas / SPEC-msdf-upgrade**: No interaction. CCP planes bypass the MSDF atlas system entirely.
- **SPEC-glyph-fx-controls**: No interaction. CCP panels have no glyph shader uniforms.
- **Message reveal**: No interaction. Separate scene objects; no shared state.
