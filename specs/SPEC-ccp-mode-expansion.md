# SPEC-ccp-mode-expansion

**Status**: Approved
**Priority**: P2 — easter egg / fun
**Depends on**: ccp-easter-egg
**Goal**: Extend CCP mode from braille billboards only into a full scene takeover — rain goes red and upward, flag and Tiananmen Gate billboards appear, a surveillance HUD overlay activates, censorship bars sweep the screen, propaganda slogans cycle through the message reveal system, and an optional national anthem plays.

---

## Problem

The base CCP easter egg (SPEC-ccp-easter-egg) produces braille Xi portraits with a hidden settings panel. The experience is visual but thin: the green rain continues unaffected, there are no Chinese cultural symbols beyond the portraits, and no DOM layer. The analysis (see `Matrix_Rain_Research_20260323/`) identified a set of zero-cost and low-cost additions that would make the mode feel like a genuine alternate world rather than an overlay.

---

## Goals

1. `setCCPMode(true)` applies a full scene package: rain turns red/gold, charset switches to Chinese, columns reverse to flow upward. Reversible on deactivate.
2. Two additional billboard planes join the scene: a canvas-rendered PRC five-star flag and a Tiananmen Gate ASCII art panel. Both billboard to face the camera.
3. A `#ccp-hud` DOM element (fixed top banner) shows camera ID, REC indicator, a social credit score incrementing in real time, and mouse coordinates.
4. A `#ccp-tint` transparent red overlay washes the entire viewport with a faint red tint.
5. Two horizontal bars sweep continuously from top to bottom of the screen (censorship scanner aesthetic).
6. `showMessage()` cycles CCP slogans (5 entries, looping) while CCP mode is active.
7. An opt-in audio checkbox plays a sine-wave rendition of 义勇军进行曲 (March of the Volunteers) via Web Audio API, looping until CCP mode is deactivated.
8. A "Rain override" checkbox in `#ccp-panel` (default checked) gates goals 1; when unchecked, billboards still appear but rain is left unchanged.
9. All additions clean up completely when `setCCPMode(false)` is called or `destroyMatrixRain` is called.

## Non-Goals

- No shader changes of any kind.
- No new atlas / glyph sets. The Chinese charset is already present.
- No modification to `matrix-rain-tsl.js`, `matrix-rain-passes-tsl.js`, or `matrix-rain-presets.js`.
- No persistence across page reloads.
- Simplified Chinese glyph set deferred (Traditional Chinese is sufficient and already committed).
- Harmony strobe deferred (requires coordinated timing across multiple systems; not worth it yet).

---

## Design

### A. Rain scene package — `setCCPMode` augmentation in `matrix-rain-webgpu.js`

**On activate (`setCCPMode(true)`):**

Save current rain state to `_ccpSaved` before any mutation:
```js
_ccpSaved = {
  colorR:        uniforms.uColor.value.x,
  colorG:        uniforms.uColor.value.y,
  colorB:        uniforms.uColor.value.z,
  color2R:       uniforms.uColor2.value.x,
  color2G:       uniforms.uColor2.value.y,
  color2B:       uniforms.uColor2.value.z,
  charSet:       _currentCharSet,
  reverseChance: uniforms.uReverseChance.value,
  vignette:      _ppState.vignette,
  aberration:    _ppState.aberration,
};
```

Then, **only if `_ccpRainOverride` is true** (the "Rain override" checkbox):
```js
handle.setColor('#DE2910');          // PRC red
handle.setColor2('#FFDE00');         // PRC gold for column heads
handle.setCharSet('chinese');        // Traditional Chinese glyph set
handle.setReverseChance(1.0);        // all columns flow upward
handle.setVignette(0.85);           // heavy vignette (rain mode only — no-op in crt/none)
handle.setHoloAberration(0.012);    // strong aberration (rain mode only)
handle.triggerSpeedRamp(3.0, 1.2);  // dramatic surge on entry
```

**On deactivate (`setCCPMode(false)`):**

Restore only if `_ccpSaved` is non-null:
```js
if (_ccpSaved) {
  handle.setColor (toHex(_ccpSaved.colorR,  _ccpSaved.colorG,  _ccpSaved.colorB));
  handle.setColor2(toHex(_ccpSaved.color2R, _ccpSaved.color2G, _ccpSaved.color2B));
  handle.setCharSet(_ccpSaved.charSet);
  handle.setReverseChance(_ccpSaved.reverseChance);
  handle.setVignette(_ccpSaved.vignette);
  handle.setHoloAberration(_ccpSaved.aberration);
  _ccpSaved = null;
}
```

`toHex(r, g, b)` is a tiny inline helper:
```js
function toHex(r, g, b) {
  return '#' + [r, g, b].map(v =>
    Math.round(v * 255).toString(16).padStart(2, '0')
  ).join('');
}
```

**New closure state vars** (alongside existing `_ccpActive`, `_ccpFadeT`, etc.):
```js
let _ccpSaved        = null;          // saved rain properties, or null
let _ccpRainOverride = true;          // "Rain override" checkbox state
let _currentCharSet  = charSet;       // tracks active charset name; updated in setCharSet()
let _ccpSloganActive = true;          // "Slogans" checkbox state
let _ccpSloganTimer  = null;          // setTimeout handle for slogan cycling
let _ccpSloganIdx    = 0;             // next slogan to display
let _ccpExtraMeshes  = [];            // flag + Tiananmen panel meshes
```

`_currentCharSet` requires a one-line addition at the top of `setCharSet()`:
```js
setCharSet(name) {
  _currentCharSet = name;   // ← add this line
  const descriptor = CHAR_SETS[name];
  // ... rest unchanged
```

---

### B. Extra billboard panels — `_ccpExtraMeshes`

Two additional canvas-texture billboard planes, created by `_initCCPExtras()` when `setCCPMode(true)` fires, destroyed by `_destroyCCPExtras()`.

Architecture is identical to the Xi braille panels in the base spec: `THREE.Mesh` + `THREE.MeshBasicMaterial({ transparent, AdditiveBlending, depthWrite:false })`, quaternion-billboarded each tick, driven by a fade envelope.

The extra meshes share `_ccpFadeT` with the braille panels — same fade-in/out envelope governs all CCP scene objects together.

#### B1. Five-star flag — `buildFlagTexture()`

Canvas `512 × 341` (3:2 flag ratio). Module-scope helper, called once per activation.

```
- fillStyle '#DE2910', fillRect full canvas
- fillStyle '#FFDE00'
- Large star: center (170, 85) = (10/30 × 512, 5/20 × 341)
              outerR=51, innerR=21, 5 points, rotation=-π/2 (point up)
- Small stars (in arc around large):
    (256, 34)  = (15/30×512, 2/20×341)
    (291, 68)  = (17/30×512, 4/20×341)
    (291, 116) = (17/30×512, 7/20×341)
    (256, 153) = (15/30×512, 9/20×341)
  each outerR=20, innerR=8, 5 points, rotation = atan2(largeStarCY - starCY, largeStarCX - starCX) - π/2
  (each small star's point aims toward the center of the large star)
```

Star drawing subroutine (shared with Tiananmen if needed):
```js
function drawStar(ctx, cx, cy, outerR, innerR, points, rotation) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r     = i % 2 === 0 ? outerR : innerR;
    const angle = rotation + i * Math.PI / points;
    i === 0 ? ctx.moveTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle))
            : ctx.lineTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
  }
  ctx.closePath();
  ctx.fill();
}
```

Flag panel mesh:
- `PlaneGeometry(14 * _ccpScale, 14 * _ccpScale * (341/512))`
- Position: azimuth 0.52 rad (30°), radius 15, Y = +4.0
  (`x = Math.sin(0.52)*15`, `z = -Math.cos(0.52)*15`)
- Flash: **slow steady pulse** — `0.4 + 0.15 * Math.sin(t * 0.6)`, no phase offset.
  Slower than the portrait flicker; feels permanent/authoritative.

#### B2. Tiananmen Gate — `buildTiananmenTexture()`

Canvas `768 × 480`. Gold text on red background.

```
- fillStyle '#DE2910', fillRect full canvas
- font '15px monospace', fillStyle '#FFDE00'
- Render TIANANMEN_ART (module-level const, ~20 lines of ASCII/box-drawing)
  centered both axes (same logic as buildBrailleTexture)
- Below the art, smaller text: '天安门'  (14px, centered, 20px below last art line)
```

`TIANANMEN_ART` constant — a ~20-line, ~52-char ASCII art of Tiananmen Gate using box-drawing Unicode characters (╔╗╚╝═║─│▲█░▓). Defined at module scope alongside `CCP_ART`.

Gate panel mesh:
- `PlaneGeometry(13 * _ccpScale, 13 * _ccpScale * (480/768))`
- Position: azimuth π rad (180°, directly "in front" as the camera orbits — behind the shell from default Z+), radius 20, Y = −3.0
- Opacity: **static** — `0.45 * _ccpFadeT`. No oscillation — it reads as a fixed monument.

#### B3. Extra mesh tick update

Append to the existing CCP tick block in `tick(t)`, inside the `_ccpFadeDir !== 0 || _ccpPanels.length > 0` guard (extend guard to also check `_ccpExtraMeshes.length`):

```js
for (const m of _ccpExtraMeshes) {
  m.mesh.quaternion.copy(camera.quaternion);
  m.mesh.material.opacity = m.opacityFn(t, _ccpFadeT);
}
```

Each `_ccpExtraMeshes` entry: `{ mesh, canvasTex, opacityFn }`.

---

### C. Slogan cycling via `showMessage()`

Five slogans stored as a module-level constant array `CCP_SLOGANS`:

```js
const CCP_SLOGANS = [
  '为人民服务',         // Serve the People
  '中国梦',            // Chinese Dream
  '不忘初心',          // Never Forget the Original Mission
  '和谐社会',          // Harmonious Society
  '天安门',            // Tiananmen (the provocative one)
];
```

On `setCCPMode(true)`, if `_ccpSloganActive`:
```js
function _startSlogans() {
  if (!_ccpSloganActive) return;
  _ccpSloganIdx = 0;
  function showNext() {
    if (!_ccpActive || !_ccpSloganActive) return;
    handle.showMessage(CCP_SLOGANS[_ccpSloganIdx % CCP_SLOGANS.length], {
      revealDuration: 1.2,
      holdDuration:   3.0,
      fadeDuration:   0.8,
      boost:          4.0,
    });
    _ccpSloganIdx++;
    _ccpSloganTimer = setTimeout(showNext, (1.2 + 3.0 + 0.8 + 1.5) * 1000);
  }
  _ccpSloganTimer = setTimeout(showNext, 2500); // delay: let speed ramp settle first
}
```

On `setCCPMode(false)`:
```js
clearTimeout(_ccpSloganTimer);
_ccpSloganTimer = null;
```

No new handle methods — `showMessage` is already part of the public API.

---

### D. Surveillance HUD — `matrix-3d.html` DOM

A fixed-position banner at top of viewport, styled in red monospace phosphor. Only visible when `_ccpActive`.

#### HTML

```html
<div id="ccp-hud" style="display:none">
  <span id="ccp-hud-left">⊠ CAM-01 · <span id="ccp-rec">●REC</span></span>
  <span id="ccp-hud-center">SOCIAL CREDIT: <span id="ccp-score">---</span></span>
  <span id="ccp-coords">(X:0000 Y:0000) · <span id="ccp-time">--:--:--</span></span>
  <span style="margin-left:8px;">⊠</span>
</div>
```

#### CSS

```css
#ccp-hud {
  position: fixed;
  top: 0; left: 0; right: 0;
  z-index: 200;
  background: rgba(0,0,0,0.82);
  border-bottom: 1px solid #DE2910;
  color: #ff4040;
  font-family: 'Courier New', monospace;
  font-size: 11px;
  letter-spacing: 0.1em;
  padding: 4px 10px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  pointer-events: none;
}
```

#### JS

```js
let _ccpScore    = 0;
let _ccpHudTimer = null;

function _startHUD() {
  _ccpScore = 700 + Math.floor(Math.random() * 200);
  document.getElementById('ccp-score').textContent = _ccpScore;
  document.getElementById('ccp-hud').style.display = 'flex';
  _ccpHudTimer = setInterval(() => {
    _ccpScore++;
    document.getElementById('ccp-score').textContent = _ccpScore;
    const now = new Date();
    document.getElementById('ccp-time').textContent =
      now.toTimeString().slice(0, 8);
  }, 2000);
}

function _stopHUD() {
  clearInterval(_ccpHudTimer);
  _ccpHudTimer = null;
  document.getElementById('ccp-hud').style.display = 'none';
}

// Mouse coordinate tracking (always active, HUD reads it when visible)
let _mx = 0, _my = 0;
document.addEventListener('mousemove', e => { _mx = e.clientX; _my = e.clientY; });

// In the existing rAF loop or a separate 100ms interval, update coords:
setInterval(() => {
  if (!_ccpActive) return;
  document.getElementById('ccp-coords').textContent =
    `(X:${String(_mx).padStart(4,'0')} Y:${String(_my).padStart(4,'0')})`;
}, 100);
```

#### [DEDUCT] button in `#ccp-panel`

Wire a new `[DEDUCT 50]` button in the CCP panel:
```js
document.getElementById('ccp-deduct').addEventListener('click', () => {
  _ccpScore = Math.max(0, _ccpScore - 50);
  document.getElementById('ccp-score').textContent = _ccpScore;
  const hud = document.getElementById('ccp-hud');
  hud.style.borderColor = '#ff0000';
  hud.style.color       = '#ff0000';
  setTimeout(() => {
    hud.style.borderColor = '#DE2910';
    hud.style.color       = '#ff4040';
  }, 800);
});
```

---

### E. Red tint overlay — `matrix-3d.html`

```html
<div id="ccp-tint" style="display:none"></div>
```

```css
#ccp-tint {
  position: fixed;
  inset: 0;
  background: rgba(222, 41, 16, 0.06);  /* default; adjustable via slider */
  pointer-events: none;
  z-index: 10;
}
```

On activate: `document.getElementById('ccp-tint').style.display = 'block'`.
On deactivate: `style.display = 'none'`.

Tint opacity is driven by the CCP panel slider (`#ccp-tint-opacity`, range 0–0.2, step 0.005, default 0.06):
```js
document.getElementById('ccp-tint-opacity').addEventListener('input', e => {
  document.getElementById('ccp-tint').style.background =
    `rgba(222, 41, 16, ${e.target.value})`;
});
```

---

### F. Censorship sweep bars — `matrix-3d.html`

Two horizontal `<div>` bars that sweep from top to bottom of the viewport on a staggered loop.

```html
<div class="ccp-sweep" id="ccp-sweep-0" style="display:none"></div>
<div class="ccp-sweep" id="ccp-sweep-1" style="display:none"></div>
```

```css
.ccp-sweep {
  position: fixed;
  left: 0; right: 0;
  height: 2px;
  background: linear-gradient(to right,
    transparent 0%, rgba(222,41,16,0.7) 15%, rgba(222,41,16,0.7) 85%, transparent 100%);
  pointer-events: none;
  z-index: 15;
  top: -4px;
}
```

JS animation — shared rAF loop:
```js
const _sweepPhase = [0.0, 0.5];     // bar 1 offset by half a cycle
const SWEEP_PERIOD = 11000;          // ms per full top→bottom sweep

let _sweepRafId = null;

// Demo-local boolean mirrors CCP active state for DOM animation guards.
// Toggled by the keylogger and [DISABLE] handler at the same time as rain.setCCPMode().
let _ccpEnabled = false;

function _animateSweep(now) {
  if (!_ccpEnabled) return;
  for (let i = 0; i < 2; i++) {
    const t   = ((now % SWEEP_PERIOD) / SWEEP_PERIOD + _sweepPhase[i]) % 1.0;
    const pct = t * 105 - 2;   // -2% to 103% — enters/exits just off-screen
    document.getElementById(`ccp-sweep-${i}`).style.top = `${pct}vh`;
  }
  _sweepRafId = requestAnimationFrame(_animateSweep);
}

function _startSweep() {
  document.querySelectorAll('.ccp-sweep').forEach(el => el.style.display = 'block');
  _sweepRafId = requestAnimationFrame(_animateSweep);
}

function _stopSweep() {
  cancelAnimationFrame(_sweepRafId);
  _sweepRafId = null;
  document.querySelectorAll('.ccp-sweep').forEach(el => el.style.display = 'none');
}
```

---

### G. National anthem audio — `matrix-3d.html`

Opt-in only (checkbox in CCP panel, default unchecked). Not started automatically; started when the checkbox is checked while CCP mode is active.

#### `SafeMelodyPlayer` class

```js
class SafeMelodyPlayer {
  constructor() { this.ctx = null; this.loopId = null; }

  init() {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) { console.warn('[ccp-audio] no AudioContext', e); }
    return this.ctx;
  }

  playNote(freq, dur, startTime) {
    if (!this.ctx || freq <= 0) return;   // freq=0 = rest; skip silently
    const osc  = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.type           = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(0.12, startTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + dur - 0.02);
    osc.start(startTime);
    osc.stop(startTime + dur);
  }

  playMelody(notes) {
    const ctx = this.init();
    if (!ctx) return 0;
    if (ctx.state === 'suspended') ctx.resume();
    let t = ctx.currentTime + 0.05;
    for (const [freq, dur] of notes) {
      this.playNote(freq, dur, t);
      t += dur;
    }
    return t - ctx.currentTime;  // total duration in seconds
  }

  stop() {
    clearTimeout(this.loopId);
    this.loopId = null;
    if (this.ctx) { this.ctx.close(); this.ctx = null; }
  }

  startLoop(notes) {
    const schedule = () => {
      const dur = this.playMelody(notes);
      this.loopId = setTimeout(schedule, (dur + 2.0) * 1000); // 2s gap between loops
    };
    schedule();
  }
}
```

#### Anthem note data — `CCP_ANTHEM_NOTES`

Module-level constant (demo JS), 32 notes of 义勇军进行曲 opening at 120 BPM (quarter = 0.5 s):

```js
// [frequency Hz, duration s]
// March of the Volunteers — opening phrase, C major
const CCP_ANTHEM_NOTES = [
  [262,0.50],[262,0.25],[330,0.25],[392,0.50],[392,0.25],[440,0.25],
  [494,0.50],[523,0.50],[523,0.25],[494,0.25],[440,0.50],[440,0.25],
  [392,0.75],[330,0.25],[330,0.25],[294,0.25],[262,0.50],[0,0.50],
  [262,0.50],[294,0.25],[330,0.25],[392,0.50],[440,0.25],[494,0.25],
  [523,0.50],[659,0.50],[659,0.25],[587,0.25],[523,0.50],[494,0.50],
  [440,1.00],[0,0.50],
];
// freq=0 → rest (silence); playNote skips freq<=0
```

#### Wiring

```js
const _melodyPlayer = new SafeMelodyPlayer();

document.getElementById('ccp-audio').addEventListener('change', e => {
  if (e.target.checked && _ccpActive) {
    _melodyPlayer.startLoop(CCP_ANTHEM_NOTES);
  } else {
    _melodyPlayer.stop();
  }
});

// Stop audio on CCP deactivate regardless of checkbox state
// Called from the keylogger / disable button handler:
function _stopAllCCPAudio() {
  _melodyPlayer.stop();
  document.getElementById('ccp-audio').checked = false;
}
```

---

### H. Updated `#ccp-panel` controls

Augment the panel defined in the base spec with these additions (after the existing Orbit speed slider, before the [DISABLE] button):

```
— Rain —
[✓] Rain override     (checkbox, id="ccp-rain-override", checked)
    When unchecked: setCCPMode still shows billboards but leaves rain color/charset/reverse untouched.

— Ambiance —
Tint opacity slider   (0–0.20, step 0.005, default 0.06)  → #ccp-tint background-color alpha

— Content —
[✓] Slogans           (checkbox, id="ccp-slogans", checked)
    When unchecked: no showMessage calls while in CCP mode. Clears active slogan immediately.
[  ] Anthem 🔈        (checkbox, id="ccp-audio", unchecked)
    When checked while active: starts SafeMelodyPlayer loop.

— Score —
Score: [847]          (read-only, id="ccp-score-display" mirrors #ccp-score in HUD)
[DEDUCT 50]           (button, id="ccp-deduct")
```

The `[DISABLE]` button and "Red override" stub from the base spec are:
- `[DISABLE]` — kept
- "Rain red (TODO)" stub — **replaced** by the functional "Rain override" checkbox above

---

### I. `#ccp-panel` "Rain override" and "Slogans" checkbox wiring

Checkboxes call the two new handle methods. Live changes update the library var; the new
value takes effect on the next `setCCPMode(true)` call. No immediate rain restore on
uncheck — the override only gates the next activation.

```js
document.getElementById('ccp-rain-override').addEventListener('change', e =>
  rain.setCCPRainOverride(e.target.checked));
document.getElementById('ccp-slogans').addEventListener('change', e =>
  rain.setCCPSlogans(e.target.checked));
```

---

## Design Decisions

- **Save/restore uses raw channel values, not THREE.Color**: `uniforms.uColor.value` is a `THREE.Vector3`, not a `THREE.Color`. Storing `{ r: v.x, g: v.y, b: v.z }` avoids clone() and works cleanly with `toHex()`.
- **`_currentCharSet` tracking added to `setCharSet()`**: A single `_currentCharSet = name` line at the top of the existing method. This is the minimal-touch approach — no getter, no API change.
- **Extra meshes share `_ccpFadeT`**: Consistent fade-in/out for the entire CCP scene package. No per-mesh fade envelope needed.
- **Flag at radius 15, Xi portraits at 22–24**: Flag is in the "midground" of the CCP layer; braille portraits are further back. Tiananmen at 20 between them. Creates depth layers within the easter egg itself.
- **Tiananmen panel: no oscillation**: The gate is a monument. Static opacity is more "official" than a flash. Contrast with the flashing braille portraits which feel chaotic/surveillance-like.
- **Slogans via `showMessage()`**: Zero new library code. `showMessage` already exists and handles the reveal animation. The cycling is entirely setTimeout chains in the library.
- **Anthem opt-in, audio checkbox in panel**: Auto-playing audio is universally annoying. The checkbox is unchecked by default. The AudioContext is created from the checkbox change event itself (a user gesture) — no separate permission required.
- **`square` wave oscillator**: Sounds like a retro 8-bit anthem. More satirically readable than a pure sine.
- **Sweep bars as DOM, not Three.js**: 2D horizontal lines don't need a scene mesh. DOM `<div>` is simpler, doesn't consume draw calls, and CSS `linear-gradient` gives them natural fade-in/out edges for free.
- **`_ccpRainOverride` gates next activation, not current**: Checkbox changes call `rain.setCCPRainOverride(bool)` which updates `_ccpRainOverride` inside the library closure. No immediate rain restore on toggle — the override only applies on the next `setCCPMode(true)` call. This is acceptable: users won't hot-swap the checkbox mid-scene, and it avoids the complexity of restoring rain without touching the billboard lifecycle.
- **Two thin handle methods for checkbox state**: `_ccpRainOverride` and `_ccpSloganActive` must live inside the library closure so `setCCPMode` can read them. They are exposed as `setCCPRainOverride(on)` and `setCCPSlogans(on)` — one-liners that write the closure vars. The demo checkbox handlers call these instead of accessing library internals.

---

## Configuration

No config file. All parameters runtime-adjustable via the hidden CCP panel.

---

## Files Changed

### Modified
- `matrix-rain-webgpu.js`
  - `CCP_SLOGANS` constant (module scope)
  - `TIANANMEN_ART` constant (module scope)
  - `drawStar()` helper (module scope)
  - `buildFlagTexture()` helper (module scope)
  - `buildTiananmenTexture()` helper (module scope)
  - `setCharSet()` — add `_currentCharSet = name` at top
  - `initMatrixRain` closure: `_currentCharSet`, `_ccpSaved`, `_ccpRainOverride`, `_ccpSloganActive`, `_ccpSloganTimer`, `_ccpSloganIdx`, `_ccpExtraMeshes`
  - `_initCCPExtras()`, `_destroyCCPExtras()` inner functions
  - `setCCPMode()` — save/restore block + `_initCCPExtras` / `_destroyCCPExtras` calls + slogan start/stop
  - `tick()` — extend CCP block to animate `_ccpExtraMeshes`
  - `_cleanup()` — add `_destroyCCPExtras()`
  - Handle: `setCCPRainOverride(on)`, `setCCPSlogans(on)` — new methods

- `matrix-3d.html`
  - CSS: `#ccp-hud`, `.ccp-sweep`, `#ccp-tint` rules
  - HTML: `#ccp-hud` banner, `#ccp-tint` overlay, `.ccp-sweep` × 2, augmented `#ccp-panel` controls
  - JS: `_ccpEnabled`, `toHex()`, `_ccpScore`, `_ccpHudTimer`, `_startHUD()`, `_stopHUD()`, `SafeMelodyPlayer`, `CCP_ANTHEM_NOTES`, `_melodyPlayer`, `_startSweep()`, `_stopSweep()`, `_stopAllCCPAudio()`, checkbox handlers, HUD coord interval, keylogger calls to new `_startHUD`/`_stopHUD`/`_startSweep`/`_stopSweep` with `_ccpEnabled` toggle

### New
*(none)*

---

## Implementation Plan

**Step 1** — Add module-scope constants to `matrix-rain-webgpu.js`:
  `CCP_SLOGANS` array, `TIANANMEN_ART` string, `drawStar()` helper.

**Step 2** — Add canvas helpers to `matrix-rain-webgpu.js`:
  `buildFlagTexture()` (uses `drawStar()`), `buildTiananmenTexture()` (uses text rendering only).

**Step 3** — Add `_currentCharSet = name` at the top of the existing `setCharSet()` method.

**Step 4** — Add new closure state vars to `initMatrixRain`:
  `_currentCharSet`, `_ccpSaved`, `_ccpRainOverride`, `_ccpSloganActive`, `_ccpSloganTimer`, `_ccpSloganIdx`, `_ccpExtraMeshes`.

**Step 5** — Add `_initCCPExtras()` and `_destroyCCPExtras()` inner functions.

**Step 6** — Add `toHex()` helper (module scope or inner function — either works).

**Step 7** — Augment `setCCPMode(on)` in the handle:
  When `on=true`: call `_initCCPExtras()`, save/restore block, rain overrides (behind `_ccpRainOverride`), call `_startSlogans()` (inner function, see Step 8).
  When `on=false`: call `_destroyCCPExtras()`, restore `_ccpSaved`, `clearTimeout(_ccpSloganTimer)`.

**Step 8** — Add `_startSlogans()` inner function (the recursive setTimeout chain using `handle.showMessage`).

**Step 9** — Extend the CCP animation block in `tick(t)` to iterate `_ccpExtraMeshes`.
  Extend the guard condition: `_ccpFadeDir !== 0 || _ccpPanels.length > 0 || _ccpExtraMeshes.length > 0`.

**Step 10** — Add `_destroyCCPExtras()` call to `_cleanup()`.

**Step 11** — Add `setCCPRainOverride(on)` and `setCCPSlogans(on)` to handle object.

**Step 12** — Add CSS rules for `#ccp-hud`, `.ccp-sweep`, `#ccp-tint` to `matrix-3d.html` `<style>`.

**Step 13** — Add HTML elements to `matrix-3d.html` body (before `#controls`): `#ccp-hud`, `#ccp-tint`, two `.ccp-sweep` divs.

**Step 14** — Augment `#ccp-panel` HTML in `matrix-3d.html`: add Rain override checkbox, Tint slider, Slogans checkbox, Anthem checkbox, Score display, [DEDUCT 50] button; replace the stub "Rain red (TODO)" label.

**Step 15** — Add demo JS to `matrix-3d.html`: `_ccpEnabled` boolean, `SafeMelodyPlayer` class, `CCP_ANTHEM_NOTES`, `_melodyPlayer` instance, `_startHUD`/`_stopHUD`/`_startSweep`/`_stopSweep`/`_stopAllCCPAudio` functions, HUD coord interval, checkbox event handlers.

**Step 16** — Wire `_startHUD`/`_stopHUD`/`_startSweep`/`_stopSweep`/`_stopAllCCPAudio` into the existing keylogger handler and the `[DISABLE]` button handler. Set `_ccpEnabled = true` on activate and `_ccpEnabled = false` on deactivate in both places.

---

## State Changes

New closure state in `initMatrixRain`:

| Variable | Type | Purpose |
|---|---|---|
| `_currentCharSet` | string | Tracks active charset name for save/restore |
| `_ccpSaved` | object\|null | Saved rain properties during CCP mode |
| `_ccpRainOverride` | bool | Whether rain color/charset/reverse override is active |
| `_ccpSloganActive` | bool | Whether slogan cycling is enabled |
| `_ccpSloganTimer` | number\|null | setTimeout handle for slogan chain |
| `_ccpSloganIdx` | int | Next slogan index in `CCP_SLOGANS` |
| `_ccpExtraMeshes` | array | Flag + Tiananmen billboard objects |

`_ccpScale` is **not** a new variable — it is defined by the base `ccp-easter-egg` spec and read here to size the extra billboard planes consistently. No declaration needed in this spec.

New demo-side state in `matrix-3d.html` script:

| Variable | Purpose |
|---|---|
| `_ccpEnabled` | Demo-local boolean mirroring CCP active state; toggled by keylogger/[DISABLE] handler; used as guard in `_animateSweep` |
| `_ccpScore` | Social credit score (integer) |
| `_ccpHudTimer` | setInterval handle for HUD update |
| `_sweepRafId` | rAF handle for sweep bar animation |
| `_mx`, `_my` | Mouse coordinates for HUD |
| `_melodyPlayer` | SafeMelodyPlayer instance |

---

## Capabilities Required

None beyond existing. Web Audio API is gracefully degraded if unavailable.

---

## Cost Impact

| Addition | GPU/CPU cost | Memory |
|---|---|---|
| Flag billboard | +1 draw call when active | ~0.5 MB (512×341 canvas tex) |
| Tiananmen billboard | +1 draw call when active | ~1.1 MB (768×480 canvas tex) |
| Save/restore (rain overrides) | Negligible (a few uniform writes) | 7 scalar fields |
| Slogan cycling | Negligible (setTimeout + showMessage) | Reuses existing msgTex |
| HUD + tint + sweep bars | DOM repaint ~100ms interval | Negligible |
| Anthem (when enabled) | OscillatorNodes auto-dispose after stop | Negligible |
| **Total when inactive** | Zero | Zero |

---

## Error Conditions

| Scenario | Handling |
|---|---|
| `setCharSet('chinese')` on activate when atlas PNG missing | `THREE.TextureLoader` logs a 404; rain keeps current atlas. Save/restore still works. |
| `setCCPMode(false)` when `_ccpSaved` is null (e.g. `_ccpRainOverride` was false) | Guard: restore only if `_ccpSaved !== null` |
| Anthem checkbox checked before rain init resolves | `SafeMelodyPlayer.init()` is safe to call at any time; AudioContext is created then |
| `destroyMatrixRain` with anthem playing | `_stopAllCCPAudio()` must be called from demo `destroy` / page unload |
| `setVignette` / `setHoloAberration` no-op in `crt`/`none` mode | Already guarded in existing handle methods — save/restore writes silently ignored |
| Sweep bar rAF continues after CCP deactivate if `_stopSweep` not called | Guard: `if (!_ccpEnabled) return` at top of `_animateSweep` as a final failsafe (`_ccpEnabled` is demo-local bool) |

---

## Determinism Impact

Rain overrides (color, charset, reverseChance) are deterministic. Slogan timing uses `setTimeout` (wall-clock) not `uTime` — slogans continue advancing even when rain is frozen. Acceptable: they're demo-layer, not shader-layer.

---

## Backward Compatibility

`setCharSet()` gains one line at the top — no signature change. Two new handle methods (`setCCPRainOverride`, `setCCPSlogans`) are additive. No existing methods change behaviour.

---

## Test Plan

| Step | Action | Expected |
|---|---|---|
| 1 | Type `xijinping` from default state | Rain turns red (columns), heads gold. Columns flow upward. Flag billboard visible at ~30° azimuth, Tiananmen visible behind. HUD banner appears. Red tint visible. Sweep bars traversing. |
| 2 | Wait 2.5 s | First slogan (为人民服务) reveals in rain, holds, fades |
| 3 | Wait for full slogan cycle | All 5 slogans cycle, then loop from first |
| 4 | Check the Anthem checkbox | Square-wave march plays. Loops with 2 s gap. |
| 5 | Uncheck Anthem | Melody stops. Checkbox unchecks. |
| 6 | Orbit camera | Flag and Tiananmen always face camera. Flag pulses slowly. Tiananmen static. |
| 7 | Uncheck "Rain override" | Library var `_ccpRainOverride` set to false. Rain color/charset/reverseChance are NOT immediately restored — change takes effect only on next `setCCPMode(true)`. Billboards and all other effects stay active. |
| 8 | Re-check "Rain override" | Library var `_ccpRainOverride` set to true. No immediate apply — rain stays as-is until next `setCCPMode(true)`. |
| 9 | Click [DEDUCT 50] | Score drops 50. HUD briefly turns bright red. |
| 10 | Type `xijinping` to deactivate | Rain color/charset/reverseChance/vignette/aberration all restore to pre-CCP values. HUD hides. Tint hides. Sweep stops. All billboards fade out and are disposed. |
| 11 | Reactivate immediately | Second activation fresh — new score, new phase |
| 12 | Deactivate then `destroyMatrixRain` | No console errors. No leaked setIntervals. |
| 13 | Tab/focus into an input field, then type "xijinping" via keyboard | Keylogger fires: buffer still accumulates since listener is on `document`, but `e.key.length !== 1` filters control keys; regular alphanumeric keys in text inputs still trigger the buffer. This is intentional — easter egg works even with focus in inputs. |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `_currentCharSet` stale after async `setCharSet` load failure | Low | Wrong charset restored on deactivate | Acceptable: charset name is saved before the async load, and a 404 doesn't change `_currentCharSet` |
| `THREE.Color('#DE2910')` parsing differs from custom uniform | Low | Slight color difference | `setColor` constructs a `THREE.Color` internally; hex parsing is deterministic |
| `setReverseChance(1.0)` with existing speed ramp in flight | Low | Visual | Speed ramp is independent of reverseChance; both are uniform writes |
| AudioContext autoplay policy varies by browser | Medium | No audio | `SafeMelodyPlayer` wraps in try/catch, gracefully no-ops. Checkbox-based init is a user gesture. |
| Sweep bar rAF not cancelled on destroy | Low | Leaked rAF | `_animateSweep` guard `if (!_ccpEnabled) return` is a fallback; `_stopSweep` in deactivate path is primary |
| Slogan timer fires after deactivate | Low | Spurious `showMessage` | `_startSlogans` guard `if (!_ccpActive) return` at the top of `showNext` |

---

## Interaction with Other Specs

- **SPEC-ccp-easter-egg**: Direct dependency. Augments `setCCPMode`, `_ccpFadeDir`, `_ccpPanels`, `_cleanup`. Implementation of this spec assumes the base spec is fully implemented first.
- **SPEC-msdf-upgrade / SPEC-katakana-atlas**: `setCharSet('chinese')` uses the `chinese_msdf.png` atlas generated in the MSDF upgrade. Already committed.
- **SPEC-glyph-fx-controls / SPEC-demo-params**: `setVignette`, `setHoloAberration`, `setReverseChance`, `triggerSpeedRamp` are all implemented. Save/restore relies on `_ppState.vignette` / `_ppState.aberration` being kept current by those methods — which they are.
- **Message reveal (SPEC-text-reveal)**: `showMessage()` is used for slogans. No state conflict — each `showMessage` call cancels the previous one, which is the desired behaviour.
