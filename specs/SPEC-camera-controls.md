# SPEC-camera-controls

**Status**: Draft
**Priority**: P2 — usability / cinematic feel; adds TSL shader changes

---

## Motivation

Camera control is currently split between `matrix-rain-webgpu.js` (internal `PerspectiveCamera`,
`syncCamera` mirror) and `demo.html` (OrbitControls + WASD fly loop). There is no:

- FOV control exposed on the public handle
- Automated camera motion (orbit screensaver, cinematic flythrough)
- Any of the above in the demo UI
- Frustum culling — at any given orientation ~75% of the 600 shell columns are off-screen
  but still vertex-shaded; during continuous camera motion this waste is persistent

This spec adds a self-contained `CameraController` inside `matrix-rain-webgpu.js` that covers
all automated motion modes plus FOV, exposed via new handle methods, with corresponding
demo.html sliders and buttons. It also adds instance-level frustum culling (active only
during auto-move) and an optional column-follow mode for an infinite-rain illusion.

---

## Scope

| Feature | Handle method | demo.html control |
|---|---|---|
| FOV | `setFov(deg)` | Slider 15–120°, default 45 |
| Auto-orbit | `setAutoOrbit(enabled, speed?)` | Toggle + speed slider |
| Orbit elevation | `setOrbitElevation(deg)` | Slider −60–60°, default 0 |
| Flythrough | `setFlythrough(enabled, speed?, radius?)` | Toggle + speed + radius sliders |
| Column follow | `setColumnFollow(enabled)` | Toggle |
| Camera reset | `resetCamera()` | Button |
| Frustum culling | *(internal, no handle method)* | — |

Out of scope: custom waypoint paths, external OrbitControls integration, VR camera.

---

## Behaviour Specification

### FOV (`setFov(deg)`)

- Clamps to `[15, 120]`. Default `45`.
- Calls `camera.fov = clamped; camera.updateProjectionMatrix()`.
- Does NOT persist the value into a "last-set FOV" — `resetCamera()` always restores to 45.
- No-op while `syncCamera` is active.

### Auto-orbit (`setAutoOrbit(enabled, speed?)`)

Camera slowly circles the origin in the XZ plane with optional sinusoidal elevation.
Ideal screensaver / hands-off demo mode.

- `speed` — full orbit cycles per second (default `0.015`, range `0.001–0.5`).
- Radius: captured from `camera.position.length()` at the moment orbit is enabled, clamped
  to `[1, 30]`. Lets the user WASD into position then enable orbit.
- Each tick:
  ```
  θ  += speed × 2π × dt
  y   = sin(θ × 0.3) × sin(elevRad) × R    // elevRad from setOrbitElevation
  r   = sqrt(R² − y²)                       // XZ radius, constant orbital distance
  cam = (r×sin(θ), y, r×cos(θ))
  cam.lookAt(0, 0, 0)
  ```
- Mutually exclusive with flythrough: enabling one disables the other.
- `syncCamera` takes priority: if `activeSyncCamera` is set, auto-orbit is a no-op.

### Flythrough (`setFlythrough(enabled, speed?, radius?)`)

Camera follows a smooth Lissajous-style path through the column field.

Path equations (φ accumulates each frame):
```
φ    += speed × 2π × dt
x(φ)  = R × sin(φ)
z(φ)  = R × cos(φ × 0.7)        // ratio 7:10, path repeats after φ = 20π (long cycle)
y(φ)  = sin(φ × 0.4) × R × 0.35
```

Look-at target depends on column follow state:

- **Follow OFF**: look toward `(0, y(φ) × 0.3, 0)` — camera orbits at radius R and gazes
  inward toward the origin/column field centre. The slight vertical tilt follows the path height.
- **Follow ON**: the column field is centred on the camera, so looking at the origin-equivalent
  `(cam.x, y×0.3, cam.z)` would point straight up or down (degenerate). Instead, look toward
  the path position at `φ + 0.3` — this points the camera **forward along its travel direction**,
  which is the correct "flying through rain" perspective:
  ```
  φ_look = φ + 0.3
  lookAt( R×sin(φ_look),  sin(φ_look×0.4)×R×0.35,  R×cos(φ_look×0.7) )
  ```
  The look-ahead offset of 0.3 rad gives a robust, non-degenerate direction for all φ.

- `speed` — path cycles per second (default `0.008`, range `0.001–0.2`).
- `radius` — world units (default `4.5`, range `0.5–12`). Values 3–6 place the camera
  inside or near the column shell (inner=3.5, outer=8.0) for maximum immersion.
- No-op while `syncCamera` is active.
- Mutually exclusive with auto-orbit.

### Orbit elevation (`setOrbitElevation(deg)`)

- Peak elevation angle for the sinusoidal Y bobbing during auto-orbit.
- Range `[−60, 60]`, default `0` (flat orbit).
- No effect in flythrough mode.
- Elevation ±60° is safe: max y = sin(60°) × sin(60°) × R ≈ 0.75 × R, leaving
  r = sqrt(R² − (0.75R)²) = 0.66 × R — camera never collapses toward the Y axis.

### Column follow (`setColumnFollow(enabled)`)

Offsets the entire column field so it stays centred on the camera's XZ position, creating
an **infinite rain** illusion during flythrough.

- Default off.
- Updates `uColumnOffset` uniform (vec2) in the vertex shader each frame.
- Only the column placement positions are shifted; `r_zone` (zone biasing) is computed from
  the original baked `aColA.xy` values and remains origin-relative regardless of follow state.
- Can be enabled during orbit, flythrough, or manual camera movement.
- Effect is suppressed while `syncCamera` is active: the tick-loop column follow update lives
  inside the `if (!activeSyncCamera)` block, so `uColumnOffset` is never written. The flag
  can still be set and will take effect once syncCamera is removed.

### Camera reset (`resetCamera()`)

- Stops auto-orbit and flythrough; sets `columnFollow = false`.
- Resets `uColumnOffset` to `(0, 0)`.
- Restores `camera.position` to `(0, 0, 6)`, `camera.lookAt(0, 0, 0)`.
- Restores `camera.fov` to `45` (the true default, not the last-set value).
- In demo.html: also resets OrbitControls target to `(0, 0, 0)`, unchecks all camera toggles,
  and resets the FOV slider to 45.

---

## Internal Design

### `CameraController` class (inside `matrix-rain-webgpu.js`)

```js
class CameraController {
  constructor(camera) {
    this._cam        = camera;
    this._mode       = 'none';   // 'none' | 'orbit' | 'fly'
    this._orbitTheta  = 0;
    this._orbitRadius = 6;
    this._orbitSpeed  = 0.015;
    this._orbitElevDeg = 0;
    this._flyPhase   = 0;
    this._flySpeed   = 0.008;
    this._flyRadius  = 4.5;
    this._columnFollow = false;

    // Pre-allocated objects — reused every frame to avoid GC pressure
    this._frustum          = new THREE.Frustum();
    this._projScreenMatrix = new THREE.Matrix4();
    this._testSphere       = new THREE.Sphere(new THREE.Vector3(), 0);
  }

  setMode(mode) { this._mode = mode; }

  /** Advance camera path by dt seconds. Returns nothing; external code handles uniforms. */
  tick(dt) {
    if (this._mode === 'orbit') this._tickOrbit(dt);
    else if (this._mode === 'fly') this._tickFly(dt);
  }

  _tickOrbit(dt) {
    this._orbitTheta += this._orbitSpeed * Math.PI * 2 * dt;
    const elevRad = this._orbitElevDeg * Math.PI / 180;
    const y = Math.sin(this._orbitTheta * 0.3) * Math.sin(elevRad) * this._orbitRadius;
    const r = Math.sqrt(this._orbitRadius ** 2 - y ** 2);
    this._cam.position.set(
      r * Math.sin(this._orbitTheta),
      y,
      r * Math.cos(this._orbitTheta)
    );
    this._cam.lookAt(0, 0, 0);
  }

  _tickFly(dt) {
    this._flyPhase += this._flySpeed * Math.PI * 2 * dt;
    const φ = this._flyPhase;
    const R = this._flyRadius;
    const x = R * Math.sin(φ);
    const z = R * Math.cos(φ * 0.7);
    const y = Math.sin(φ * 0.4) * R * 0.35;
    this._cam.position.set(x, y, z);
    if (this._columnFollow) {
      // Look forward along the travel path (avoids degenerate up/down gaze when
      // column field is centred on camera and origin-look = straight up/down)
      const φl = φ + 0.3;
      this._cam.lookAt(
        R * Math.sin(φl),
        Math.sin(φl * 0.4) * R * 0.35,
        R * Math.cos(φl * 0.7)
      );
    } else {
      this._cam.lookAt(0, y * 0.3, 0);  // gaze inward toward column field centre
    }
  }

  /** CPU-side per-instance frustum cull. Call once per frame while mode !== 'none'. */
  updateFrustumCull(mesh, columnOffset) {
    this._cam.updateMatrixWorld();
    this._projScreenMatrix.multiplyMatrices(
      this._cam.projectionMatrix,
      this._cam.matrixWorldInverse
    );
    this._frustum.setFromProjectionMatrix(this._projScreenMatrix);

    const attr      = mesh.geometry.getAttribute('aFrustumVis');
    const positions = mesh.geometry.getAttribute('aColA');  // x=wx, y=wz

    for (let i = 0; i < attr.count; i++) {
      const wx = positions.getX(i) + columnOffset.x;
      const wz = positions.getY(i) + columnOffset.y;
      this._testSphere.center.set(wx, 0, wz);
      this._testSphere.radius = 8;  // halfWorldH = uWorldH/2 = 8; conservative column bound
      attr.array[i] = this._frustum.intersectsSphere(this._testSphere) ? 1 : 0;
    }
    attr.needsUpdate = true;
  }
}
```

### Integration into tick loop (`matrix-rain-webgpu.js`)

```js
// ── Camera auto-motion ────────────────────────────────────────────────
if (!activeSyncCamera) {
  camCtrl.tick(dt);

  // Column follow: keep column field centred on camera XZ
  if (camCtrl._columnFollow) {
    uniforms.uColumnOffset.value.set(camera.position.x, camera.position.z);
    _columnOffset.set(camera.position.x, camera.position.z);
  }

  // Frustum cull: update per-instance visibility only while auto-moving
  if (camCtrl._mode !== 'none') {
    camCtrl.updateFrustumCull(mesh, _columnOffset);
  }
}

// Existing syncCamera block follows unchanged
if (activeSyncCamera) { ... }
```

`dt` is already computed as `(ts - prevTs) / 1000` in the existing frame loop.

`_columnOffset` is a `THREE.Vector2` in the outer closure, initialised to `(0, 0)`, kept
in sync so `updateFrustumCull` always tests columns at their effective world position.

### State variables to add (outer `initMatrixRain` closure)

```js
const _columnOffset  = new THREE.Vector2();
const camCtrl        = new CameraController(camera);
```

### Handle method additions

```js
setFov(deg) {
  if (activeSyncCamera) return;
  camera.fov = Math.max(15, Math.min(120, deg));
  camera.updateProjectionMatrix();
},

setAutoOrbit(enabled, speed) {
  if (activeSyncCamera) return;
  if (speed !== undefined)
    camCtrl._orbitSpeed = Math.max(0.001, Math.min(0.5, speed));
  if (enabled) {
    camCtrl._orbitRadius = Math.max(1, Math.min(30, camera.position.length()));
    camCtrl._orbitTheta  = Math.atan2(camera.position.x, camera.position.z);
    camCtrl.setMode('orbit');
  } else if (camCtrl._mode === 'orbit') {
    camCtrl.setMode('none');
    _resetFrustumVis();
  }
},

setFlythrough(enabled, speed, radius) {
  if (activeSyncCamera) return;
  if (speed  !== undefined) camCtrl._flySpeed  = Math.max(0.001, Math.min(0.2, speed));
  if (radius !== undefined) camCtrl._flyRadius = Math.max(0.5,   Math.min(12,  radius));
  if (enabled) {
    camCtrl.setMode('fly');
  } else if (camCtrl._mode === 'fly') {
    camCtrl.setMode('none');
    _resetFrustumVis();
  }
},

setOrbitElevation(deg) {
  camCtrl._orbitElevDeg = Math.max(-60, Math.min(60, deg));
},

setColumnFollow(enabled) {
  camCtrl._columnFollow = !!enabled;
  if (!enabled) {
    uniforms.uColumnOffset.value.set(0, 0);
    _columnOffset.set(0, 0);
  }
},

resetCamera() {
  camCtrl.setMode('none');
  camCtrl._columnFollow = false;
  uniforms.uColumnOffset.value.set(0, 0);
  _columnOffset.set(0, 0);
  _resetFrustumVis();
  camera.position.set(0, 0, 6);
  camera.lookAt(0, 0, 0);
  camera.fov = 45;
  camera.updateProjectionMatrix();
},
```

### `_resetFrustumVis()` helper

Called when auto-move is disabled to restore all columns to visible:

```js
function _resetFrustumVis() {
  const attr = mesh.geometry.getAttribute('aFrustumVis');
  attr.array.fill(1);
  attr.needsUpdate = true;
}
```

### Frustum cull attribute: allocation and rebuildGeom

Allocated once after initial `buildGeometry()`:

```js
// Each Three.js instance is one character cell (nCols × N_ROWS = 72,000 total).
// The buffer must match instanceCount, not just nCols.
const frustumVisData = new Float32Array(mesh.geometry.instanceCount).fill(1);
const frustumVisAttr = new THREE.InstancedBufferAttribute(frustumVisData, 1);
mesh.geometry.setAttribute('aFrustumVis', frustumVisAttr);
```

`rebuildGeom()` currently disposes and replaces the geometry. Extend it to re-attach:

```js
function rebuildGeom() {
  const newGeom = buildGeometry(_geomParams);
  newGeom.setAttribute('aFrustumVis', frustumVisAttr);  // re-attach same buffer
  mesh.geometry.dispose();
  mesh.geometry = newGeom;
  s.geom = newGeom;
}
```

The same `frustumVisAttr` (and its underlying `frustumVisData` Float32Array) is reused
across rebuilds — only the geometry object changes, not the buffer.

**Note on loop count**: `updateFrustumCull` iterates `attr.count = 72,000` times (one per
cell instance). All rows of a given column share the same `aColA.xy` (wx/wz), so 120
identical sphere tests run per column — still trivially fast at < 0.2 ms/frame total.

---

## Shader Changes

### `matrix-rain-tsl.js` — attribute declaration

```js
// Add alongside existing attribute() declarations:
const aFrustumVisAttr = attribute('aFrustumVis', 'float');
```

Uses the same `attribute()` function already imported from `three/tsl`.

### `matrix-rain-tsl.js` — column placement gate

The existing outer density guard (line ~252):
```js
If(h2(vec2(aColIdxAttr.mul(0.137).add(0.5), float(42.7))).lessThanEqual(zonedDensity), () => {
```

Extend to include frustum visibility:
```js
const densityPasses = h2(vec2(aColIdxAttr.mul(0.137).add(0.5), float(42.7)))
  .lessThanEqual(zonedDensity);
If(densityPasses.and(aFrustumVisAttr.greaterThan(float(0.5))), () => {
```

### `matrix-rain-tsl.js` — column offset uniform

Add to `makeUniforms()`:
```js
uColumnOffset: uniform(new THREE.Vector2(0, 0)),
```

In the vertex node Fn, replace the existing `aWX`/`aWZ` declarations:
```js
// was: const aWX = aColAAttr.x;  const aWZ = aColAAttr.y;
const aWX = aColAAttr.x.add(uColumnOffset.x);
const aWZ = aColAAttr.y.add(uColumnOffset.y);
```

**Note**: `r_zone` at line ~226 reads `aColAAttr.x` / `aColAAttr.y` directly and is not
updated. Zone biasing therefore remains origin-relative and is unaffected by column follow.
This is intentional — inner/outer zone effects should track the column's structural position,
not the camera.

---

## demo.html Changes

### New "Camera" sub-panel (inside the controls panel, after Scene section)

```
▼ Camera
  [Reset Camera]               (button)
  FOV            [==●====] 45  (range 15–120, step 1)
  Auto-Orbit     [toggle]
    Speed        [==●====] 0.015  (range 0.001–0.5, step 0.001; shown only when on)
    Elevation    [==●====] 0      (range -60–60, step 1;         shown only when on)
  Flythrough     [toggle]
    Speed        [==●====] 0.008  (range 0.001–0.2, step 0.001;  shown only when on)
    Radius       [==●====] 4.5    (range 0.5–12, step 0.1;       shown only when on)
  Column Follow  [toggle]  — best with Flythrough
```

Sub-options shown/hidden via `display:none` toggled when the parent toggle changes.

Auto-orbit and Flythrough toggles are mutually exclusive: enabling one programmatically
unchecks the other and hides its sub-options.

`resetCamera()` call from the button must also: reset FOV slider to 45, uncheck both
auto-move toggles and Column Follow toggle, hide all sub-option rows.

### WASD guard while auto-move is active

In demo.html's existing WASD loop, guard only the movement application — not the whole
iteration, to keep `controls.update()` running for OrbitControls damping:

```js
// Suppress WASD movement while auto-orbit or flythrough is active to prevent fighting
const autoCamActive = orbitToggle.checked || flythroughToggle.checked;
if (!autoCamActive && (dx || dz)) {
  const speed = (_keys['ShiftLeft'] || _keys['ShiftRight']) ? MOVE_SPEED * 2 : MOVE_SPEED;
  const delta = _fwd.clone().multiplyScalar(dz * speed).addScaledVector(_right, dx * speed);
  cam.position.add(delta);
  controls.target.add(delta);
}
controls.update();  // always runs — preserves damping during auto-move
```

The existing `if (dx || dz) { ... } controls.update()` block is replaced with the above.

---

## API Summary

| Method | Params | Default |
|---|---|---|
| `setFov(deg)` | 15–120 | 45 |
| `setAutoOrbit(enabled, speed?)` | speed: 0.001–0.5 | 0.015 |
| `setOrbitElevation(deg)` | −60–60 | 0 |
| `setFlythrough(enabled, speed?, radius?)` | speed: 0.001–0.2, radius: 0.5–12 | 0.008, 4.5 |
| `setColumnFollow(enabled)` | — | false |
| `resetCamera()` | — | — |

---

## CLAUDE.md Changes Required

Add to the **Handle Methods** table:

```
| `setFov(deg)` | Camera field of view 15–120° |
| `setAutoOrbit(on, speed?)` | Orbit screensaver mode |
| `setOrbitElevation(deg)` | Orbit Y-bob peak angle −60–60° |
| `setFlythrough(on, speed?, radius?)` | Cinematic flythrough path |
| `setColumnFollow(on)` | Offset column field to follow camera (infinite rain) |
| `resetCamera()` | Restore default camera state |
```

---

## Implementation Steps

1. Add `CameraController` class (verbatim from Internal Design) at module scope inside
   `matrix-rain-webgpu.js`, before `initMatrixRain`.
2. Add `const _columnOffset = new THREE.Vector2()` and `const camCtrl = new CameraController(camera)`
   to the `initMatrixRain` closure (after camera creation).
3. Allocate `frustumVisAttr` and attach to initial geometry after `buildGeometry()`.
4. Update `rebuildGeom()` to re-attach `frustumVisAttr` to the new geometry.
5. Add `uColumnOffset` uniform to `makeUniforms()` in `matrix-rain-tsl.js`.
6. Add `aFrustumVisAttr` attribute read to `buildGlyphMaterial` in `matrix-rain-tsl.js`.
7. Update density placement guard to include `aFrustumVisAttr` check.
8. Update `aWX` / `aWZ` reads to add `uColumnOffset`.
9. Integrate `camCtrl.tick(dt)`, column-follow uniform update, and `updateFrustumCull` into
   existing tick loop (before syncCamera block).
10. Add `_resetFrustumVis()` helper.
11. Add the six handle methods to the returned handle object.
12. Add Camera sub-panel HTML to `demo.html` with `linkSlider` / toggle wiring.
13. Add WASD guard to demo.html controls loop.
14. Update `CLAUDE.md` handle methods table.

---

## Edge Cases

- **syncCamera active**: `setFov`, `setAutoOrbit`, `setFlythrough` are no-ops (guarded by
  `if (activeSyncCamera) return`). `setColumnFollow` has no such guard — the flag can be set,
  but the column follow update inside the tick loop is guarded by `if (!activeSyncCamera)`,
  so no uniform is written until syncCamera is removed.
- **API mutual exclusion**: from the public API, calling `setAutoOrbit(true)` then
  `setFlythrough(true)` is valid — the second call wins (`camCtrl._mode` becomes `'fly'`).
  The demo.html UI handles mutual exclusion by unchecking the other toggle. Document this
  in JSDoc.
- **Orbit radius near zero**: `camera.position.length()` clamped to `[1, 30]` prevents
  collapse.
- **Elevation ±60° safety**: max y = sin(60°)² × R ≈ 0.75R; r = 0.66R — no collapse.
- **Resize during flythrough**: camera position is recomputed from φ each tick; aspect ratio
  update in the resize handler is independent and sufficient.
- **`rebuildGeom()`**: re-attaches the existing `frustumVisAttr` (same buffer object) to the
  new geometry — no reallocation needed.
- **`destroy()`**: RAF cancellation stops the tick loop; `frustumVisAttr` is released when the
  geometry is disposed; the Float32Array backing it is GC'd when the closure is released.
- **Column follow + orbit**: orbit moves the camera in XZ; column offset tracks correctly.
  Y is intentionally excluded from the offset (columns span full world height).
- **Flythrough + column follow lookAt**: when follow is on, the column field is centred on
  the camera, so looking at `(cam.x, y×0.3, cam.z)` would produce a nearly straight-down
  look direction. `_tickFly` instead looks toward the path position at `φ + 0.3`, which
  points forward along the travel direction. The offset 0.3 rad ≈ 17° arc is large enough
  to be non-degenerate for all φ and small enough to feel like looking ahead.
