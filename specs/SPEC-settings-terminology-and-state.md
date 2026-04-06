# SPEC — Settings terminology and state unification

**Status**: Approved
**Priority**: P1
**Depends on**: —
**Goal**: Make the motion, scan, clustering, and squad controls read
unambiguously in the UI and docs, while unifying the preset/state paths so the
same settings persist everywhere.

---

## Problem

The current 3D control surface is mostly wired correctly, but several controls
read as if they are aliases of each other when they actually affect different
parts of the motion stack.

The main sources of confusion are:

- `Wave` and `Entrainment` are both `aSpawnTheta`-driven sine systems, but one
  is a positional offset and the other is a speed modulation.
- `Scan sync amt` and `Scan phase` use generic words for a very specific
  scanline phase-lock system.
- `Phase` is overloaded across cluster seeds, squad seeds, scanline shared
  cycle position, and normalized cycle progress.
- `Contagion` implies neighbor propagation, but the implementation is only a
  cluster burst participation probability during a shared burst window.
- `Squad coherence` is correct mathematically, but its numeric direction is easy
  to misread because `0` means more locking and `1` means more independence.

There is also a real state-management mismatch:

- The HTML/UI serializer in
  [`matrix-3d.html`](/home/xush/Documents/prog/matrix-rain-webgpu/matrix-3d.html)
  persists a broader set of controls than the `savePreset()` / `loadPreset()`
  API in
  [`matrix-rain-webgpu.js`](/home/xush/Documents/prog/matrix-rain-webgpu/matrix-rain-webgpu.js).
- `def.json` is a third overlapping state surface with yet another subset and
  naming style.

This produces two user-visible problems:

1. The panel is harder to reason about than the underlying code.
2. Saved state can silently omit meaningful settings.

---

## Goals

1. Rename the most confusing UI labels and tooltips without changing runtime
   behavior.
2. Standardize terminology for docs and specs so each control family has one
   stable name.
3. Preserve API compatibility for existing handle methods and preset keys unless
   an explicit deprecation shim is added.
4. Unify the state model so UI export/import, `savePreset()` / `loadPreset()`,
   and `def.json` can all represent the same feature set.
5. Make clustering and squad controls easier to understand, especially where a
   control only affects one axis of the cluster model.

---

## Non-goals

- No shader behavior change.
- No re-tuning of defaults.
- No removal of existing handle methods in this pass.
- No change to the actual cluster, squad, wave, entrainment, or scanline math.
- No introduction of true burst propagation or compute-driven state.

---

## Terminology model

The project should describe the motion stack using these stable terms:

| Family | Canonical term | Meaning |
|---|---|---|
| Breath | `Breathing` | Per-column local speed wobble |
| Wave | `Head wave` | Large-scale spatial head-position offset |
| Entrainment | `Speed entrainment` | Large-scale spatial speed modulation |
| Scan | `Scan phase lock` | Blend from natural cycle motion to shared cycle position |
| Cluster | `Cluster burst participation` | Probability a column joins its cluster's burst window |
| Squad | `Squad independence` or `Squad phase lock` | Blend between shared squad seed and per-column seed |

Docs may mention the legacy names for compatibility, but the canonical term
must appear first.

---

## Proposed UI naming

### Motion controls

These labels change in the 3D control panel only. Handle method names remain
unchanged in this spec.

| Current label | New label | Reason |
|---|---|---|
| `Wave speed` | `Head wave speed` | Distinguishes it from speed entrainment |
| `Wave amt` | `Head wave amount` | Makes the layer explicit |
| `Wave crests` | `Head wave crests` | Keeps the family grouped |
| `Entrainment` | `Speed entrainment` | Clarifies it touches speed, not offset |
| `Entrain speed` | `Speed entrain rate` | Groups with the same family |
| `Entrain crests` | `Speed entrain crests` | Groups with the same family |
| `Scan sync amt` | `Scan phase lock` | Describes the actual blend |
| `Scan phase` | `Shared cycle position` | Describes what the value is |

### Clustering and squad controls

| Current label | New label | Reason |
|---|---|---|
| `Clusters` | `Cluster count` | Reads as a parameter, not a category header |
| `Cluster spread` | `Cluster angular spread` | Clarifies this is only θ spread |
| `Cluster speed` | `Cluster speed range` | Matches the underlying uniform |
| `Contagion` | `Cluster burst participation` | Matches actual implementation |
| `Squad coherence` | `Squad independence` | Lets larger values mean more of the labeled thing |
| `Trail cohesion` | `Squad trail cohesion` | Makes the scope explicit |

If `Squad coherence` is kept instead of `Squad independence`, the tooltip must
say: `0 = locked, 1 = independent`.

---

## Tooltip requirements

Each renamed control must gain a short tooltip so the effect is obvious without
reading source.

Required tooltip text:

- `Head wave`: `Adds a spatial head-position offset. Does not change speed.`
- `Speed entrainment`: `Modulates column speed in traveling spatial bands.`
- `Scan phase lock`: `Blends natural per-column cycle motion toward one shared cycle position.`
- `Shared cycle position`: `The shared cyclePos used when scan phase lock is above 0.`
- `Cluster angular spread`: `Angular spread only. Does not change Y spread or shell-depth spread.`
- `Cluster burst participation`: `Probability a column joins its cluster's shared burst window.`
- `Squad independence`: `0 = shared squad phase, 1 = individual per-column phase.`
- `Squad trail cohesion`: `How strongly squad trail bias affects trail length.`

---

## API compatibility

### Handle methods

Public handle methods remain unchanged in this spec:

- `setWaveSpeed`
- `setWaveAmt`
- `setWaveCrests`
- `setEntrainment`
- `setEntrainSpeed`
- `setEntrainCrests`
- `setScanlineSync`
- `setScanlinePhase`
- `setContagion`
- `setSquadCoherence`

This keeps existing integrations working.

### Optional aliases

This spec permits adding descriptive aliases, but they are optional and must
delegate to the existing methods:

- `setHeadWaveSpeed` -> `setWaveSpeed`
- `setHeadWaveAmt` -> `setWaveAmt`
- `setHeadWaveCrests` -> `setWaveCrests`
- `setSpeedEntrainment` -> `setEntrainment`
- `setClusterBurstParticipation` -> `setContagion`
- `setSquadIndependence` -> `setSquadCoherence`

If aliases are added, the old methods remain primary compatibility entry points.

---

## State model unification

### Requirement

The following three state surfaces must agree on schema and naming for shared
fields, while still permitting surface-specific convenience fields where
appropriate:

1. UI export/import in `matrix-3d.html`
2. `savePreset()` / `loadPreset()` in `matrix-rain-webgpu.js`
3. `def.json`

`def.json` is a defaults file rather than a full-fidelity session snapshot, so
it may omit fields. When a field is present, it must use the canonical name.

### State classes

Not every persisted field represents the same kind of state. This spec uses
three classes:

| Class | Meaning | Examples |
|---|---|---|
| Engine-owned state | Live runtime state with a direct handle, uniform, or geometry mapping | `breathAmt`, `waveAmt`, `entrainAmt`, `scanSync`, `scanPhase` |
| UI-derived state | Convenience state for the panel, derived from engine-owned state or used to drive panel behavior | `waveEnabled` |
| Trigger-default state | Stored defaults used the next time a one-shot action is triggered, not a continuously applied runtime value | `scanSpeed`, `scanDissolve` |

The three surfaces do not need to treat these classes identically:

- UI export/import may include all three classes.
- `savePreset()` / `loadPreset()` should include engine-owned state and may also
  include UI-derived and trigger-default state when they materially affect the
  user's workflow.
- `def.json` may include engine-owned state and trigger-default state, but UI
  convenience keys are optional.

### Canonical persistence keys

Persist these keys as the canonical format.

Engine-owned state:

```text
breathAmt
waveSpeed
waveAmt
waveCrests
entrainAmt
entrainSpeed
entrainCrests
clusters
clusterSpread
clusterUniform
clusterHueRange
clusterBrightRange
clusterSpeedRange
clusterSpeedJitter
clusterYSpread
clusterRJitter
contagion
squadCoherence
squadSize
trailCohesion
densityIn
densityOut
heightFade
spawnFront
scanSync
scanPhase
```

UI-derived state:

```text
waveEnabled
```

Trigger-default state:

```text
scanSpeed
scanDissolve
```

The preset API may continue loading older snapshots that lack some keys, but new
saves must include the engine-owned set above. UI-derived and trigger-default
keys are recommended where that improves round-tripping.

### Backward compatibility rules

1. Missing keys must fall back to current control values or runtime defaults.
2. If `waveEnabled` is absent, it must be derived from `waveAmt`:
   `waveAmt > 0` implies enabled, `waveAmt = 0` implies disabled.
3. Older presets that only contain `waveAmt` and `waveSpeed` must still load.
4. `scanSpeed` and `scanDissolve` are trigger defaults, so missing values must
   fall back to the current UI defaults rather than being treated as broken
   runtime state.
5. `def.json` may omit keys, but any included key must match the canonical name.
6. No legacy key rename is allowed without a compatibility read path.

---

## Canonical behavior descriptions

These descriptions must be used consistently in docs, comments, and specs.

### Head wave

`Wave` is the positional layer:

```text
wavePhase  = thetaWave * uWaveCrests + time * uWaveSpeed
waveOffset = sin(wavePhase) * (uWaveAmt * 4.0)
```

It changes head placement, not speed.

### Speed entrainment

`Entrainment` is the speed layer:

```text
entrainWave = sin(thetaEntrain * uEntrainCrests + time * uEntrainSpeed) * uEntrainAmt
speedMul   *= 1 + entrainWave
```

It changes speed, not head offset.

### Scan phase lock

`Scanline sync` is a cycle-position blend:

```text
cyclePos = mix(naturalCyclePos, mod(uScanPhase, cycleH), uScanSyncAmt)
```

`uScanSyncAmt` is a phase-lock amount. `uScanPhase` is a shared cycle position.
`scanSpeed` and `scanDissolve` are not part of this live state. They are only
defaults for the next call to `triggerScanlineSweep()`.

### Cluster burst participation

`Contagion` is not propagation:

```text
clusterIsBursting = step(clusterBurstPhase, 0.08)
contagionBurst    = clusterIsBursting * step(colContagionRand, uContagionStrength)
```

This is participation in a cluster burst window, not neighbor-to-neighbor spread.

---

## Files changed

| File | Change |
|---|---|
| `matrix-3d.html` | Rename labels, add tooltips, keep DOM ids stable unless explicitly refactored |
| `matrix-rain-webgpu.js` | Expand `savePreset()` / `loadPreset()` coverage to match the canonical persisted state classes |
| `def.json` | Optionally add missing canonical keys; no legacy aliases |
| `CLAUDE.md` | Update API descriptions and terminology |
| `specs/SETTINGS-WIRING-REFERENCE.md` | Keep as the explanatory reference companion to this spec |

---

## Implementation plan

### Step 1 — Rename labels only

Update visible text in
[`matrix-3d.html`](/home/xush/Documents/prog/matrix-rain-webgpu/matrix-3d.html)
for the controls listed in the Proposed UI naming section.

Do not change:

- control ids
- event wiring
- handle method names
- saved key names

This isolates wording changes from behavior changes.

### Step 2 — Add tooltips

Add `title` text or inline helper copy for each renamed control using the exact
meaning described in Tooltip requirements.

### Step 3 — Unify preset persistence

Extend `savePreset()` and `loadPreset()` in
[`matrix-rain-webgpu.js`](/home/xush/Documents/prog/matrix-rain-webgpu/matrix-rain-webgpu.js)
to cover the canonical persistence keys.

`savePreset()` must serialize the same engine-owned motion and clustering
controls as the UI serializer in `matrix-3d.html`. It may also serialize
UI-derived and trigger-default fields.

`loadPreset()` must restore them using existing handle methods and rebuild-aware
ordering where needed.

### Step 4 — Normalize `def.json`

Ensure `def.json` uses canonical keys only. Missing keys are acceptable; mixed
naming is not.

### Step 5 — Update docs

Update `CLAUDE.md` and any relevant specs so the family names are consistent:

- `Head wave`
- `Speed entrainment`
- `Scan phase lock`
- `Cluster burst participation`
- `Squad independence` or explicitly documented `Squad coherence`

---

## Ordering and safety

When loading a full preset or `def.json`, apply settings in this order:

1. Geometry topology and counts
2. Cluster rebuild-time parameters
3. Squad rebuild-time parameters
4. Runtime cluster uniforms
5. Motion layers
6. Scanline parameters

This prevents redundant rebuilds and avoids applying runtime controls before the
underlying geometry parameters exist.

---

## Acceptance criteria

1. A user can distinguish `Head wave`, `Speed entrainment`, and `Scan phase lock`
   from their labels and tooltips alone.
2. The control panel no longer uses `Contagion` as the visible label.
3. A preset saved through `savePreset()` round-trips the same motion and
   clustering settings that a UI state export does.
4. `def.json` can express the same motion and clustering model using canonical
   keys for any fields it includes.
5. Existing code calling `setWaveSpeed`, `setEntrainment`, `setScanlineSync`,
   `setContagion`, or `setSquadCoherence` continues to work unchanged.

---

## Risks

- Renaming visible labels without changing ids can leave some inline comments or
  docs looking stale until the docs pass is complete.
- Expanding preset coverage can expose ordering bugs if rebuild-time settings are
  applied in a naive sequence.
- `Squad independence` is more intuitive, but it no longer matches the existing
  uniform name `uSquadCoherence`; docs must state the mapping clearly.

---

## Recommended follow-up

After this spec lands, a second spec can address two deeper cleanups:

1. Add descriptive alias methods for the most confusing public API names.
2. Replace pseudo-`contagion` with actual temporal propagation if that behavior
   is still wanted.
