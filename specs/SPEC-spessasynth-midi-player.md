# SPEC-spessasynth-midi-player

**Status**: Draft
**Priority**: P2 - demo capability / audio integration

---

## Motivation

`matrix-3d.html` already exposes a large interactive demo surface, but its audio
support is limited to two hard-coded `new Audio()` elements used by the hidden
CCP and Mossad panels. The page does not provide a general MIDI playback path,
there is no SoundFont loading flow, and there is no transport UI for local MIDI
playback.

This spec adds a first-party MIDI player panel to the existing demo. The player
must feel native to the current page, remain friendly to local-file usage, and
avoid pushing synthesizer concerns into `matrix-rain-webgpu.js`.

---

## Goals

This section defines the user-visible outcome for the first iteration.

- Add a compact `MIDI player` section to `matrix-3d.html`
- Load one SoundFont file from local disk
- Load one MIDI file from local disk
- Provide play, pause, stop, seek, loop, and volume controls
- Keep the integration browser-native and compatible with the current
  import-map-based demo page
- Keep MIDI transport independent from the rain engine in v1

## Non-goals

This section defines work that is explicitly out of scope for this iteration.

- Audio-reactive shader sync
- Karaoke, lyrics, or subtitle rendering
- MIDI export or offline WAV rendering
- Multi-song playlists
- Editing MIDI events or SoundFont instruments
- Replacing the existing CCP or Mossad audio toggles
- Shipping a bundled default SoundFont in the repo

---

## Current repo constraints

This section records the implementation constraints that the spec must respect.

- `matrix-3d.html` is a browser-first module page with an inline import map
- `three` is loaded from a CDN, not from a local bundler output
- `package.json` is present for tests and tooling, but the demo page does not
  currently consume npm-built browser assets
- The page already owns demo-side audio controls for CCP and Mossad modes via
  `_anthemAudio`, `_havaNagilaAudio`, `_stopAllCCPAudio()`, and
  `_stopMossadAudio()`

Because of these constraints, the integration must not assume that installing an
npm package automatically makes it available to `matrix-3d.html`.

---

## Dependency and loading strategy

This section defines the required loading model for SpessaSynth.

The implementation must use the reusable SpessaSynth library layer, not the
standalone SpessaSynth application UI.

The integration must use one of these browser-loading paths:

1. A direct browser ESM import that works from `matrix-3d.html`
2. A checked-in vendor module under a local path such as `vendor/` or `lib/`
3. An import-map entry that resolves to a stable browser ESM build

The implementation must not depend on a bundler-only import path unless the repo
first gains an explicit browser build step. This spec does not add such a build
step.

`package.json` may gain a dependency entry only if that dependency also supports
the chosen browser-loading path and the implementation documents how the browser
page resolves it. Adding a package entry by itself is not sufficient.

If `spessasynth_lib` does not expose a browser-usable entry point that matches
this repo, the implementation must stop and re-scope to a documented lower-level
SpessaSynth path before coding against private APIs.

---

## UX surface

This section defines the new controls added to the demo page.

Add a new `details` subsection named `MIDI player` inside the existing controls
panel in `matrix-3d.html`. The new subsection must follow the same visual style
as the existing monospace controls.

The subsection must include:

- A **SoundFont file** picker
- A **MIDI file** picker
- A **Play** button
- A **Pause** button
- A **Stop** button
- A **Seek** slider
- A **Volume** slider
- A **Loop** checkbox
- A read-only status line
- A read-only time readout in `mm:ss / mm:ss` form

The status line must surface these states:

- `No SoundFont loaded`
- `No MIDI loaded`
- `Ready`
- `Playing`
- `Paused`
- `Stopped`
- `Error: <message>`

The UI must not auto-play after file selection. Playback must begin only after a
user gesture that satisfies browser audio-start rules.

---

## Architecture

This section defines the implementation boundary between the demo page and the
audio controller.

Create a browser-only controller module, for example `spessasynth-player.js`.
This module must be the only place that imports SpessaSynth code.

The controller module must:

- Own the synthesizer instance
- Own the sequencer or playback instance
- Own or receive the `AudioContext`
- Load SoundFont and MIDI `ArrayBuffer` data
- Expose imperative control methods for the demo page
- Emit state updates for UI rendering
- Hide SpessaSynth-specific object lifetimes from `matrix-3d.html`

The controller factory must look like this:

```js
createSpessaMidiPlayer({
  onStateChange,
  onTimeChange,
  onError,
})
```

The returned handle must expose this surface:

```js
{
  loadSoundFont(fileOrArrayBuffer),
  loadMidi(fileOrArrayBuffer),
  play(),
  pause(),
  stop(),
  seek(seconds),
  setVolume(value01),
  setLoop(enabled),
  getState(),
  destroy(),
}
```

`matrix-rain-webgpu.js` must remain graphics-focused. This spec does not add
any synthesizer logic to the rain engine or its public handle.

---

## Demo integration

This section defines the required page wiring in `matrix-3d.html`.

`matrix-3d.html` must:

1. Create the MIDI player handle during demo initialization.
2. Wire the SoundFont picker to `loadSoundFont()`.
3. Wire the MIDI picker to `loadMidi()`.
4. Wire transport controls to `play()`, `pause()`, `stop()`, `seek()`, and
   `setVolume()`.
5. Reflect player state and playback time in the panel.
6. Stop CCP and Mossad demo audio when MIDI playback begins.
7. Destroy the MIDI player on page teardown if the page gains explicit teardown
   handling later.

The implementation must reuse the existing demo-side audio helpers instead of
duplicating that logic. When MIDI playback starts, the page must call both
`_stopAllCCPAudio()` and `_stopMossadAudio()` before or during the start path.

The reverse interaction is out of scope for v1. If the user later enables CCP or
Mossad audio, that path does not need to stop MIDI playback in this spec.

---

## Loading and validation model

This section defines accepted file inputs and where validation lives.

The player must support local file inputs first. URL-based loading is out of
scope for v1.

### SoundFont input

The SoundFont picker must accept:

- `.sf2`
- `.sf3`
- `.dls`

### MIDI input

The MIDI picker must accept:

- `.mid`
- `.midi`
- `.kar`
- `.rmi`

The UI layer must do only lightweight validation through `accept` filters and
basic presence checks. The controller module must own parse failures and surface
them through `onError`.

---

## State model

This section defines the authoritative player state machine.

The controller must use these explicit states:

- `idle`
- `soundfont-ready`
- `midi-ready`
- `ready`
- `playing`
- `paused`
- `stopped`
- `error`

The controller must enforce these rules:

- `play()` must do nothing unless both a SoundFont and MIDI file are loaded
- Loading a new MIDI file while playback is active must stop current playback
  first
- Loading a new SoundFont while playback is active must stop current playback
  first
- `stop()` must reset playback position to `0`
- `pause()` must preserve playback position
- `seek(seconds)` must clamp to the loaded MIDI duration
- `setVolume(value01)` must clamp to `[0, 1]`
- `destroy()` must stop playback and release audio resources owned by the
  controller

The UI must derive button enabled and disabled states from this model instead of
from ad hoc DOM conditions.

---

## File changes

This section defines the expected write scope for the implementation.

Required files:

- `matrix-3d.html`
  - add the `MIDI player` controls and page wiring
- `spessasynth-player.js`
  - add the browser integration wrapper

Optional files:

- `package.json`
  - add a dependency entry only if it supports the chosen browser-loading path
- `tests/spessasynth-player.test.js`
  - add controller-level tests with mocks
- A local vendor file or import-map update
  - add only if required by the chosen loading strategy

---

## Implementation plan

This section breaks the work into implementation order.

### Step 1: Verify browser import path

Confirm that the selected SpessaSynth library exposes a browser-usable import
path that works with this repo's `matrix-3d.html` loading model.

### Step 2: Add the controller module

Create `spessasynth-player.js` as the only module that imports and wraps
SpessaSynth.

### Step 3: Add the demo controls

Add a `MIDI player` subsection to `matrix-3d.html` using the existing control
panel conventions, including file pickers, transport buttons, seek, volume,
loop, status, and time text.

### Step 4: Wire state and transport

Connect the page controls to the controller API and reflect controller state
back into the DOM.

### Step 5: Coordinate with existing audio

When MIDI playback begins, stop the CCP and Mossad demo audio elements to avoid
double playback.

### Step 6: Add tests

Add at least controller-level tests for:

- state transitions
- replacing loaded files
- stop and pause semantics
- seek clamping
- error propagation

---

## Risks

This section captures the main technical risks and the required mitigations.

### Browser audio initialization

SpessaSynth depends on browser audio-start rules. If initialization runs outside
an allowed user gesture, playback can fail or remain suspended.

Mitigation:

- Start or resume the audio context only from a user gesture path such as
  **Play**

### Browser import incompatibility

The library may document npm usage without exposing a browser-ready ESM entry
point that works in a plain HTML module page.

Mitigation:

- Validate the import path before wiring UI around it
- Do not rely on undocumented internal files

### Large SoundFonts

Large SoundFonts can consume significant memory and produce long load times.

Mitigation:

- Surface load errors clearly
- Keep the first iteration limited to user-provided local files
- Do not ship a default SoundFont in the repo

### UI complexity creep

The full SpessaSynth application includes many features that do not belong in
this demo.

Mitigation:

- Keep v1 limited to file loading and transport controls
- Defer advanced player features until the base flow is stable

---

## Acceptance criteria

This section defines the conditions that must be true before the spec is
considered complete.

1. You can load a local `.sf2` or `.sf3` file in `matrix-3d.html`.
2. You can load a local `.mid` file in `matrix-3d.html`.
3. **Play**, **Pause**, and **Stop** work reliably.
4. The seek slider tracks playback position and can move playback within the
   loaded song.
5. The status line and time readout reflect player state.
6. Starting MIDI playback does not require editing source files or opening a
   separate tool.
7. Existing matrix rendering remains functional while MIDI playback is active.
8. Existing CCP and Mossad demo audio do not overlap with active MIDI playback.
9. The implementation uses a browser-loading strategy that works in the current
   import-map-based demo page.

---

## Notes

This section records a few format and terminology notes used by the spec.

`sf2` means `SoundFont 2`, which is a sample-based instrument bank format used
by many MIDI synthesizers. A MIDI file contains note and controller events, but
it does not contain the instrument samples. The SoundFont provides the actual
instrument sounds used during playback.
