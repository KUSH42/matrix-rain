/**
 * matrix-rain-tsl.js  —  TSL vertex + fragment shaders for the instanced
 * Katakana glyph mesh.  Ported from the GLSL ShaderMaterial in matrix-rain.js.
 *
 * Exports
 *   makeUniforms()                              → mutable uniform nodes
 *   buildGlyphMaterial(uniforms, atlasTexture)  → MeshBasicNodeMaterial
 */

import {
  Fn, float, int, vec2, vec3, vec4,
  attribute, uniform, varying,
  sin, cos, exp, sqrt, dot, normalize, length,
  floor, fract, mod, step, smoothstep, clamp, mix,
  abs, max, min, sign, pow, atan,
  cameraViewMatrix, cameraProjectionMatrix, cameraPosition,
  positionGeometry, uv, frontFacing, screenUV,
  select, texture,
  If, Loop, Break, Discard,
  dFdx, dFdy,
} from 'three/tsl';
import * as THREE from 'three/webgpu';

// ── Stable 2-component hash ───────────────────────────────────────────────
// Identical to H2_GLSL in the original — keeps inputs small with fract() to
// avoid GPU sin() precision issues at large t values.
export const h2 = Fn(([v]) => {
  const s = fract(v.mul(vec2(0.1031, 0.1030))).toVar();
  s.addAssign(dot(s, s.yx.add(33.33)));
  return fract(s.x.add(s.y).mul(s.x));
});

// ── MSDF median — preserves sharp corners ────────────────────────────────
export const median3 = Fn(([a, b, c]) => max(min(a, b), min(max(a, b), c)));

// ── Uniform factory ───────────────────────────────────────────────────────
/**
 * @param {number}              [glyphCount=56]  total glyphs in the MSDF atlas
 * @param {number}              [gridW=8]        columns in atlas grid
 * @param {number}              [gridH=8]        rows in atlas grid
 * @param {THREE.CanvasTexture} [dummyMsgTex]    1×1 black canvas texture for uMsgTex initial value
 * @param {THREE.DataTexture}   [lutTexture]     256×1 glyph weight LUT; built as uniform identity if null
 * @returns {object}  all mutable TSL uniform nodes
 */
export function makeUniforms(glyphCount = 56, gridW = 8, gridH = 8, dummyMsgTex, lutTexture = null) {
  // Build a uniform identity LUT if none supplied (placeholder; replaced via applyGlyphWeightLUT).
  if (!lutTexture) {
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) lut[i] = Math.floor(i * glyphCount / 256);
    lutTexture = new THREE.DataTexture(lut, 256, 1, THREE.RedFormat, THREE.UnsignedByteType);
    lutTexture.minFilter = lutTexture.magFilter = THREE.NearestFilter;
    lutTexture.needsUpdate = true;
  }
  return {
    uGlyphCount:     uniform(glyphCount),
    uAtlasGridW:     uniform(gridW),
    uAtlasGridH:     uniform(gridH),
    uTime:           uniform(0),
    uCellW:          uniform(0.12),
    uCellH:          uniform(0.08),
    uWorldH:         uniform(16),
    uNRows:          uniform(120),
    uColor:          uniform(new THREE.Vector3(0, 1, 0.44)),
    uColor2:         uniform(new THREE.Vector3(0, 1, 0.44)), // second colour for per-column blend
    uGlobalAlpha:    uniform(0.82),
    uDepth:          uniform(0.04),
    uPomSteps:       uniform(6),
    uNormalStrength: uniform(6),
    uLightDir:       uniform(new THREE.Vector3(-0.4, 0.8, 0.5).normalize()),
    uGlyphChroma:    uniform(1.0),
    uSpeedMul:       uniform(1.0),
    uMaxYaw:         uniform(Math.PI), // max deviation from camera angle (radians); π = unconstrained
    uFacingJitter:   uniform(0.1745), // ±jitter radians on each column's yaw (default ±5°)
    uFlatZ:          uniform(0.0),   // 0 = spherical shell, 1 = flat plane at Z=0
    uForwardFacing:  uniform(0.0),  // 0 = target/camera blend, 1 = force +Z (for curtain topology)
    uGlobeInteract:  uniform(1.0),   // 0 = off, 1 = on — gates globe proximity pulse
    uSwayAmt:        uniform(0.04),  // lateral sway amplitude (world units)
    uSwayDecay:      uniform(1.5),   // exponential decay rate — higher = settles faster
    uMsgTex:            texture(dummyMsgTex, screenUV), // 1×1 black CanvasTexture; screenUV baked in
    uMsgRevealProgress: uniform(0.0),                   // overall effect opacity 0–1
    uMsgWaveX:          uniform(0.0),                   // leading-edge X in screen UV (0–1)
    uMsgBoost:          uniform(3.0),                   // brightness multiplier in text region
    uGlyphWeightLUT:    texture(lutTexture),             // 256×1 inverse-CDF glyph weight LUT
    uBrightness:     uniform(1.0),   // output brightness multiplier — range [0.2, 2.0]
    uBreathAmt:      uniform(1.0),   // speed-oscillation amplitude scale — 0 = off, 1 = ±15%
    uWaveSpeed:      uniform(0.15),  // wave crest angular speed in rad/s (hardcoded was 0.15)
    uWaveAmt:        uniform(1.0),   // wave offset amplitude scale — 0 = off, 1 = ±4 world units
    uWeightedGlyphs: uniform(1.0),  // LUT weight blend — 0 = uniform sampling, 1 = full LUT
    uReverseChance:  uniform(0.0),  // fraction of columns that fall upward — 0 = all down, 1 = all up
    uDensity:        uniform(1.0),   // fraction of columns active — range [0.1, 1.0]
    uZoneSpeedInner: uniform(1.0),   // speed bias at r = R_MIN  (inner / close)
    uZoneSpeedOuter: uniform(1.0),   // speed bias at r = R_MAX  (outer / far)
    uZoneBrightInner: uniform(1.0),  // brightness bias at r = R_MIN
    uZoneBrightOuter: uniform(1.0),  // brightness bias at r = R_MAX
    uDensityInner:   uniform(1.0),   // radial density multiplier at inner shell (t_zone=0)
    uDensityOuter:   uniform(1.0),   // radial density multiplier at outer shell (t_zone=1)
    uSectorCenter:   uniform(0.0),   // world XZ angle of arc center (radians)
    uSectorWidth:    uniform(Math.PI), // half-angle of arc (radians); default π = widest single arc
    uSectorStrength: uniform(0.0),   // 0 = off (default), 1 = full mask outside arc
    uHeightFade:     uniform(0.0),   // 0 = off, 1 = full sine density envelope; range 0–1
    // Glyph FX controls
    uDripAmt:        uniform(0.35),  // drip-stretch Y-scale amplitude  0–0.8
    uEdgeGlow:       uniform(0.4),   // edge-emission corona intensity   0–1.5
    uZRotRange:      uniform(0.1745),// per-column Z-rotation max angle  0–0.524 rad (0–30°)
    uGrainAmt:       uniform(0.07),  // film-grain strength              0–0.25
    uDepthTintAmt:   uniform(0.4),   // atmospheric depth-tint blend     0–1
    uBootEnabled:    uniform(1.0),   // startup cascade on/off           0 or 1
    uStability:      uniform(0.30),  // fraction of stable cells         0–1
    uHoldMult:       uniform(1.0),   // hold-cycle duration multiplier   0.1–5
    uBurstGlyphRate: uniform(12.0),  // glyph-change rate during burst   1–30 Hz
    uHueRange:       uniform(0.5),   // per-column colour blend spread 0–1 (0=all uColor, 1=full mix)
    uBurstProb:      uniform(0.005), // fraction of columns that burst per 4 s cycle
  };
}

// ── Material builder ──────────────────────────────────────────────────────
/**
 * Build the instanced glyph NodeMaterial.
 *
 * @param {ReturnType<makeUniforms>} uniforms
 * @param {THREE.Texture}            atlasTexture  pre-loaded MSDF atlas
 * @returns {THREE.MeshBasicNodeMaterial}
 */
export function buildGlyphMaterial(uniforms, atlasTexture) {
  const {
    uGlyphCount, uAtlasGridW, uAtlasGridH, uTime,
    uCellW, uCellH, uWorldH, uNRows,
    uColor, uGlobalAlpha, uDepth, uPomSteps, uNormalStrength,
    uLightDir, uGlyphChroma,
    uSpeedMul, uMaxYaw, uFacingJitter, uFlatZ, uForwardFacing, uGlobeInteract, uSwayAmt, uSwayDecay,
    uMsgTex, uMsgRevealProgress, uMsgWaveX, uMsgBoost,
    uGlyphWeightLUT,
    uBrightness, uBreathAmt, uWaveSpeed, uWaveAmt, uWeightedGlyphs, uReverseChance,
    uDensity,
    uZoneSpeedInner, uZoneSpeedOuter, uZoneBrightInner, uZoneBrightOuter,
    uDensityInner, uDensityOuter,
    uSectorCenter, uSectorWidth, uSectorStrength, uHeightFade,
    uDripAmt, uEdgeGlow, uZRotRange, uGrainAmt, uDepthTintAmt,
    uBootEnabled, uStability, uHoldMult, uBurstGlyphRate,
    uColor2, uHueRange, uBurstProb,
  } = uniforms;

  // ── Per-instance buffer attributes ────────────────────────────────────
  const aColIdxAttr = attribute('aColIdx', 'float');
  const aRowIdxAttr = attribute('aRowIdx', 'float');
  const aColAAttr   = attribute('aColA',   'vec4');  // wx, wz, speed, seed
  const aColBAttr   = attribute('aColB',   'vec4');  // yOff, scale, alpha, trail

  // ── Varyings shared between vertex and fragment stages ─────────────────
  const vUvRain    = varying(vec2(),   'vUvRain');
  const vDist      = varying(float(),  'vDist');
  const vColIdx    = varying(float(),  'vColIdxR');
  const vRowIdx    = varying(float(),  'vRowIdxR');
  const vAlpha     = varying(float(),  'vAlphaR');
  const vTrail     = varying(float(),  'vTrailR');
  const vDepthDim  = varying(float(),  'vDepthDim');
  const vOutward   = varying(vec3(),   'vOutward');
  const vWorldPos  = varying(vec3(),   'vWorldPosR');
  const vBurst     = varying(float(),  'vBurst');
  const vBootFade  = varying(float(),  'vBootFade');
  const vDeathFade = varying(float(),  'vDeathFade');

  // ── MSDF sampling (closure over atlasTexture + uniforms) ──────────────
  const sampleGlyph = Fn(([faceUV, gIdx]) => {
    // Back-face U-flip: mirror U on the rear face of each billboard quad
    const su  = select(frontFacing, faceUV.x, float(1).sub(faceUV.x));
    const col = mod(gIdx, uAtlasGridW);
    const row = floor(gIdx.div(uAtlasGridW));
    const atlasUV = vec2(
      col.add(su).div(uAtlasGridW),
      row.add(float(1).sub(faceUV.y)).div(uAtlasGridH),
    );
    const s = texture(atlasTexture, atlasUV).rgb;
    return median3(s.r, s.g, s.b);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // VERTEX STAGE
  // ═══════════════════════════════════════════════════════════════════════
  const vertexNode = Fn(() => {
    // Default: clip to off-screen. Overwritten only when all cull tests pass.
    // WGSL vertex functions must always return the varyings struct — no early
    // return is possible, so culling is done by writing (2,2,2,1) clip coords.
    const clipPos = vec4(2, 2, 2, 1).toVar('clipPos');

    // Varying defaults written unconditionally (WGSL requires all varyings to
    // be assigned on every execution path before they are read in the fragment).
    vDeathFade.assign(1.0);
    vBurst.assign(0.0);
    vUvRain.assign(uv());
    vColIdx.assign(aColIdxAttr);
    vRowIdx.assign(aRowIdxAttr);
    vAlpha.assign(aColBAttr.z);
    vTrail.assign(aColBAttr.w);
    vDist.assign(0.0);
    vDepthDim.assign(0.0);
    vOutward.assign(vec3(0, 0, 1));
    vWorldPos.assign(vec3(0));

    // Unpack per-column attributes
    const aWX    = aColAAttr.x;
    const aWZ    = aColAAttr.y;
    const aSpeed = aColAAttr.z;
    const aSeed  = aColAAttr.w;
    const aYOff  = aColBAttr.x;
    const aScale = aColBAttr.y;
    const aAlpha = aColBAttr.z;
    const aTrail = aColBAttr.w;

    // ── Startup cascade — columns boot over 2.5 s ─────────────────────
    const bootDelay   = h2(vec2(aColIdxAttr.mul(0.31), 0.77)).mul(2.5);
    const bootFadeRaw = smoothstep(bootDelay, bootDelay.add(0.3), uTime);
    const bootFadeVal = mix(float(1), bootFadeRaw, uBootEnabled);
    vBootFade.assign(bootFadeVal);

    // Radial zone factor: 0 = inner (R_MIN=3.5), 1 = outer (R_MAX=8.0).
    // Derived from baked world XZ position (aWX, aWZ) — no extra attribute needed.
    // Shell constants (3.5, 4.5 = R_MAX−R_MIN) are hardcoded; clamp() ensures
    // t_zone stays in [0,1] gracefully when shellInner/shellOuter differ from defaults.
    const r_zone = sqrt(aColAAttr.x.mul(aColAAttr.x).add(aColAAttr.y.mul(aColAAttr.y)));
    const t_zone = r_zone.sub(float(3.5)).div(float(4.5)).clamp(0.0, 1.0);

    // Density cull — deterministic hash per column: fraction (1 - zonedDensity) of
    // columns stay at the off-screen default (clipPos = (2,2,2,1)) and skip all
    // placement work. Return() is intentionally avoided; WGSL vertex functions
    // cannot early-return — they must reach the final return statement.
    // uDensityInner/uDensityOuter radially bias the per-column cull threshold.
    // Option G: angular sector mask — world-fixed, operates on baked XZ column position.
    // uSectorStrength=0 (default) keeps sectorMask=1 so the feature is a no-op until enabled.
    const colAngle    = atan(aColAAttr.y, aColAAttr.x);               // atan2(wz, wx) → [−π, π]
    const TWO_PI      = float(Math.PI * 2);
    const rawDiff     = colAngle.sub(uSectorCenter);
    const wrapped     = fract(rawDiff.div(TWO_PI).add(0.5)).mul(TWO_PI).sub(Math.PI); // [−π, π]
    const sectorMask  = float(1).sub(
      uSectorStrength.mul(smoothstep(uSectorWidth.mul(0.85), uSectorWidth, abs(wrapped)))
    );
    // Option H: height fade — sine envelope zeroing density at vertical poles.
    // aColBAttr.x = aYOff, baked range [−WORLD_H/2, WORLD_H/2]; uWorldH matches build-time WORLD_H.
    const normY       = aColBAttr.x.div(uWorldH).add(0.5);            // [0, 1] bottom→top
    const heightMask  = mix(float(1), sin(normY.mul(Math.PI)), uHeightFade);
    const zonedDensity = uDensity
      .mul(mix(uDensityInner, uDensityOuter, t_zone))
      .mul(sectorMask)
      .mul(heightMask)
      .clamp(0.0, 1.0);
    If(h2(vec2(aColIdxAttr.mul(0.137).add(0.5), float(42.7))).lessThanEqual(zonedDensity), () => {

    If(bootFadeVal.greaterThanEqual(0.001), () => {

      // Per-glyph spacing — step > quad height to prevent overlap
      const spacingFactor = float(1.85).add(float(0.10).mul(
        h2(vec2(aColIdxAttr.mul(0.61), 0.29))
      ));
      const cellStep = uCellH.mul(aScale).mul(spacingFactor);

      // Per-glyph Y jitter
      const yJitter = h2(vec2(aColIdxAttr.mul(0.43), aRowIdxAttr.mul(0.89)))
        .mul(0.16).mul(cellStep);

      // Per-glyph alpha variation ±12 %
      const alphaJitter = float(1).add(
        h2(vec2(aColIdxAttr.mul(0.67), aRowIdxAttr.mul(0.31))).sub(0.5).mul(0.24)
      );
      const zoneBrightBias = mix(uZoneBrightInner, uZoneBrightOuter, t_zone);
      vAlpha.assign(aAlpha.mul(alphaJitter).mul(zoneBrightBias));

      // Static world-Y of this cell
      const cellY = aYOff.add(uWorldH.mul(0.5))
        .sub(aRowIdxAttr.mul(cellStep))
        .add(yJitter);

      // ── Column burst — 0.5 % of columns get a 4 s speed surge ───────
      const burstCycle  = float(4.0);
      const burstBucket = floor(uTime.div(burstCycle));
      const burstH      = h2(vec2(aColIdxAttr.mul(0.41), burstBucket.mul(0.19)));
      const burstActive = step(float(1).sub(uBurstProb), burstH);
      const burstPhase  = fract(uTime.div(burstCycle));
      const burstFrac   = smoothstep(0.0, 0.1, burstPhase)
        .mul(float(1).sub(smoothstep(0.25, 0.35, burstPhase)));
      // Per-column breathing: fv ∈ [0.1, 0.5] Hz, random phase — derived from aSeed.
      // Breath is additive (not multiplicative) so its ±0.15 amplitude is independent
      // of uSpeedMul — moving the speed slider doesn't amplify the oscillation.
      const breathFreq  = float(0.1).add(h2(vec2(aSeed.mul(13.7), float(0.1))).mul(0.4));
      const breathPhase = h2(vec2(aSeed.mul(7.3), float(0.5))).mul(6.2832);
      const breathAdd   = sin(uTime.mul(breathFreq).mul(6.2832).add(breathPhase)).mul(uBreathAmt.mul(0.15));
      const zoneSpeedBias = mix(uZoneSpeedInner, uZoneSpeedOuter, t_zone);
      const speedMul    = max(float(0.01), uSpeedMul.add(breathAdd))
        .mul(float(1).add(burstActive.mul(burstFrac).mul(2)))
        .mul(zoneSpeedBias);
      vBurst.assign(burstActive.mul(burstFrac));

      // ── Head sweep ──────────────────────────────────────────────────
      const cycleH    = uWorldH.add(uNRows.mul(cellStep));
      // Traveling wave: 3 crests sweep around the shell at ~42 s/revolution.
      // aWX = aColAAttr.x, aWZ = aColAAttr.y — angular position on XZ shell.
      const thetaWave  = atan(aWZ, aWX);                           // −π..π
      const wavePhase  = thetaWave.mul(3.0).add(uTime.mul(uWaveSpeed));
      const waveOffset = sin(wavePhase).mul(uWaveAmt.mul(4.0));

      const cyclePos  = mod(
        uTime.mul(aSpeed).mul(speedMul).add(aSeed.mul(cycleH)),
        cycleH
      );
      const cyclePhase = cyclePos.div(cycleH);

      // Death fade — smooth-out in the last 12 % of cycle before wrap
      const deathRamp = smoothstep(0.88, 1.0, cyclePhase);
      vDeathFade.assign(float(1).sub(deathRamp));

      // Per-column reverse: stable per-column hash decides direction.
      // uReverseChance = 0 → all fall down; 1 → all fall up.
      const revH  = h2(vec2(aColIdxAttr.mul(0.23), 0.69));
      const isRev = revH.greaterThanEqual(float(1).sub(uReverseChance));
      // Reverse columns invert cyclePos so head sweeps bottom→top.
      const revCyclePos = select(isRev, cycleH.sub(cyclePos), cyclePos);

      const headY = aYOff.add(uWorldH.mul(0.5)).sub(revCyclePos);
      // Signed trail distance: positive = behind head (in the trail).
      // Forward: trail is above head (cellY > headY). Reverse: below (headY > cellY).
      const rawDist = cellY.sub(headY).div(cellStep);
      const dist    = select(isRev, rawDist.negate(), rawDist);
      vDist.assign(dist);

      // Cull glyphs outside the visible trail window
      const maxVisible = min(float(4.42).div(aTrail), uNRows.mul(1.2));
      If(dist.greaterThanEqual(-0.5).and(dist.lessThanEqual(maxVisible)), () => {

        // ── 3D world-space placement ───────────────────────────────────
        // Columns converge toward a point 2 units behind origin on Z.
        // Each column has ±5° facing jitter for subtle parallax.
        const wz          = mix(aWZ, float(0), uFlatZ);
        // waveOffset displaces the rendered glyph position in world Y, not headY.
        // Keeping it out of headY means dist (trail gradient) is never affected,
        // so the wave cannot cause apparent fall-direction reversal.
        const colCenter   = vec3(aWX, cellY.add(waveOffset), wz).toVar();
        const toTarget    = vec2(aWX.negate(), float(-2).sub(wz));
        const targetAngle = atan(toTarget.x, toTarget.y);
        // Camera-facing angle: project camera→column direction onto XZ plane
        const toCamXZ      = vec2(cameraPosition.x.sub(aWX), cameraPosition.z.sub(wz));
        const camAngle     = atan(toCamXZ.x, toCamXZ.y);
        // Clamp column yaw to within ±uMaxYaw of the camera angle.
        // Angular delta is normalised to [−π, π] to handle wrap-around correctly.
        const TWO_PI     = float(Math.PI * 2);
        const rawDelta   = targetAngle.sub(camAngle);
        const delta      = fract(rawDelta.div(TWO_PI).add(0.5)).mul(TWO_PI).sub(Math.PI);
        const blendedAngle = camAngle.add(clamp(delta, uMaxYaw.negate(), uMaxYaw));
        // Forward-facing mode: ignore target/camera blend and face +Z (angle=0).
        // Used for curtain topology so all columns present a flat wall to the viewer.
        const effectiveAngle = select(uForwardFacing.greaterThan(0.5), float(0), blendedAngle);
        const facingAngle  = effectiveAngle.add(
          h2(vec2(aColIdxAttr.mul(0.73), 0.51)).sub(0.5).mul(uFacingJitter)
        );
        const outward = vec3(sin(facingAngle), 0.0, cos(facingAngle));
        const right   = vec3(outward.z, 0.0, outward.x.negate()); // cross(Y, outward)
        vOutward.assign(outward);

        // Wobble-in: full amplitude at head (dist=0), decays exponentially into trail
        const sway = sin(uTime.mul(0.4).add(aSeed.mul(6.2832)))
          .mul(uSwayAmt)
          .mul(exp(dist.negate().mul(uSwayDecay)));
        colCenter.addAssign(right.mul(sway));

        // Per-column Z-rotation ±5°
        const rotAngle = h2(vec2(aSeed, 42.0)).sub(0.5).mul(uZRotRange);
        const cosR     = cos(rotAngle);
        const sinR     = sin(rotAngle);
        const rotRight = right.mul(cosR).add(vec3(0, 1, 0).mul(sinR));
        const rotUp    = vec3(0, 1, 0).mul(cosR).sub(right.mul(sinR));

        // Drip stretch — Y-scale at head for mercury-drip effect
        const scaleJitter = float(1).add(
          h2(vec2(aColIdxAttr.mul(0.53), aRowIdxAttr.mul(0.17))).sub(0.5).mul(0.20)
        );
        const dripStretch = float(1).add(
          uDripAmt.mul(exp(max(dist, 0.0).negate().mul(1.5)))
        );
        const sX = aScale.mul(scaleJitter).mul(2.2);
        const sY = aScale.mul(scaleJitter).mul(2.2).mul(dripStretch);

        const worldPos = colCenter
          .add(rotRight.mul(positionGeometry.x).mul(uCellW).mul(sX))
          .add(rotUp.mul(positionGeometry.y).mul(uCellH).mul(sY));
        vWorldPos.assign(worldPos);

        // Fade glyphs close to camera — prevents blinding under a column
        const viewPos4  = cameraViewMatrix.mul(vec4(worldPos, 1.0));
        const camDist3D = length(viewPos4.xyz);

        If(camDist3D.greaterThanEqual(1.5), () => {
          vDepthDim.assign(smoothstep(1.5, 3.5, camDist3D));
          clipPos.assign(cameraProjectionMatrix.mul(viewPos4));
        });

      }); // trail window cull
    }); // boot cull

    }); // density cull

    return clipPos;
  })();

  // ═══════════════════════════════════════════════════════════════════════
  // FRAGMENT STAGE
  // ═══════════════════════════════════════════════════════════════════════
  const outputNode = Fn(() => {
    // ── Per-column trail decay ─────────────────────────────────────────
    const d        = max(vDist, 0.0);
    const halfDist = float(0.6931).div(vTrail); // ln(2)/trail = 50 % point
    const accel    = select(d.greaterThan(halfDist), float(1.5), float(1.0));
    const trail    = exp(d.negate().mul(vTrail).mul(accel));
    If(trail.lessThan(0.012), () => { Discard(); });

    // View-space vectors — used by POM tangent frame below
    const toFrag   = vWorldPos.sub(cameraPosition);
    const fragDist = length(toFrag);
    const viewDir  = toFrag.div(fragDist);

    // Early discard if max possible alpha is sub-visible
    const maxAlpha = pow(trail.mul(vAlpha).mul(vDepthDim), 1.3)
      .mul(uGlobalAlpha).mul(vBootFade);
    If(maxAlpha.lessThan(0.015), () => { Discard(); });

    // ── Glyph selection ───────────────────────────────────────────────
    const cellId      = vec2(floor(vColIdx.add(0.5)), floor(vRowIdx.add(0.5)));
    const cellPhase   = h2(cellId.mul(0.37));
    const stability   = h2(cellId.mul(0.91));
    const holdRand   = float(0.45).add(h2(cellId.mul(0.29)).mul(7.15));
    const isHead     = vDist.lessThan(1.0);
    const isNearHead = vDist.lessThan(4.0);
    const nonHeadHold = select(isNearHead,
      float(2.0).add(holdRand.mul(0.3)),       // near-head: ~0.5 Hz ± jitter
      float(10.0).add(holdRand.mul(2.0))       // mid + deep trail: ~0.1 Hz ± jitter
    ).mul(uHoldMult);
    const holdSec    = select(isHead,
      float(0.067),                            // head: ~15 Hz — deliberately not scaled by uHoldMult
      nonHeadHold
    );

    // ── Message reveal — scramble rate modulation ──────────────────────
    // uMsgRevealProgress == 0 → settledHold == holdSec (no effect).
    // uMsgTex has screenUV baked in; .r gives the mask value at this fragment's screen pos.
    const msgMask      = uMsgTex.r;
    const msgWavePast  = step(screenUV.x, uMsgWaveX);            // 1 where wave has passed
    const msgActive    = msgMask.mul(msgWavePast).mul(uMsgRevealProgress);
    const msgHoldSec   = mix(holdSec, float(0.05), msgActive);   // boost scramble rate ~20×
    const waveGap      = clamp(uMsgWaveX.sub(screenUV.x).mul(6.0), 0.0, 1.0);
    const settledHold  = mix(msgHoldSec, holdSec, waveGap.mul(uMsgRevealProgress));

    const burstOffset = select(
      vBurst.greaterThan(0.5), floor(uTime.mul(uBurstGlyphRate)), float(0)
    );
    const changeTick  = floor(
      cellPhase.mul(settledHold).add(uTime).div(settledHold)
    ).add(burstOffset);
    // Weighted vs uniform glyph selection — uWeightedGlyphs blends LUT → uniform.
    // A per-cell coin-flip hash selects LUT or uniform for each cell independently.
    const baseHash  = h2(cellId.mul(0.47).add(0.5));
    const baseRaw   = floor(baseHash.mul(uGlyphCount));
    const baseLUT   = texture(uGlyphWeightLUT, vec2(baseHash, 0.5)).r.mul(255.0).floor();
    const baseGlyph = select(h2(cellId.mul(0.53).add(0.1)).lessThan(uWeightedGlyphs), baseLUT, baseRaw);

    const mutHash  = h2(cellId.mul(0.37).add(changeTick.mul(vec2(0.11, 0.07))));
    const mutRaw   = floor(mutHash.mul(uGlyphCount));
    const mutLUT   = texture(uGlyphWeightLUT, vec2(mutHash, 0.5)).r.mul(255.0).floor();
    const mutGlyph = select(h2(cellId.mul(0.61).add(0.3)).lessThan(uWeightedGlyphs), mutLUT, mutRaw);
    // Burst columns override static: during a burst the whole column is "active".
    const isDeepTrail = d.greaterThanEqual(halfDist).and(vBurst.lessThan(0.5));
    const glyphIdx    = select(
      isDeepTrail.or(stability.lessThan(uStability)),
      baseGlyph,
      mutGlyph
    );

    // Film grain
    const sampleX = select(frontFacing, vUvRain.x, float(1).sub(vUvRain.x));
    const grain   = h2(vec2(
      sampleX.mul(47.3).add(vUvRain.y.mul(31.7)).add(vColIdx.mul(0.53)),
      uTime.mul(7.3).add(vRowIdx.mul(0.19))
    )).sub(0.5).mul(uGrainAmt);

    // Per-column colour blend — mix uColor → uColor2 using a per-column hash
    const hueShift    = h2(vec2(cellId.x.mul(0.17), 0.0));   // [0, 1] per column
    const blendT      = hueShift.mul(uHueRange);              // scaled by spread [0, 1]
    const tintedColor = mix(uColor, uColor2, blendT);

    // Color: head burns white, trail has two-stage ramp down to dark-green floor
    const headFrac      = float(1).sub(smoothstep(0.0, 0.8, vDist));
    const normDist      = d.div(halfDist);                   // 0 = head, 1 = 50 % fade point
    const deepTrailFrac = smoothstep(0.5, 1.0, normDist);   // ramps in at 50–100 % of halfDist
    const deepTrailCol  = tintedColor.mul(0.18);             // ≈ #002D0A relative to uColor
    const trailCol      = mix(tintedColor.mul(1.6), deepTrailCol, deepTrailFrac);
    const col2 = mix(
      trailCol,
      tintedColor.mul(3.0).add(vec3(0.3)),
      headFrac
    ).add(grain).toVar('col2');

    // Head drip — leading 2-3 glyphs distinctly brighter
    const drip = exp(vDist.negate().mul(0.8));
    col2.addAssign(col2.mul(drip.mul(0.5)));

    // Glyph flash — ~0.8 % of cells flare white
    const flashBucket    = floor(uTime.mul(30.0));
    const flashH         = h2(cellId.mul(0.71).add(
      vec2(flashBucket.mul(0.13), flashBucket.mul(0.07))
    ));
    const flashAge       = fract(uTime.mul(30.0));
    const flashIntensity = float(1).sub(flashAge.mul(flashAge)).mul(step(flashH, 0.008));
    col2.assign(mix(col2, vec3(2.4), flashIntensity));

    // Atmospheric depth tint — distant columns shift toward cyan
    const depthTint = smoothstep(3.0, 8.0, length(vWorldPos));
    col2.assign(mix(col2, col2.mul(vec3(0.6, 0.85, 1.1)), depthTint.mul(uDepthTintAmt)));

    // ── Message reveal — brightness boost ─────────────────────────────
    // msgActive is 0 when uMsgRevealProgress == 0, so no branch needed.
    col2.mulAssign(float(1.0).add(msgActive.mul(uMsgBoost.sub(1.0))));

    // ── Panel tangent frame ────────────────────────────────────────────
    const panelRight = vec3(vOutward.z, 0.0, vOutward.x.negate());

    // View ray in tangent space (viewDir re-used from globe occlusion above)
    const tangentV = vec3(
      dot(viewDir, panelRight),
      viewDir.y,
      dot(viewDir, vOutward),
    );

    // Skip POM when view is edge-on or glyph is far away
    const pomActive = step(0.1, abs(tangentV.z)).mul(step(fragDist, 6.0));
    const safeTZ    = sign(tangentV.z).mul(max(abs(tangentV.z), 0.1));

    // Distance-adaptive POM step count
    const pomLod   = clamp(float(1).sub(fragDist.mul(0.1)), 0.3, 1.0);
    const numSteps = int(max(uPomSteps.mul(pomLod), 3.0));
    const stepSize = float(1).div(numSteps.toFloat());
    const stepFace = tangentV.xy.negate().div(safeTZ).mul(uDepth).mul(stepSize);

    const currentFace = vUvRain.toVar('cfUV');
    const prevFace    = vUvRain.toVar('pfUV');
    const currentH    = float(1).toVar('cH');
    const prevH       = float(1).toVar('pH');

    // Ray-march into the SDF surface
    Loop({ start: int(0), end: int(8), type: 'int' }, ({ i }) => {
      If(i.greaterThanEqual(numSteps), () => { Break(); });
      prevFace.assign(currentFace);
      prevH.assign(currentH);
      currentFace.assign(clamp(currentFace.add(stepFace.mul(pomActive)), 0.005, 0.995));
      currentH.subAssign(stepSize);
      If(sampleGlyph(currentFace, glyphIdx).greaterThanEqual(currentH), () => { Break(); });
    });

    // Binary refinement — 3 bisection steps for sub-step accuracy
    const loFace = prevFace.toVar('loF');
    const hiFace = currentFace.toVar('hiF');
    const loH    = prevH.toVar('loH');
    const hiH    = currentH.toVar('hiH');
    Loop(3, () => {
      const midFace = loFace.add(hiFace).mul(0.5).toVar('midF');
      const midH    = loH.add(hiH).mul(0.5).toVar('midH');
      const s       = sampleGlyph(midFace, glyphIdx);
      If(s.greaterThanEqual(midH), () => {
        hiFace.assign(midFace);
        hiH.assign(midH);
      }).Else(() => {
        loFace.assign(midFace);
        loH.assign(midH);
      });
    });

    const finalFace = mix(vUvRain, loFace.add(hiFace).mul(0.5), pomActive);

    // MSDF anti-aliased mask at POM-displaced position
    const sdfG = sampleGlyph(finalFace, glyphIdx);
    const fw   = abs(dFdx(sdfG)).add(abs(dFdy(sdfG))).mul(0.7);
    const mask = smoothstep(float(0.5).sub(fw), float(0.5).add(fw), sdfG);
    If(mask.lessThan(0.01), () => { Discard(); });

    // ── Per-glyph chromatic aberration at head ─────────────────────────
    // Additive fringe: sample R/B at shifted UVs, add the divergence from the
    // center mask as new colored light. This is visible for any glyph color,
    // including pure green where the old ratio approach was a no-op (0 * ratio = 0).
    const aberration = exp(max(vDist, 0.0).negate().mul(1.5)).mul(uGlyphChroma);
    const chromaOff  = aberration.mul(0.03);
    const rUV    = clamp(vec2(finalFace.x.add(chromaOff), finalFace.y), 0.005, 0.995);
    const bUV    = clamp(vec2(finalFace.x.sub(chromaOff), finalFace.y), 0.005, 0.995);
    const rMask  = smoothstep(float(0.5).sub(fw), float(0.5).add(fw), sampleGlyph(rUV, glyphIdx));
    const bMask  = smoothstep(float(0.5).sub(fw), float(0.5).add(fw), sampleGlyph(bUV, glyphIdx));
    const luma   = col2.dot(vec3(0.333, 0.334, 0.333));
    col2.assign(vec3(
      col2.x.add(rMask.sub(mask).mul(luma)),
      col2.y,
      col2.z.add(bMask.sub(mask).mul(luma)),
    ));

    // Edge emission glow — laser-etched holographic corona
    const edgeDist = abs(sdfG.sub(0.5));
    const edgeGlow = exp(edgeDist.negate().mul(18.0)).mul(uEdgeGlow);
    col2.addAssign(uColor.mul(edgeGlow).mul(trail));

    // ── Normals + Lighting ─────────────────────────────────────────────
    const fakeN = vec3(0, 0, 1).toVar('fakeN');
    If(trail.greaterThan(0.25), () => {
      const eps = float(0.04);
      const mL  = sampleGlyph(finalFace.add(vec2(eps.negate(), 0)), glyphIdx);
      const mR  = sampleGlyph(finalFace.add(vec2(eps,           0)), glyphIdx);
      const mD  = sampleGlyph(finalFace.add(vec2(0, eps.negate())), glyphIdx);
      const mU  = sampleGlyph(finalFace.add(vec2(0, eps          )), glyphIdx);
      const Kx  = mR.sub(mL).toVar('Kx');
      const Ky  = mU.sub(mD);
      Kx.mulAssign(select(frontFacing, float(1), float(-1)));
      fakeN.assign(normalize(vec3(
        Kx.negate().mul(uNormalStrength),
        Ky.negate().mul(uNormalStrength),
        1.0,
      )));
    });

    const localLight = normalize(vec3(
      dot(uLightDir, panelRight),
      uLightDir.y,
      dot(uLightDir, vOutward),
    ));
    const diffuse = max(0.0, dot(fakeN, localLight));
    const spec    = pow(max(0.0, dot(fakeN, normalize(localLight.add(vec3(0, 0, 1))))), 24.0);
    col2.assign(
      col2.mul(float(0.65).add(float(0.35).mul(diffuse)))
        .add(tintedColor.mul(spec).mul(0.8))
    );

    // Globe proximity pulse — soft radial brightening near the inner sphere surface (R ≈ 3.5)
    // Gated by uGlobeInteract: 0 = off, 1 = on.
    const globeRxz  = length(vWorldPos.xz);
    const nearInner = exp(globeRxz.sub(float(3.5)).abs().negate().mul(0.45));
    const pulseFrac = sin(uTime.mul(2.5).add(globeRxz.mul(1.0))).mul(0.5).add(0.5);
    col2.addAssign(uColor.mul(nearInner.mul(pulseFrac).mul(0.22).mul(uGlobeInteract)));

    // ── Final alpha ────────────────────────────────────────────────────
    const rawBright = trail.mul(mask).mul(vAlpha).mul(vDepthDim);
    const contrast  = pow(rawBright, 1.3);
    const alpha     = contrast.mul(uGlobalAlpha).mul(vBootFade).mul(vDeathFade);
    If(alpha.lessThan(0.015), () => { Discard(); });

    // Pre-multiplied alpha — additive compositing on the canvas
    return vec4(col2.mul(alpha).mul(uBrightness), alpha);
  })();

  // ── Material ──────────────────────────────────────────────────────────
  const material = new THREE.MeshBasicNodeMaterial({
    transparent:        true,
    depthWrite:         false,
    // Additive RGB, max-equation alpha — order-independent, no z-sort artifacts
    blending:           THREE.CustomBlending,
    blendEquation:      THREE.AddEquation,
    blendSrc:           THREE.OneFactor,
    blendDst:           THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha:      THREE.OneFactor,
    blendDstAlpha:      THREE.OneFactor,
    side:               THREE.DoubleSide,
  });
  material.toneMapped  = false;
  material.vertexNode  = vertexNode;
  material.outputNode  = outputNode;

  return material;
}
