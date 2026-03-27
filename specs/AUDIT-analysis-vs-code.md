# Audit: matrix-rain-analysis.md vs. Current Implementation

*Date: 2026-03-27*
*Reference: `specs/matrix-rain-analysis.md`*

---

## Architecture Context

`matrix-rain-analysis.md` describes a **flat 2D fullscreen fragment shader** (WGSL/GLSL, cells on a
2D screen grid). The current implementation is a **3D instanced billboard system** on a spherical
shell (600 columns, Three.js WebGPU renderer, TSL node graph).

This audit proposes splitting the project into two complementary components:

| Component | Module | Description |
|---|---|---|
| **3D** (existing) | `matrix-rain-tsl.js` / `matrix-rain-webgpu.js` | Instanced billboards, spherical shell, full post-processing pipeline |
| **2D** (new) | `matrix-rain-2d-tsl.js` | Flat fullscreen TSL node material — film-accurate column state machine, direct port of analysis §5.3 |

Some features from the analysis fit cleanly on one component only; others fit on both. The tables
below mark which component each feature belongs to.

---

## 1. Already Covered — No Action Needed

| Feature | Analysis reference | Implementation | Component |
|---|---|---|---|
| Exponential trail brightness falloff | §3 Brightness Falloff | `exp(-d * vTrail * accel)` — same formula, slightly more aggressive accel past 50% | 3D |
| Head → white colour transition | §2 Colour Science, §3 | `mix(uColor*1.6, uColor*3.0+0.3, headFrac)` — different constants, same effect | 3D |
| Per-column phase offset | §3 Cycle Mechanics | `aSeed * cycleH` seeds start position across full cycle range | 3D |
| Variable trail length per column | §3 Stream State Variables | `vTrail` attribute: 0.015–0.05 (decay rate, not cell count) | 3D |
| Bloom | §2 Bloom Falloff | `BloomNode` in 9-stage PP pipeline | 3D |
| Phosphor persistence | §2 Phosphor Persistence | `buildPhosphorPass` — `max(current, prev * decay)` temporal feedback | 3D |
| Heat shimmer | §6 Post-Processing | `buildHeatPass` — UV warp from pixel brightness | 3D |
| Lens streaks | §6 Post-Processing | `buildStreakPass` | 3D |
| Holo (chroma + scanlines + vignette) | §6 Post-Processing | `buildHoloPass` | 3D |
| God rays | §6 Post-Processing | `buildGodRaysPass` — 80-sample radial crepuscular | 3D |
| CRT integration | §5.4 CRT Integration Layer | `matrix-rain-crt-bridge.js` + `demo-crt.html` | 3D |
| Burst / speed surge | §3 (implied fast streams) | 0.5% columns, 3× speed, 4 s cycle | 3D |
| Lateral sway per-column | — (not in analysis) | `sin(0.4t + aSeed*2π) * 0.04` — head-lead, tail-lag | 3D only |
| Globe proximity pulse | — (not in analysis) | `uGlobeInteract` — radial pulse at inner shell R=3.5 | 3D only |
| Named presets | — | `matrix-rain-presets.js` — 4 presets | both |
| Multi-set glyph atlas | — | `setCharSet()`, `matrix1999` / `latin` / `ascii` | both |

---

## 2. Partial / Approximate — Worth Reviewing

### 2.1 Two-stage colour mapping

**Analysis (§2 Colour Science):**
```
deep trail  #002D0A  → peak trail  #00FF41  → head  #C8FFD2
smoothstep(0.01, 0.15, brightness)       smoothstep(0.75, 1.00, brightness)
```
Two lerp stages keyed on *brightness* value, not distance.

**3D code:**
- Single `uColor` tint `(0, 1, 0.44)` = `#00FF70`
- Head boost: `mix(uColor*1.6, uColor*3.0+0.3, headFrac)` where `headFrac = 1 - smoothstep(0, 0.8, dist)`
- Deep trail fades to **black**, not to dark green `#002D0A`

**Gap:** The dark-green colour floor at the trail tail is absent. Subtle but visible when phosphor
persistence is high — deep-trail cells should retain a faint green glow, not go pure black.
The per-column hue-shift (±8° G-B rotation) partially compensates but isn't the same thing.

**Action:** Apply to **both** components. For 3D, add a `deepTrailColor` lerp stage in the fragment
Fn, keyed on the `trail` attenuation value rather than raw brightness.

---

### 2.2 Speed distribution

**Analysis (§3 Speed Distribution):**
Log-normal, `ln(v) ~ N(ln(2.5), 0.6²)`. Typical range 1.2–8.0 c/s. Squaring the hash biases toward
slow end:
```js
p.speed = mix(speed_min, speed_max, hash * hash);
```

**3D code:**
- Uniform `[0.4, 2.27]` cells/s in JS setup, no log-bias
- Burst surge extends effective max to ~6.8 (3× peak) for 0.5% columns
- Range is narrower than analysis; distribution not log-biased

**Gap:** Upper tail (fast "streakers" at 4–8 c/s) is missing without a burst. The "streaker"
feel in the film comes from a persistent handful of fast columns, not intermittent surges.

**Action:** Affects **both** components. For 3D, widen `aSpeed` range to `[1.2, 8.0]` and apply
`hash * hash` squaring in the JS init loop.

---

## 3. Not Implemented — Genuine Gaps

### 3.1 Position-based character flicker rates

**Analysis (§3 Character Change Rates):**

| Position | Rate | Mechanism |
|---|---|---|
| Head (`d < 1`) | ~15 Hz | Quantise `t` to 1/15 s ticks |
| Near-head (`1 ≤ d < 4`) | ~0.5 Hz | Per-cell slow hash |
| Mid-trail (`4 ≤ d < L/2`) | ~0.1 Hz | Per-cell very slow hash |
| Deep trail (`d ≥ L/2`) | Static | Fixed hash of (col, row) |

**3D code:**
- `holdSec` is random **per-cell**, range 0.45–7.6 s, independent of trail position
- Burst override bumps to 12 Hz for whole column (not head-specific)
- No spatial gradient of flicker rate

**Gap:** The "crystallised deep trail" feel — where the tail looks like settled, written characters —
comes entirely from the static deep-trail cells. Currently all cells have the same random rate,
so deep-trail cells flicker just as often as near-head cells.

**Component:** Applies to **both**. For 2D this is a direct port of the analysis logic.
For 3D, `dist` is already a varying — gate flicker rate on `vDist` ranges.

---

### 3.2 Column clustering (3D: angular clustering)

**Analysis (§3 Density & Spatial Distribution):**
> Active columns tend to cluster (groups of 2–4 active columns separated by 1–2 inactive).
> This was intentional — gives the rain a more natural, atmospheric appearance like actual rainfall
> which forms rivulets.

**3D code:** Pure `Math.random()` uniform placement on shell XZ plane. No clustering.

**2D equivalent:** Uniform random column density (Poisson), no grouping logic.

**Gap:** The "rivulet" feel is absent. All columns are equally likely to be active anywhere.

**Component:**
- **2D**: Cluster column activity by grouping the column index into segments and assigning a
  segment-level activity probability that transitions slowly.
- **3D**: Cluster by angular position (theta). Assign each column to an angular "band" of width
  ~5–10°; bands have a slowly-varying active fraction.

---

### 3.3 Speed micro-oscillation ("breathing")

**Analysis (§6 Making It Feel Alive, #2):**
```
v'(t) = v · (1 + 0.15 · sin(t · fv + φv))
```
`fv ∈ [0.1, 0.5]` Hz per stream, `φv` random per stream.

**3D code:** Only the burst surge (0.5% columns, large amplitude, infrequent). No ambient
sinusoidal speed modulation on every column.

**Gap:** The "breathing" quality — streams gently accelerating and decelerating — is absent.
The burst is a dramatic punctuation; the oscillation is a continuous organic quality.

**Component:** **Both**. In 3D, add to the vertex `speedMul` expression. In 2D, add to stream
speed in `get_stream()`.

---

### 3.4 Inter-column phase correlation (traveling waves)

**Analysis (§6 Making It Feel Alive, #5):**
```
φ'_c = φ_c + A · noise(c · 0.1),  A ≈ 8 s
```
Low-frequency noise field sampled at column position modulates phase offset, so waves of activity
sweep left-to-right across the screen.

**3D code:** Each column's `aSeed` is independent `Math.random()`. No spatial correlation between
adjacent columns. No traveling wave behavior.

**Gap:** The "waves of rain sweeping across" feel is absent. Currently the columns are
temporally independent.

**Component:**
- **2D**: Direct port — 1D noise over column index.
- **3D**: Noise over angular position (theta). Could use a simple `sin(theta * freq + t * waveSpeed)`
  to drive a phase offset, approximating the low-freq noise sweep.

---

### 3.5 Weighted glyph sampling

**Analysis (§6 Making It Feel Alive, #3):**
> Characters with more complex stroke patterns (many vertical lines) appear more frequently.
> Weight the character selection toward higher-complexity glyphs using a non-uniform distribution.

**3D code:** `floor(hash * uGlyphCount)` — uniform distribution over all glyphs.

**Gap:** Complex katakana (e.g. ﾆ, ﾊ, ﾃ) should appear more often than sparse ones (ｦ, ﾟ).

**Component:** **Both** — same glyph selection logic. Requires a weight table per glyph index
in the atlas, or a remapping LUT texture.

---

### 3.6 Multi-layer depth pass (2D: direct; 3D: superseded)

**Analysis (§5.5 Variations):**
Three composited passes: background (cell 12×18, speed max 2.5, brightness 0.35), midground
(defaults), foreground (cell 20×30, speed min 3.0, brightness 1.0, density 0.50).

**3D code:** Single instanced pass. Per-column scale `[0.5, 1.5]×` and depth tint provide a depth
cue. True layer parallax (larger cells for closer columns) is not present — scale variation is
random, not correlated with radial distance.

**Gap:**
- **3D**: Scale could be correlated with R (closer = larger cells). Currently scale is random.
  This isn't a missing feature so much as a tuning issue — the 3D spatial layout already provides
  parallax.
- **2D**: Full multi-layer is a first-class feature here. Three separate material instances
  composited additively, each with different `cellW`/`cellH`/`brightness`/`speedMax`.

**Component:** Primarily **2D**. For 3D, correlate `aScale` with R at init time instead of pure
random — low-effort improvement, not a full new system.

---

### 3.7 Public API: speed ramp + glitch trigger

**Analysis (§5.5 Variations):**
```js
triggerSpeedRamp(targetMult = 4.0, duration = 2.0)
triggerGlitch(intensity = 0.6, duration = 0.4)
```

**3D code:**
- `uSpeedMul` uniform exists in vertex shader but is **not exposed** as a handle method
- `uGlitchAmt` **does not exist** in the TSL shader — the glitch logic from the analysis WGSL
  was never ported

**Gap:** Both methods are missing from the public handle API.

**Component:** **Both**.
- Speed ramp: `uSpeedMul` just needs a `setSpeedMul(v)` handle method added (3D) and a uniform
  wired in the 2D material.
- Glitch: requires new `uGlitchAmt` uniform in `makeUniforms()`, a horizontal-scanline-shift node
  in the fragment Fn, and a `triggerGlitch()` handle method.

---

## 4. 3D-Only Features (not in analysis — preserve as-is)

These exist in the 3D codebase and have no equivalent in the analysis's flat shader. They are
project-specific enhancements, not gaps.

| Feature | Notes |
|---|---|
| Lateral sway oscillation | 0.064 Hz sine, head-lead, tail-lag |
| Globe proximity pulse | Radial wave at shell inner radius R=3.5 |
| POM (parallax occlusion mapping) | 8+3 step POM on glyph billboard surface |
| Chromatic aberration on glyphs | `uGlyphChroma` per-glyph chroma shift |
| Drip stretch at head | 35% Y-elongation, `exp(-dist*1.5)` |
| Boot cascade (startup animation) | Per-column staggered fade-in |
| Death/respawn cycle | `vDeathFade` with re-seed |
| `syncCamera` mode | Mirror external camera |
| `externalLoop` / `buildMatrixRainNodes` | CRT bridge integration API |
| Depth dim + near cull | `smoothstep(1.5, 3.5, camDist)` |
| Facing angle jitter | ±5° billboard orientation noise |

---

## 5. 2D Component — Feature Scope

The 2D component (`matrix-rain-2d-tsl.js`) would be a **film-accurate flat fullscreen material**,
suitable as a background layer, video source for CRT integration, or standalone demo.

### Should include (direct ports from analysis §5.3)
- Film-accurate two-stage colour ramp (deep `#002D0A` → green `#00FF41` → head `#C8FFD2`)
- Position-based flicker rates (§3.3.1)
- Log-biased speed distribution via `hash * hash`
- Multi-layer compositing option (3 passes, additive blend)
- Speed ramp API + glitch trigger API
- Weighted glyph sampling (or deferred until weight table is defined)

### Should include (enhancements over analysis)
- Inter-column phase correlation (analysis §6 #5)
- Column clustering (analysis §6 #1)
- Speed micro-oscillation (analysis §6 #2)
- `prefers-reduced-motion` support (already in backlog)

### Does NOT need
- POM, sway, globe pulse, drip stretch, syncCamera, externalLoop — these are 3D-specific

### Integration with 3D
The 2D component can be used as a `setSourceNode` input to the CRT bridge, replacing the 3D
scene render — useful for a pure flat-screen aesthetic vs. the volumetric 3D version.

---

## 6. Priority Order

### High — accuracy / feel impact, low implementation cost
1. **Position-based flicker rates** — both components; head static, tail fast is the #1 thing
   that makes deep trail "crystallise"
2. **Deep trail dark-green colour floor** — both; add `mix(deepTrail, color, smoothstep(…))` stage
3. **Speed ramp + glitch public API** — 3D only (expose existing `uSpeedMul`; add `uGlitchAmt`)
4. **Speed range widening + log-bias** — 3D init, JS change only

### Medium — noticeable but more work
5. **Speed micro-oscillation** — both; add `sin(t * fv + φv)` term to speed
6. **2D component** — new module, direct port of analysis §5.3 + enhancements above
7. **Scale-R correlation** — 3D init tweak (correlate column scale with radial distance)

### Low — subtle, complex, or architecturally awkward
8. **Inter-column phase correlation** — both; needs angular noise in 3D
9. **Column clustering** — both; needs angular band logic in 3D
10. **Weighted glyph sampling** — both; needs a weight table defined first
