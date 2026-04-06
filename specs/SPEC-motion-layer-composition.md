# SPEC — Motion layer composition

**Status**: Approved
**Priority**: P1
**Depends on**: `SPEC-settings-terminology-and-state`
**Goal**: Define how breathing, head wave, speed entrainment, scan phase
lock, clustering, squads, burst participation, and special modes compose so the
system reads as one coherent motion design instead of several overlapping
effects.

---

## Problem

The current motion system is feature-rich, but composition is mostly implicit.
Each layer was added locally and many of them are individually correct, yet the
combined result is harder to reason about than it should be.

Current issues:

- `Breathing`, `head wave`, and `speed entrainment` all alter perceived motion,
  but they live on different mathematical layers and do not advertise their
  precedence.
- `Scan phase lock` fully overrides natural cycle motion but only partially
  suppresses the user's mental model of other motion layers.
- `Cluster burst participation`, `squad phase lock`, `cluster speed range`, and
  `head wave` can all make columns look synchronized, but by different
  mechanisms.
- Some special modes, such as scanline boot and message lock, are effectively
  higher priority than ordinary motion layers, but that priority is not defined
  as a system rule.
- Several controls are "orthogonal" in implementation but not in perception,
  which makes the panel easy to overtune into mud.

The result is not a wiring bug. It is a composition and precedence problem.

---

## Goals

1. Define a canonical motion stack with clear ownership for speed, phase,
   position, visibility, and overrides.
2. Define precedence rules for ordinary motion layers versus special modes.
3. Specify when an effect should multiply, add, blend, or suppress another.
4. Preserve the current expressive range while reducing accidental visual
   redundancy.
5. Create a basis for future implementation changes such as motion modes,
   effect grouping, or true burst propagation.

---

## Non-goals

- No mandatory control removal in this spec.
- No change to default values in this spec.
- No redesign of the cluster geometry builder.
- No attempt to make every layer mathematically independent.
- No new compute-driven state model.

---

## Design principle

Every motion layer must own one primary domain:

| Domain | Owner examples |
|---|---|
| Base identity | cluster seeds, squad seeds, per-column seed |
| Speed modulation | breathing, burst participation, zone speed, speed entrainment |
| Cycle phase seed | squad phase lock, per-column seed |
| Global cycle override | scan phase lock |
| Positional offset | head wave |
| Activation / visibility | spawn wave, density gates, startup cascade |
| Hard overrides | message lock, frozen state |

If two effects appear to solve the same perceptual job, one must be designated
primary and the other secondary.

One-shot trigger defaults such as scanline sweep speed or dissolve duration are
not motion layers. They configure how a special mode starts, but they do not
own a runtime motion domain by themselves.

---

## Canonical stack

The system must be documented and reasoned about in this order:

```text
1. geometry identity
   cluster / squad / per-column seeds

2. activation gates
   density
   spawn wave
   startup cascade
   frustum / message reserve conditions

3. base speed
   aSpeed
   cluster speed range

4. speed modulation
   breathing
   individual burst + cluster burst participation
   radial zone speed
   speed entrainment

5. cycle seed selection
   mix(aSquadPhase, aSeed, squad control)

6. natural cycle position
   time * effectiveSpeed * speedMul + phaseSeed * cycleH

7. global cycle override
   scan phase lock

8. directional interpretation
   reverse chance

9. positional offsets
   head wave
   category-C spatial transforms such as gravity / spiral / perspective

10. hard overrides
    message lock
    frozen state
```

This order is normative. Future features must state which layer they belong to.
If a feature only configures a trigger, it belongs outside the stack.

---

## Composition rules

### Rule 1 — Speed effects multiply, not compete

All ordinary speed-domain effects must combine multiplicatively.

Examples:

- breathing
- burst participation
- radial zone speed
- speed entrainment
- cluster speed range via `effectiveSpeed`

This keeps them composable and avoids hidden winner-take-all behavior.
`Cluster burst participation` lives in this domain even though it is perceived
as group synchrony, because it changes burst-driven speed behavior rather than
directly setting phase or position.

### Rule 2 — Head wave owns positional sweep

`Head wave` is the primary spatial sweep effect. It must remain the only
ordinary motion layer whose primary job is to offset head placement directly
around the field.

Implications:

- `Speed entrainment` must remain speed-only.
- `Squad phase lock` must remain seed-based, not a direct position offset.
- Future wave-like features should prefer speed or phase ownership before adding
  another direct positional offset layer.

### Rule 3 — Scan phase lock overrides cycle motion, not identity

`Scan phase lock` is the only ordinary global cycle override.

During scan lock:

- base seeds still exist
- cluster and squad identity still exist
- speed-domain effects may continue to run internally
- visible cycle motion must be dominated by the shared cycle position

This means scan lock owns perceived cycle alignment, even if the hidden natural
phase branch still receives modulation.

### Rule 4 — Hard locks beat scan lock

Message-locked columns and frozen state are higher priority than scan phase
lock. In this spec, `explicit hard lock` means any future non-message placement
lock with the same precedence characteristics.

Priority order:

```text
frozen state / explicit hard lock
  > message lock
  > scan phase lock
  > ordinary motion layers
```

If a column is explicitly locked to a message path, scanline may glow around it,
but it must not pull that column off the lock path.

### Rule 5 — Activation gates do not redefine motion

Spawn wave, density, and startup cascade are activation and visibility systems,
not motion drivers.

They may determine whether a column participates visually, but they must not
change the underlying meaning of:

- squad phase lock
- speed entrainment
- head wave
- cluster burst participation

---

## Special-mode behavior

### Scanline boot sweep

The scanline sweep is a special mode, not merely another effect.

Required behavior:

- perceived cycle position is scanline-owned
- speed-domain modulation is visually subordinated
- head wave is visually subordinated
- activation gates still apply
- hard locks still win

Recommended implementation rule:

```text
When scan phase lock > 0:
  keep internal speed modulation alive
  attenuate head wave visually by (1 - scanLock) or equivalent
```

Rationale:

The current implementation already suppresses most natural cycle motion because
`cyclePos` is blended to the shared phase. Attenuating head wave during scan
lock would make the sweep read more cleanly as a single phenomenon instead of a
stack of unrelated motion cues.

### Message reveal / locked columns

Message-locked columns are a hard-placement mode.

Required behavior:

- locked placement wins over head wave and scanline cycle alignment
- cluster color and brightness identity may remain
- non-positional FX may remain if they do not undermine readability

### Reduced motion

Reduced motion should target perceptual intensity, not just raw speed.

Recommended future policy:

- cap speed ramps
- reduce or zero head wave
- reduce speed entrainment
- reduce scanline dissolve aggressiveness
- preserve cluster / squad identity where possible

---

## Perceptual ownership

The following table defines which control family should be understood as the
main driver for a given look.

| Desired look | Primary control family | Secondary contributors |
|---|---|---|
| Local alive / organic drift | breathing | squad phase lock |
| Large-scale tides / weather | speed entrainment | cluster speed range |
| Visible moving sweep across the field | head wave | speed entrainment |
| Group pulses | cluster burst participation | squad phase lock |
| Tight sub-group synchrony | squad phase lock | cluster speed range |
| Mechanical boot alignment | scan phase lock | spawn wave only as activation |

This table is normative for future tuning and defaults.

---

## Conflict reduction rules

### Head wave vs speed entrainment

These two families are allowed to coexist, but the system should prevent them
from reading as two equal competing macro-waves.

Recommended rule:

- if both are strong, `head wave` remains the visible sweep
- `speed entrainment` reads as support texture, not a second primary sweep

A future implementation may enforce this by:

- reducing max recommended `uEntrainAmt` when `uWaveAmt` is high
- surfacing advisory UI hints
- adding a "motion balance" preset layer

### Squad phase lock vs scan phase lock

These are not peers.

- squad phase lock is a natural phase-seed relationship
- scan phase lock is a temporary global override

During scan phase lock, squad effects may remain latent but should not compete
for visible ownership.

### Cluster burst participation vs real contagion

The current burst system must be treated as rhythmic cluster participation, not
as spatial propagation.

Until true propagation exists:

- docs must not describe it as spreading
- tuning should emphasize pulse / participation, not infection / contagion

---

## Optional consolidation model

This spec does not require UI consolidation, but it defines a future-safe path
if the panel needs simplification.

Three high-level motion groups are permitted:

```text
micro motion
  breathing
  squad phase lock

macro motion
  head wave
  speed entrainment
  cluster burst participation

special modes
  spawn wave
  scan phase lock
  message lock
```

A future control panel may group the sliders this way without changing the
underlying API.

---

## Recommended implementation changes

This spec is behavioral, but it includes recommended concrete changes for a
future implementation pass.

### Change 1 — Attenuate head wave during scan phase lock

Current issue:

- scan phase lock owns cycle alignment
- head wave can still introduce a competing positional cue

Recommended behavior:

```text
effectiveHeadWave = headWave * (1 - scanLock)
```

This keeps the scanline visually clean while preserving normal behavior at
`scanLock = 0`.

### Change 2 — Distinguish ordinary motion from special modes in the UI

Current issue:

- scanline controls live near ordinary runtime controls
- users can read them as another peer motion effect

Recommended behavior:

- visually separate `special modes` from ordinary motion controls
- group `scanline boot` with its own explanatory heading

### Change 3 — Add advisory constraints for overtuning

Current issue:

- strong head wave + strong entrainment + strong burst participation can muddy
  the dominant visual read

Recommended behavior:

- add non-blocking hints or soft caps in presets / docs
- avoid hard runtime coupling unless a later tuning pass proves necessary

### Change 4 — Prefer `Squad independence` as the visible control

Current issue:

- users often expect larger values of `coherence` to mean more locking

Recommended behavior:

- expose `Squad independence` in UI
- map it directly to the existing coherence math or invert in UI if desired
- document the mapping explicitly

---

## Files affected

This is a design spec first. If implemented, likely files are:

| File | Change |
|---|---|
| `matrix-rain-tsl.js` | Composition adjustments, especially scanline/head-wave interaction |
| `matrix-rain-webgpu.js` | Special-mode policy, reduced-motion policy, optional grouped helpers |
| `matrix-3d.html` | Panel grouping and explanatory copy |
| `CLAUDE.md` | Canonical motion-stack terminology |
| related specs | Update to reference the canonical stack and precedence rules |

---

## Acceptance criteria

1. The project has one explicit canonical motion stack with domain ownership.
2. Special modes such as scanline and message lock have explicit precedence over
   ordinary motion layers.
3. `Head wave` and `speed entrainment` are defined as complementary, not peer
   duplicates.
4. Clustering, squads, scanline, and burst participation can be described in one
   consistent mental model without contradicting the code.
5. Future motion features can state where they belong in the stack before being
   added.

---

## Open questions

These are intentionally left open for a later implementation pass:

1. Should scanline attenuate only head wave, or also attenuate visible gravity /
   spiral displacement while active?
2. Should reduced motion preserve scanline boot as a mode, but with lower lock
   duration and zero head-wave contribution?
3. Should the UI eventually offer high-level presets such as `organic`,
   `mechanical`, and `boot` that rebalance multiple motion layers together?
4. Should true propagation replace `cluster burst participation`, or is the
   simpler rhythmic pulse sufficient for the intended look?

---

## Next step

If you implement this spec after the terminology/state cleanup, the safest order
is:

1. attenuate head wave during scan phase lock
2. regroup UI into ordinary motion versus special modes
3. update docs and defaults
4. only then consider stronger coupling or preset-level rebalancing
