# SPEC-2d-organic

**Status**: Ready for implementation
**Priority**: P2 — depends on SPEC-2d-core; independent of SPEC-2d-layers
**Reference**: `specs/matrix-rain-analysis.md` §6 "Experimental Directions";
`specs/AUDIT-analysis-vs-code.md` §3.3–3.7

---

## Motivation

Five properties in the 1999 film distinguish it from most recreations. All five are noted
in analysis §6 as things "most recreations miss":

1. **Speed micro-oscillation** — streams gently accelerate/decelerate ("breathing")
2. **Inter-column phase correlation** — waves of activity sweep left-to-right
3. **Column clustering** — active columns group in rivulets, not uniform distribution
4. **Weighted glyph sampling** — complex-stroke glyphs appear more often
5. **Glitch trigger** — stochastic horizontal scanline displacement

This spec also covers:
- **Speed ramp API** — expose the existing `uSpeedRamp` uniform as a timed trigger
- **`prefers-reduced-motion`** — accessibility requirement noted in analysis §6 and backlog

All features are additive enhancements on top of SPEC-2d-core. Each can be toggled off
independently. Implementing them in order of the priority table in §Tasks is recommended
but not required.

---

## 1. Speed Micro-Oscillation

### What it does

Each stream's speed is sinusoidally modulated at a per-stream low frequency. The stream
"breathes" — accelerating and decelerating over a 2–10 second cycle, with a random phase
per stream so columns are not synchronised.

### Analysis reference

§6 "Making It Feel Alive" #2:
```
v'(t) = v · (1 + 0.15 · sin(t · fv + φv))
fv ∈ [0.1, 0.5] Hz per stream,  φv random per stream
```

### Implementation

In `getStream`, extend the returned speed. `speed` must be declared as a mutable
`toVar` node so it can be updated in-place via `.assign()`:

```js
// In getStream — declare speed as a mutable variable so oscillation can update it
const speed = mix(uSpeedMin, uSpeedMax, speedT).mul(uSpeedRamp).toVar('speed');

// fv: oscillation frequency [0.1, 0.5] Hz, seeded per (col, si)
const fv   = h21(vec2(col.mul(3.71).add(si.mul(19.13)), float(5.37)))
               .mul(0.4).add(0.1);                    // [0.1, 0.5]
// φv: random phase offset [0, 2π), seeded per (col, si)
const phiV = h21(vec2(col.mul(11.1).add(si.mul(7.23)), float(8.91)))
               .mul(float(Math.PI * 2));
// Apply oscillation to speed — uses t (the time uniform passed into getStream)
const oscillation = float(1).add(
  sin(t.mul(fv).add(phiV)).mul(0.15)
);
speed.assign(speed.mul(oscillation));
```

`t` is the time uniform node available as a **closed-over variable** from the enclosing
`buildRain2DNode` scope — it is NOT a new parameter to `getStream`. SPEC-2d-core defines
`getStream` inside `buildRain2DNode`, so `t` (bound in the outer Fn closure) is already
in scope. No signature change to `getStream` is needed. `speed` must be declared with
`.toVar()` (not bare `const`) because TSL node references are immutable after assignment;
`.assign()` requires a mutable variable node.

### Toggle

`uSpeedOscillation` — float uniform, default `1.0`. Set to `0.0` to disable. When `0.0`,
the oscillation multiplier reduces to `1.0` (identity). Use `mix(float(1), oscillation, uSpeedOscillation)`.

Handle method: `setSpeedOscillation(v)` where `v` is 0.0 or 1.0 (or intermediate to
scale the amplitude: `0.15 * uSpeedOscillation`).

### Visual effect

Streams subtly vary in speed independently. A column moving at 3 c/s will drift between
~2.6 and 3.4 c/s over its cycle period. The effect is most noticeable when watching a
single column but adds organic character to the overall field.

---

## 2. Inter-Column Phase Correlation

### What it does

A slow-moving low-frequency noise field modulates the phase offset of each column.
Adjacent columns share similar phase offsets (because they sample nearby points on the
noise field), creating **waves of activity** that sweep left-to-right across the screen.

### Analysis reference

§6 "Making It Feel Alive" #5:
```
φ'_c = φ_c + A · noise(c · 0.1),  A ≈ 8 s
```

Low-frequency 1D noise over column index; amplitude ~8 seconds of phase offset.

### Implementation

**Required imports** (add to `matrix-rain-2d-tsl.js` import list if not already present):
`sin`, `mix`, `smoothstep`, `float`, `floor`, `fract`, `select` — all from `three/tsl`.
`sin` in particular is needed for the oscillation and phase correlation expressions below.

Replace the independent `h2.y * 57.3` phase in `getStream` with a correlated phase:

```js
// Low-frequency 1D noise over column position
// Two octaves of sine for a smooth, non-repetitive wave
const noiseFreq = float(0.08);   // spatial frequency — controls wave width
const noiseAmt  = float(8.0);    // phase amplitude in seconds
const colNoise  =
  sin(col.mul(noiseFreq).add(float(1.3)))
  .add(sin(col.mul(noiseFreq.mul(2.1)).add(float(0.7))).mul(0.5))
  .div(1.5);                    // sum normalised to [-1, 1]
const correlatedPhase = h2.y.mul(57.3).add(colNoise.mul(noiseAmt));
```

The sine-sum produces a smooth, non-repeating wave pattern across column indices.
`noiseFreq = 0.08` means one full wave spans ~78 columns (at 16 px/cell = 1248 px width).
At 1920 px wide that is ~1.5 wave cycles across the screen.

### Time-varying waves (optional enhancement)

To make the waves themselves drift (i.e. the phase correlation field moves slowly over
time), add a slow time term using the `uWaveSpeed` uniform:

```js
const colNoise  =
  sin(col.mul(noiseFreq).add(t.mul(uWaveSpeed)).add(float(1.3)))
  .add(...);
```

`t` is the time uniform closed over from `buildRain2DNode` scope — not the TSL built-in
`time` and not a `getStream` parameter. With `uWaveSpeed = 0.02`, a wave crest moves
~2.5 columns/second — slow enough to be subliminal but gives the rain a breathing, alive
quality over longer viewing periods. Implement this as the default; `uWaveSpeed` uniform
(default `0.02`, range `0–0.2`) with handle method `setWaveSpeed(v)` is already listed
in the New Uniforms Summary table.

### Toggle

`uPhaseCorrelation` — float uniform, default `1.0`. When `0.0`, `colNoise` contribution
is zeroed (independent random phases, same as SPEC-2d-core). Use:

```js
const correlatedPhase = h2.y.mul(57.3)
  .add(colNoise.mul(noiseAmt).mul(uPhaseCorrelation));
```

Handle method: `setPhaseCorrelation(v)`.

---

## 3. Column Clustering

### What it does

Rather than uniform Bernoulli activation per column, columns are assigned to **spatial
segments** of 3–6 columns each. Each segment has a slowly-varying activity probability
that transitions between 0.2 and 0.95 over a 2–5 second period. This causes groups of
adjacent columns to turn on and off together, mimicking rainfall rivulets.

### Analysis reference

§6 "Making It Feel Alive" #1:
> Active columns cluster in groups of 2–4. Implement by assigning each column to a
> "cluster group" with activity state that transitions slowly (0.5–2s transition time).

### Implementation

Replace the per-column `h21(…) < uDensity` enabled check in `getStream` with a
cluster-based check:

```js
// Segment size controlled by uClusterWidth uniform (default 4.0)
const segW    = uClusterWidth;
const seg     = floor(col.div(segW));

// Segment activity state — changes slowly using a low-frequency hash-per-time-bucket
// Bucket duration: 2–4 s, seeded per segment
const segSeed    = h21(vec2(seg.mul(7.31), float(2.11)));
const bucketDur  = segSeed.mul(2.0).add(2.0);                 // 2–4 s per state
const bucketIdx  = floor(t.div(bucketDur).add(segSeed.mul(31.0)));
const segActive  = h21(vec2(seg.mul(3.73), bucketIdx.mul(0.17)));

// Interpolate between neighbouring state buckets for smooth transitions
const bucketFrac = fract(t.div(bucketDur).add(segSeed.mul(31.0)));
const nextBucketIdx   = bucketIdx.add(1.0);
const nextSegActive   = h21(vec2(seg.mul(3.73), nextBucketIdx.mul(0.17)));
const smoothedActive  = mix(segActive, nextSegActive,
  smoothstep(0.7, 1.0, bucketFrac));  // smooth transition in last 30% of bucket

// Threshold: segments above uDensity are active; modulate by global density
// TSL select(condition, trueValue, falseValue) — matches matrix-rain-tsl.js usage
const enabled = select(
  smoothedActive.lessThan(uDensity), float(1), float(0)
);
```

The per-column `h21` activation is replaced entirely by `smoothedActive < uDensity`.
The smooth transition via `smoothstep(0.7, 1.0, bucketFrac)` avoids columns snapping
on/off instantaneously — they fade between states.

### Cluster width

`uClusterWidth` — float uniform, default `4.0`. Range 2–8 (integer steps). Larger values
create wider rivulets (more columns activate together).

Handle method: `setClusterWidth(v)` — must round `v` to the nearest integer before writing
to the uniform, since `floor(col.div(segW))` produces fractional segment boundaries for
non-integer `segW`, breaking the discrete clustering logic:
```js
handle.setClusterWidth = v => { uniforms.uClusterWidth.value = Math.round(v); };
```

### Toggle

`uClusterStrength` — float uniform, default `1.0`. When `0.0`, fall back to pure
Bernoulli per-column activation (SPEC-2d-core behaviour). Blend:

```js
const mixedActive = mix(
  h21(vec2(col.mul(7.77).add(si.mul(3.33)), float(17.1))),  // independent
  smoothedActive,                                             // clustered
  uClusterStrength
);
const enabled = select(mixedActive.lessThan(uDensity), float(1), float(0));
```

Handle method: `setClusterStrength(v)`.

---

## 4. Weighted Glyph Sampling

### What it does

Complex-stroke glyphs (those with more vertical lines and denser fill) appear more
frequently than sparse glyphs. This matches the film, where ﾆ, ﾊ, ﾃ, ﾘ appear more
often than ｦ, ﾟ, ｬ.

### Analysis reference

§6 "Making It Feel Alive" #3:
> Weight character selection toward higher-complexity glyphs using a non-uniform
> distribution over the 64 character indices.

### Implementation

A **weight remapping LUT** — a 64-element lookup table baked into a `DataTexture`
(1×64, R channel, R16F float). The LUT stores CDF values in [0,1], which fit cleanly in
half-float range without quantisation error. Use:
```js
new THREE.DataTexture(data, 64, 1, THREE.RedFormat, THREE.HalfFloatType)
```
with `data` as a `Float16Array` (or `Uint16Array` with manually packed half-floats via a
conversion utility). Sampling is via binary search on the LUT, implemented as 6 unrolled
bisection steps for 64 elements (exact, not approximate).

**LUT construction (JS, at init time):**

For the `matrix1999` set, assign weights by glyph complexity class:

| Class | Glyphs | Weight |
|---|---|---|
| Complex (≥8 strokes) | ﾆ ﾊ ﾃ ﾎ ﾘ ﾙ ﾚ ﾛ ﾜ and ~10 others | 2.5 |
| Medium (5–7 strokes) | most katakana | 1.0 |
| Simple (≤4 strokes) | ｦ ｧ ｨ ｩ ｪ ｫ ｯ ﾟ ﾞ and numerals | 0.5 |

Build a normalised cumulative distribution function (CDF) array, write into a 1×64
`DataTexture`. The CDF enables inverse-CDF sampling: `charId = CDF_inv(uniform_rand)`.

**TSL sampling (approximate inverse-CDF via sequential search):**

For 64 glyphs, 6 bisection steps suffice for exact inversion. Implement as an unrolled
sequence of `If` comparisons rather than a `Loop` (avoids loop overhead for small N):

```js
// weightLUT: DataTexture 1×64, R16F (THREE.RedFormat + THREE.HalfFloatType), stores CDF[i] = sum(w[0..i]) / sum(w[all])
const weightLUTTex = texture(weightLutTexNode, vec2(0));  // 1D lookup

const sampleWeightedGlyph = Fn(([rand]) => {
  // rand ∈ [0,1) — the raw hash output
  // Find lowest i such that CDF[i] >= rand
  // 64-glyph CDF → 6 bisection steps
  const lo = float(0).toVar();
  const hi = float(63).toVar();
  // Unroll 6 bisection steps
  for (let step = 0; step < 6; step++) {
    const mid  = floor(lo.add(hi).div(2.0));
    const cdfV = weightLUTTex.sample(vec2(mid.add(0.5).div(64.0), 0.5)).r;
    // Texel centres in a 1×64 texture are at U = (i + 0.5) / 64, not i / 63
    If(cdfV.lessThan(rand), () => { lo.assign(mid.add(1.0)); })
      .Else(() => { hi.assign(mid); });
  }
  return lo.div(uGlyphCount);  // normalised char id ∈ [0,1) — lo ∈ [0,63], div by 64 keeps result < 1.0
});
```

Replace the direct `charId = h21(…)` output with `sampleWeightedGlyph(h21(…))`.

### Weight LUT per charSet

Each charSet has its own weight array defined in `data/glyph-sets.js` alongside the
glyph list. Add a `weights` array to each set entry:

```js
matrix1999: {
  gridW: 8, gridH: 8,
  glyphs: [...],
  weights: [2.5, 1.0, 1.0, 0.5, ...]  // one weight per glyph slot, length = gridW*gridH
}
```

For charSets without a defined `weights` array (e.g. `latin`, `ascii`), fall back to
uniform sampling (all weights = 1.0, CDF is linear).

The `DataTexture` is rebuilt on `setCharSet()`.

### Toggle

`uWeightedGlyphs` — float uniform, default `1.0`. When `0.0`, bypass the LUT lookup
and use the raw `charId` from `h21`. Use `mix(rawCharId, weightedCharId, uWeightedGlyphs)`.

Handle method: `setWeightedGlyphs(v)`.

---

## 5. Speed Ramp API

### What it does

Smoothly ramps the global speed multiplier toward a target, then decays back to 1.0.
Useful for "fight scene" transitions.

### Analysis reference

§5.5 Variations:
```js
function triggerSpeedRamp(targetMult = 4.0, duration = 2.0)
```

### Implementation

`uSpeedRamp` already exists in SPEC-2d-core. The ramp is driven in JS (no shader change
needed) using `requestAnimationFrame`:

```js
handle.triggerSpeedRamp = function(targetMult = 4.0, duration = 2.0) {
  const startTime  = performance.now();
  const endTime    = startTime + duration * 1000;
  function step(now) {
    const elapsed = (now - startTime) / 1000;
    const t = Math.min(elapsed / duration, 1.0);
    // Ease in/out: t² rise, (1-t)² fall
    const rampT = t < 0.5
      ? 2 * t * t
      : 1 - Math.pow(-2 * t + 2, 2) / 2;
    uniforms.uSpeedRamp.value = 1.0 + (targetMult - 1.0) * (1.0 - rampT);
    if (now < endTime) requestAnimationFrame(step);
    else uniforms.uSpeedRamp.value = 1.0;
  }
  requestAnimationFrame(step);
};
```

The easing function peaks at `targetMult` immediately and eases back to 1.0 over
`duration` seconds. To match the analysis's "peak at start, decay back" shape, the
multiplier starts high and decays: `1.0 + (targetMult - 1.0) * (1.0 - rampT)`.

---

## 6. Glitch Trigger

### What it does

Stochastic horizontal scanline displacement on a subset of scanlines, plus occasional
full-row brightness spikes. Activated per-trigger and decays over a configurable duration.

### Analysis reference

§5.1 WGSL shader (glitch section):
```wgsl
if u.glitch_amt > 0.001 {
  let scanline = floor(px.y / u.cell_h);
  if hash(scanline, floor(t * 30)) < glitch_amt * 0.30 {
    px.x += (hash(scanline, t) - 0.5) * resolution.x * 0.07 * glitch_amt;
  }
  if hash(scanline, floor(t * 5)) < glitch_amt * 0.05 {
    return vec4(0, 0.4 * glitch_amt, 0.1 * glitch_amt, 1);
  }
}
```

### TSL implementation

`uGlitchAmt` is reserved in SPEC-2d-core (zero by default). Insert the glitch logic into
`buildRain2DNode` after the `px` declaration, before cell coordinate computation:

```js
// Glitch: horizontal scanline displacement
// t = time uniform (same binding used throughout buildRain2DNode, not TSL built-in `time`)
If(uniforms.uGlitchAmt.greaterThan(float(0.001)), () => {
  const scanline  = floor(px.y.div(uniforms.uCellH));
  const bucket30  = floor(t.mul(30.0));
  const gHash     = h21(vec2(scanline, bucket30));

  // Displaced scanline: 30% of glitch_amt fraction of lines
  If(gHash.lessThan(uniforms.uGlitchAmt.mul(0.30)), () => {
    const dispHash = h21(vec2(scanline.mul(3.7), t.mul(7.0)));
    const disp     = dispHash.sub(0.5)
                             .mul(screenSize.x)
                             .mul(0.07)
                             .mul(uniforms.uGlitchAmt);
    px.assign(vec2(px.x.add(disp), px.y));
    // TSL does not support component-wise addAssign on a toVar vec2;
    // reassign the full vec2 instead.
  });

  // Full-row brightness spike
  const bucket5   = floor(t.mul(5.0));
  const spikeHash = h21(vec2(scanline.mul(1.3), bucket5));
  If(spikeHash.lessThan(uniforms.uGlitchAmt.mul(0.05)), () => {
    Return(vec4(
      float(0),
      float(0.4).mul(uniforms.uGlitchAmt),
      float(0.1).mul(uniforms.uGlitchAmt),
      float(1)
    ));
  });
});
```

This is inserted at the `// [glitch displacement placeholder]` comment slot specified
in SPEC-2d-core §Glitch Pass.

### JS trigger API

```js
handle.triggerGlitch = function(intensity = 0.6, duration = 0.4) {
  uniforms.uGlitchAmt.value = intensity;
  const timerId = setTimeout(() => {
    uniforms.uGlitchAmt.value = 0.0;
  }, duration * 1000);
  // Return cancel function in case caller wants early cancellation
  return () => { clearTimeout(timerId); uniforms.uGlitchAmt.value = 0.0; };
};
```

---

## 7. `prefers-reduced-motion`

### Scope

When `prefers-reduced-motion: reduce` is active, disable or substantially reduce the
most vestibularly intense features:

| Feature | Reduced-motion behaviour |
|---|---|
| Heat shimmer | Disable (`setHeat(false)`) |
| God rays | Disable (`setGodRays(false)`) |
| Burst bloom | Disable (`setBurstBloom(false)`) |
| Speed oscillation | Disable (`uSpeedOscillation = 0.0`) |
| Max column speed | Cap at 4.0 c/s (`uSpeedMax = 4.0`) |
| Glitch triggers | Ignored while reduced-motion is active |
| Speed ramp | Clamped to 2.0× max while active |

The rain continues to run (complete pause is not required for prefers-reduced-motion; only
reduction of intense motion is mandated). Static freeze is offered as an additional
option via `setFrozen(true)` which pauses the RAF loop.

### Implementation

```js
// At init time
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

function applyMotionPreference(reduced) {
  if (reduced) {
    uniforms.uSpeedMax.value   = Math.min(uniforms.uSpeedMax.value, 4.0);
    uniforms.uSpeedOscillation.value = 0.0;
    // Notify PP graph if it exists (CRT integration):
    // handle.setHeat?.(false);
    // handle.setGodRays?.(false);
    // handle.setBurstBloom?.(false);
  } else {
    // Restore saved values
    uniforms.uSpeedMax.value   = savedSpeedMax;
    uniforms.uSpeedOscillation.value = savedOscillation;
  }
}

const onMotionChange = e => applyMotionPreference(e.matches);
motionQuery.addEventListener('change', onMotionChange);
applyMotionPreference(motionQuery.matches);  // apply at init
// In destroy(): motionQuery.removeEventListener('change', onMotionChange);
// Store onMotionChange reference in instance state so destroy() can remove it.
```

Save `savedSpeedMax` and `savedOscillation` at init from the opts, so the restore path
has valid values even if the user never changes them. **Ordering dependency**: `uSpeedOscillation`
is added by this spec (SPEC-2d-organic), not SPEC-2d-core. The save/restore logic must
therefore run **after** SPEC-2d-organic's uniforms are initialised — i.e. inside the
init path for the organic feature set, not in the base `init2DRain` from SPEC-2d-core.

### Handle methods

New handle methods added by this spec (spanning §5–§7, consolidated here for reference):

| Method | Added by | Description |
|---|---|---|
| `setSpeedOscillation(v)` | §1 | Scale oscillation amplitude; 0.0 = off, 1.0 = full |
| `setWaveSpeed(v)` | §2 | Wave drift speed 0–0.2 rad/s |
| `setPhaseCorrelation(v)` | §2 | Phase correlation blend 0–1 |
| `setClusterStrength(v)` | §3 | Cluster vs independent blend 0–1 |
| `setClusterWidth(v)` | §3 | Segment width (rounded to integer), 2–8 |
| `setWeightedGlyphs(v)` | §4 | Weighted vs uniform glyph sampling 0–1 |
| `triggerSpeedRamp(targetMult, duration)` | §5 | Trigger speed ramp; no cancel (write `uSpeedRamp` directly to abort) |
| `triggerGlitch(intensity, duration)` | §6 | Trigger glitch; returns cancel `() => void` |
| `setFrozen(bool)` | §7 | Pause/resume RAF loop |
| `setReducedMotion(bool)` | §7 | Manually override OS motion preference (useful for testing) |

---

## New Uniforms Summary

All added by this spec:

| Uniform | Default | Handle method |
|---|---|---|
| `uSpeedOscillation` | 1.0 | `setSpeedOscillation(v)` |
| `uWaveSpeed` | 0.02 | `setWaveSpeed(v)` |
| `uPhaseCorrelation` | 1.0 | `setPhaseCorrelation(v)` |
| `uClusterWidth` | 4.0 | `setClusterWidth(v)` |
| `uClusterStrength` | 1.0 | `setClusterStrength(v)` |
| `uWeightedGlyphs` | 1.0 | `setWeightedGlyphs(v)` |

`uSpeedRamp` and `uGlitchAmt` are defined in SPEC-2d-core; this spec adds the JS trigger
methods only.

---

## `demo-2d.html` Additions

Add a second "Organic" section to the controls panel:

| Control | Type | Default | Method |
|---|---|---|---|
| Speed oscillation | checkbox | on | `setSpeedOscillation` |
| Wave speed | slider 0–0.2 | 0.02 | `setWaveSpeed` |
| Phase correlation | checkbox | on | `setPhaseCorrelation` |
| Cluster strength | slider 0–1 | 1.0 | `setClusterStrength` |
| Cluster width | slider 2–8 step 1 | 4 | `setClusterWidth` |
| Weighted glyphs | checkbox | on | `setWeightedGlyphs` |
| Glitch intensity | slider 0.1–1.0 | 0.6 | (intensity parameter for the button below) |
| Glitch | button "Trigger" | — | `triggerGlitch(intensity)` — reads intensity from slider above |
| Ramp multiplier | slider 1.5–6.0 | 4.0 | (targetMult parameter for the button below) |
| Speed ramp | button "Trigger" | — | `triggerSpeedRamp(targetMult)` — reads multiplier from slider above |
| Reduced motion | checkbox | follows OS | `setReducedMotion` |
| Freeze | checkbox | off | `setFrozen` |

---

## Tasks

**Note on `getStream` modification**: Tasks 1, 5, and 6 all modify `getStream` as defined
in SPEC-2d-core. These specs are not independently applicable — each modifies the same
function body. Implement them in the listed order, with each task editing the function
from the previous state. SPEC-2d-core and SPEC-2d-organic cannot be applied as isolated
patches to `getStream`. All three tasks use `t` as a closed-over variable from the
enclosing `buildRain2DNode` scope — no signature change to `getStream` is required.

### Tier 1 — High impact, low complexity

1. **Speed micro-oscillation** — modify `getStream` from SPEC-2d-core: add `fv`, `phiV`,
   `oscillation`; change `speed` declaration to `.toVar()`; add `uSpeedOscillation`
   uniform and `setSpeedOscillation` handle method.
   *(Depends on SPEC-2d-core complete. Modifies `getStream`.)*

2. **Speed ramp trigger** — JS-only; add `triggerSpeedRamp` to handle. No shader change.
   *(Depends on SPEC-2d-core.)*

3. **Glitch TSL node** — insert glitch displacement block at the SPEC-2d-core placeholder.
   Add `triggerGlitch` to handle.
   *(Depends on SPEC-2d-core.)*

4. **`prefers-reduced-motion`** — add query listener at init, `setFrozen`, `setReducedMotion`.
   *(Depends on SPEC-2d-core.)*

### Tier 2 — Medium complexity

5. **Inter-column phase correlation** — replace independent phase in `getStream` with
   correlated phase expression. Add `uWaveSpeed`, `uPhaseCorrelation`, handle methods.
   *(Depends on Task 1 complete; re-test oscillation interaction.)*

6. **Column clustering** — replace Bernoulli activation with segment-based activation.
   Add `uClusterWidth`, `uClusterStrength`, handle methods.
   *(Depends on SPEC-2d-core; can be developed in parallel with Task 5.)*

### Tier 3 — Higher complexity

7. **Weighted glyph LUT** — add `weights` arrays to `data/glyph-sets.js` for `matrix1999`.
   Build CDF `DataTexture` at init/`setCharSet`. Implement `sampleWeightedGlyph` TSL Fn.
   Add `uWeightedGlyphs` uniform and handle method.
   *(Depends on SPEC-2d-core; weighted sampling is independent of other organic features.)*

8. **`demo-2d.html` organic controls** — add Organic section with all controls above.
   *(Depends on Tasks 1–7.)*

9. **Manual browser test** — verify each feature independently with the demo toggle:
   - Oscillation: single column visibly varies speed over ~10 s window
   - Phase correlation: wave of activity sweeps left to right (~every 30 s at default wave speed)
   - Clustering: groups of 3–5 columns turn on/off together; disabling shows uniform random
   - Weighted glyphs: complex katakana visually dominant in `matrix1999` set
   - Glitch: scanlines displace horizontally, brightness spike appears briefly
   - Speed ramp: rain accelerates dramatically then returns to normal
   - Reduced motion: speed capped, oscillation off, freeze works

---

## Out of Scope

- Per-column clustering transition time control (fixed at 2–4 s; exposing this adds
  complexity without meaningful user benefit)
- True 2D noise (Simplex/Perlin) for phase correlation — sine-sum approximation is
  sufficient and avoids importing a noise library
- Automatic weight derivation from atlas pixel data — weights are defined manually in
  `glyph-sets.js` for the `matrix1999` set
- Film grain on the green channel (analysis §6 #4) — the post-processing `buildHoloPass`
  or CRT grain covers this when the 2D rain is used with CRT integration; adding it to
  the 2D node standalone is low priority and not spec'd here
