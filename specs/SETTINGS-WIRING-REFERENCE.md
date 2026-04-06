# Settings wiring reference

This page maps the settings around `sync-amt`, `phase`, `breathing`,
`waves`, `entrainment`, and clustering from UI labels to runtime handle
methods to shader behavior. You can use it as a naming audit before
renaming controls or changing preset/state formats.

## Bottom line

Several controls are wired correctly but named in ways that make them look
like variants of the same feature when they are not.

- `Head wave` and `speed entrainment` are both azimuth-driven sine systems, but they
  affect different layers of motion.
- `Phase` exists in at least four meanings: cluster seed phase, squad phase,
  scanline shared cycle position, and per-column cycle phase.
- `Contagion` is not true propagation. It is a cluster burst participation
  probability.
- `Squad coherence` is directionally inverted from what many users expect:
  `0` means more locking, `1` means less.
- The HTML/UI state serializer knows about many newer controls that the
  built-in `savePreset()` and `loadPreset()` API do not persist.

## Motion stack

This is the effective order in the 3D shader path.

```text
geometry seeds
  aSeed                 -> per-column random phase for breath and base cycle
  aSquadPhase           -> shared squad cycle seed
  aClusterBurstSeed     -> shared cluster burst window, also gravity desync
  aSpawnTheta           -> topology-correct [0,1] sweep position
  aClusterSpeed         -> per-cluster speed bias

speed layer
  uSpeedMul
    * breath modulation         (uBreathAmt)
    * burst modulation          (uBurstProb + uContagionStrength)
    * zone speed bias           (uZoneSpeedInner/Outer)
    * entrainment modulation    (uEntrainAmt/Speed/Crests)

cycle layer
  phaseSeed = mix(aSquadPhase, aSeed, uSquadCoherence)
  naturalCyclePos = time * effectiveSpeed * speedMul + phaseSeed * cycleH

scanline override
  cyclePos = mix(naturalCyclePos, uScanPhase, uScanSyncAmt)

head placement
  headY derived from cyclePos
  waveOffset derived separately from uWaveAmt/Speed/Crests
```

The important distinction is that `entrainment` changes speed before
`cyclePos` is computed, while `wave` adds a positional offset later in the
head sweep path.

## UI to code map

This section shows the main 3D control surface.

### Breathing

`Breath amt` in [`matrix-3d.html`](/home/xush/Documents/prog/matrix-rain-webgpu/matrix-3d.html)
drives `rain.setBreathAmt(v)`, which writes `uBreathAmt` in
[`matrix-rain-webgpu.js`](/home/xush/Documents/prog/matrix-rain-webgpu/matrix-rain-webgpu.js).
The shader uses it in
[`matrix-rain-tsl.js`](/home/xush/Documents/prog/matrix-rain-webgpu/matrix-rain-tsl.js)
to create a per-column multiplicative speed oscillation.

```text
ctl-breath-amt
  -> setBreathAmt(v)
  -> uBreathAmt
  -> breathFrac = sin(time * randomFreq + randomPhase) * (uBreathAmt * 0.15)
  -> speedMul *= 1 + breathFrac
```

This is a speed effect, not a positional phase wave.

### Head wave

The `Head wave` controls are older organic motion controls. They use
`aSpawnTheta`, but they do not change speed directly.

```text
ctl-wave-speed / ctl-wave-amt / ctl-wave-crests
  -> setWaveSpeed / setWaveAmt / setWaveCrests
  -> uWaveSpeed / uWaveAmt / uWaveCrests
  -> wavePhase  = thetaWave * crests + time * speed
  -> waveOffset = sin(wavePhase) * (uWaveAmt * 4.0)
```

This is the positional sweep layer of the motion stack.

### Speed entrainment

The `Speed entrainment` controls are a second sine system that also uses
`aSpawnTheta`, but they modulate speed, not head offset.

```text
ctl-entrain-amt / speed / crests
  -> setEntrainment / setEntrainSpeed / setEntrainCrests
  -> uEntrainAmt / uEntrainSpeed / uEntrainCrests
  -> entrainWave = sin(thetaEntrain * crests + time * speed) * amt
  -> speedMul *= 1 + entrainWave
```

This is why `head wave` and `speed entrainment` feel semantically adjacent in the UI.
They share the same spatial driver, but they touch different math.

### Scan phase lock and shared cycle position

The scan controls are a third family and are the easiest to misread.

```text
ctl-scan-sync
  -> setScanlineSync(v)
  -> uScanSyncAmt

ctl-scan-phase
  -> setScanlinePhase(v)
  -> uScanPhase

cyclePos = mix(naturalCyclePos, mod(uScanPhase, cycleH), uScanSyncAmt)
```

The scan phase-lock control is not a generic sync amount. It is a blend factor
between natural per-column cycle motion and a single shared cycle position.

The shared cycle-position control is also not a free-running oscillator phase.
It is the shared `cyclePos` target that all columns are blended toward.

For naming, these would read more honestly as:

- `Scan phase lock`
- `Shared cycle position`

## Phase taxonomy

The codebase uses the word `phase` for multiple unrelated concepts.

```text
Cluster.phase
  random seed per cluster
  used to derive squadPhases in geometry build

aSquadPhase
  shared squad cycle seed
  blended with aSeed by uSquadCoherence

uScanPhase
  global shared cycle position used by scan phase lock

cyclePhase
  normalized [0,1] progress of the current column cycle
  used for EOL freeze/fade timing

breathPhase / wavePhase / entrainWave phase / gravity phase
  local oscillator phases inside specific effects
```

The overloaded term is a documentation problem more than a wiring bug.

## Clustering and squads

Clustering spans geometry generation, runtime uniforms, and shader behavior.
The current naming is mostly accurate, but some controls operate on narrower
axes than their labels suggest.

### Geometry-side cluster seeds

The geometry builder in
[`matrix-rain-geometry.js`](/home/xush/Documents/prog/matrix-rain-webgpu/matrix-rain-geometry.js)
creates these seeds per cluster:

- `theta`: angular center
- `hue`: color bias seed
- `brightness`: brightness bias seed
- `speed`: speed bias seed
- `burstSeed`: shared burst timing seed
- `yCenter`: shared vertical spawn band
- `rSeed`: shell depth seed
- `phase`: seed used to derive squad phases

It also derives:

- `aClusterBurstSeed`: cluster burst timing
- `aSquadPhase`: squad-shared cycle seed
- `aSpawnTheta`: topology-correct sweep position

### Runtime cluster controls

These controls split into rebuild-time versus runtime-only behavior.

Rebuild-time geometry controls:

- `clusters`
- `clusterSpread`
- `clusterUniform`
- `clusterSpeedJitter`
- `clusterYSpread`
- `clusterRJitter`
- `squadSize`
- `trailCohesion`

Runtime-only uniforms:

- `clusterHueRange`
- `clusterBrightRange`
- `clusterSpeedRange`
- `contagion`
- `squadCoherence`
- `heightFade`
- `densityIn`
- `densityOut`

### What the names actually mean

- `clusterSpread` means angular spread around `theta`. It does not control Y
  spread or shell-depth spread.
- `clusterUniform` is not cluster strength. It blends clustered angular
  placement toward uniform scatter.
- `clusterSpeedRange` is not the full cluster speed model. It is only the
  runtime multiplier applied to geometry-baked `aClusterSpeed`.
- `squadCoherence` is a blend from shared squad seed to independent seed:
  `0` means tightly locked, `1` means independent.
- `trailCohesion` is not trail length directly. It controls how strongly a
  squad-shared trail bias affects per-column trail length.

## Cluster burst participation is mislabeled as contagion

The code comments already note this. The current behavior is:

```text
clusterIsBursting = step(clusterBurstPhase, 0.08)
contagionBurst    = clusterIsBursting * step(randPerCol, uContagionStrength)
```

That means:

- a cluster has a shared burst window
- each column gets a probability of joining during that window
- no burst spreads from neighbor to neighbor over time

This is not true contagion or propagation. The canonical label is:

- `Cluster burst participation`

## State and preset mismatch

There is a real wiring inconsistency between the HTML state path and the API
preset path.

The UI serializer in
[`matrix-3d.html`](/home/xush/Documents/prog/matrix-rain-webgpu/matrix-3d.html)
captures newer settings such as:

- `waveEnabled`
- `waveCrests`
- `clusterSpread`
- `squadSize`
- `trailCohesion`
- `entrainAmt`
- `entrainSpeed`
- `entrainCrests`
- `scanSpeed`
- `scanDissolve`
- `scanSync`
- `scanPhase`

But `savePreset()` and `loadPreset()` in
[`matrix-rain-webgpu.js`](/home/xush/Documents/prog/matrix-rain-webgpu/matrix-rain-webgpu.js)
currently persist only a narrower subset. For example, they include
`breathAmt`, `waveAmt`, `waveSpeed`, and `contagion`, but not the scanline,
entrainment, squad, or most cluster controls.

```text
HTML state snapshot: broad control coverage
API savePreset():   older subset of controls
def.json:           another overlapping subset
```

This is the clearest real wiring drift in the current system.

## Naming recommendations

These are the lowest-risk naming changes if you want the control panel to read
more honestly without changing behavior.

- Rename `Wave` to `Head wave`.
- Rename `Entrainment` to `Speed entrainment`.
- Rename `Scan sync amt` to `Scan phase lock`.
- Rename `Scan phase` to `Shared cycle pos` or `Locked cycle pos`.
- Rename `Contagion` to `Cluster burst participation`.
- Rename `Squad coherence` to `Squad independence` if you want higher values
  to mean "more of the labeled thing." If you keep the current name, add a
  hint that `0 = lock, 1 = independent`.
- Rename `clusterSpread` in docs to `Cluster angular spread`.

## Suggested mental model

If you need one quick model for the current system, use this:

```text
breathing   = local speed wobble per column
entrainment = large-scale spatial speed wave
wave        = large-scale spatial position wave
scan sync   = global phase lock override
clusters    = shared seeds and biases
squads      = smaller groups inside clusters that share cycle and trail tendencies
```

## Next steps

If you want to clean this up in code, the safest order is:

1. Align labels and tooltips in `matrix-3d.html`.
2. Unify preset/state coverage so `savePreset()` matches the UI serializer.
3. Only then rename handle methods or uniform names if the API surface also
   needs cleanup.
