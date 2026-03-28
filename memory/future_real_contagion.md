---
name: Future — Real Neighbor-Propagation Contagion
description: Planned feature: true spatial burst contagion spreading column-by-column by angular proximity, distinct from current cluster-sync burst
type: project
---

Current "contagion" (`uContagionStrength`, `setContagion()`) is cluster-simultaneous burst: when a cluster's 0.32-second window opens within its 4-second cycle, a fraction equal to `uContagionStrength` of all columns in that cluster fire at once. It is *not* spatial propagation.

**Why:** Real contagion — burst spreading from a triggered column to its angular neighbors over time — was deferred because it requires per-frame mutable GPU state (a ping-pong texture or storage buffer) that the current attribute-only architecture does not support.

**How to apply:** When this feature is revisited:
- Each frame, read previous burst state from a storage texture (one texel per column, keyed by `aColIdx` or angular bucket)
- Propagate: if a neighbor within angular threshold `θ` is bursting, this column fires with probability `contagionRate * dt`
- Write new burst state back for the next frame
- The existing `aClusterBurstSeed` and `uContagionStrength` uniform can be repurposed for the propagation rate parameter
- Angular neighbor lookup can use `aSpawnTheta` (normalized [0,1] angular position already in the attribute buffer)

**Reference:** Comment in `matrix-rain-webgpu.js` above `setContagion()`. UI label is "Cluster sync" (renamed from "Contagion" to accurately describe current behavior).
