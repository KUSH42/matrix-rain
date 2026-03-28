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
 * @param {THREE.DataTexture}   [lutTexture]     256×1 glyph weight LUT; built as uniform identity if null
 * @returns {object}  all mutable TSL uniform nodes
 */
export function makeUniforms(glyphCount = 56, gridW = 8, gridH = 8, lutTexture = null) {
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
    uMsgRevealProgress:  uniform(0.0),                   // overall effect opacity 0→1→0
    uMsgBoost:           uniform(2.0),                   // brightness multiplier for locked head glyphs
    uMsgRevealY:         uniform(0.0),                   // world Y of locked head zone
    uMsgRevealBand:      uniform(0.35),                  // half-height of suppression band (world units)
    uMsgRevealActive:    uniform(0.0),                   // 1 = suppress non-locked glyphs in band
    uMsgXMin:            uniform(0.0),                   // screen UV left bound of message text
    uMsgXMax:            uniform(1.0),                   // screen UV right bound of message text
    uMsgBandSuppress:    uniform(0.0),                   // user toggle: 1 = enable band suppression
    uGlyphWeightLUT:    texture(lutTexture),             // 256×1 inverse-CDF glyph weight LUT
    uBrightness:     uniform(1.0),   // output brightness multiplier — range [0.2, 2.0]
    uBreathAmt:      uniform(1.0),   // speed-oscillation amplitude scale — 0 = off, 1 = ±15%
    uWaveSpeed:      uniform(0.15),  // wave crest angular speed in rad/s (hardcoded was 0.15)
    uWaveAmt:        uniform(1.0),   // wave height amplitude scale — 0 = off, 1 = ±4 world units
    uWaveCrests:     uniform(3.0),   // number of wave crests around the shell (integer 1–12)
    uEntrainAmt:     uniform(0.15),  // speed-entrainment wave amplitude — 0 = off, range 0–0.8
    uEntrainSpeed:   uniform(0.25),  // entrainment wave angular speed rad/s
    uEntrainCrests:  uniform(3.0),   // entrainment crests around shell (integer 1–12)
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
    uSpawnWaveFront: uniform(2.0),   // wave-front gate: columns with aSpawnTheta < front are active; 2.0 = all
    // Glyph FX controls
    uDripAmt:        uniform(0.35),  // drip-stretch Y-scale amplitude  0–0.8
    uEdgeGlow:       uniform(0.4),   // edge-emission corona intensity   0–1.5
    uZRotRange:      uniform(0.1745),// per-column Z-rotation max angle  0–0.524 rad (0–30°)
    uGrainAmt:       uniform(0.07),  // film-grain strength              0–0.25
    uDepthTintAmt:   uniform(0.4),   // atmospheric depth-tint blend     0–1
    uBootEnabled:    uniform(1.0),   // startup cascade on/off           0 or 1
    uBootStart:      uniform(0.0),   // uTime value when cascade was last triggered
    uStability:      uniform(0.30),  // fraction of stable cells         0–1
    uHoldMult:       uniform(1.0),   // hold-cycle duration multiplier   0.1–5
    uBurstGlyphRate: uniform(12.0),  // glyph-change rate during burst   1–30 Hz
    uHueRange:       uniform(0.5),   // per-column colour blend spread 0–1 (0=all uColor, 1=full mix)
    uBurstProb:      uniform(0.005), // fraction of columns that burst per 4 s cycle
    uContagionStrength: uniform(0.35), // fraction of cluster members joining a cluster burst 0–1
    uClusterBiasAmt: uniform(0.40),  // per-cluster brightness bias magnitude 0–1
    uSquadCoherence: uniform(0.3),   // 0 = full squad phase lock, 1 = individual random
    uScanSyncAmt:    uniform(0.0),   // blend toward synchronised cyclePos [0=off, 1=full sync]
    uScanPhase:      uniform(0.0),   // shared cyclePos value driven by JS [0 → cycleH]
    uAtlasMTSDF:     uniform(1.0),   // 1 = MTSDF atlas (new); 0 = legacy single-channel (matrixcode)
    uColumnOffset:   uniform(new THREE.Vector2(0, 0)), // XZ world offset applied to all columns (camera follow)
    // End-of-life effects
    uEolFlash:       uniform(0.6),   // terminal flash intensity  0–2   (0 = off)
    uEolFreezeStart: uniform(0.80),  // cyclePhase at which head glyph freezes  0–1 (1 = off)
    uEolFadeStart:   uniform(0.88),  // cyclePhase at which death fade begins   0.5–1
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
    uMsgBoost, uMsgRevealY, uMsgRevealBand, uMsgRevealActive, uMsgXMin, uMsgXMax, uMsgBandSuppress,
    uGlyphWeightLUT,
    uBrightness, uBreathAmt, uWaveSpeed, uWaveAmt, uWaveCrests, uEntrainAmt, uEntrainSpeed, uEntrainCrests, uWeightedGlyphs, uReverseChance,
    uDensity,
    uZoneSpeedInner, uZoneSpeedOuter, uZoneBrightInner, uZoneBrightOuter,
    uDensityInner, uDensityOuter,
    uSectorCenter, uSectorWidth, uSectorStrength, uHeightFade, uSpawnWaveFront,
    uDripAmt, uEdgeGlow, uZRotRange, uGrainAmt, uDepthTintAmt,
    uBootEnabled, uBootStart, uStability, uHoldMult, uBurstGlyphRate,
    uColor2, uHueRange, uBurstProb,
    uContagionStrength,
    uClusterBiasAmt, uSquadCoherence,
    uScanSyncAmt, uScanPhase,
    uAtlasMTSDF,
    uColumnOffset,
    uEolFlash, uEolFreezeStart, uEolFadeStart,
  } = uniforms;

  // ── Per-instance buffer attributes ────────────────────────────────────
  const aColIdxAttr      = attribute('aColIdx',      'float');
  const aRowIdxAttr      = attribute('aRowIdx',      'float');
  const aColAAttr        = attribute('aColA',        'vec4');  // wx, wz, speed, seed
  const aColBAttr        = attribute('aColB',        'vec4');  // yOff, scale, alpha, trail
  const aClusterBiasAttr      = attribute('aClusterBias',      'float'); // per-cluster bias [-1, 1]
  const aClusterBurstSeedAttr = attribute('aClusterBurstSeed', 'float'); // per-cluster burst phase offset [0, 1]
  const aSquadPhaseAttr       = attribute('aSquadPhase',       'float'); // shared cyclePos phase seed within squad
  const aFrustumVisAttr       = attribute('aFrustumVis',       'float'); // 1 = visible in frustum, 0 = culled
  const aSpawnThetaAttr       = attribute('aSpawnTheta',       'float'); // normalised angular position [0, 1] for spawn wave

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
  const vDeathFade  = varying(float(),  'vDeathFade');
  const vColCenterX  = varying(float(),  'vColCenterX'); // baked world X of column centre
  const vCellWorldY  = varying(float(),  'vCellWorldY'); // world Y of this cell (for Y-band suppression)
  const vLockState   = varying(vec4(),   'vLockState');  // (lockY, lockGlyph, lockTime, spawnActive)
  const vCyclePhase  = varying(float(),  'vCyclePhase'); // forward cyclePhase [0, 1] passed to fragment

  // ── MTSDF sampling (closure over atlasTexture + uniforms) ─────────────
  // blendSDF: 0 = pure MSDF (accurate corners, large scale / CRT),
  //           1 = pure true SDF (alpha ch, stable at tiny scale / rain).
  // uAtlasMTSDF: 0 = legacy single-channel atlas (matrixcode), 1 = MTSDF atlas.
  const sampleGlyph = Fn(([faceUV, gIdx, blendSDF]) => {
    // Back-face U-flip: mirror U on the rear face of each billboard quad
    const su  = select(frontFacing, faceUV.x, float(1).sub(faceUV.x));
    const col = mod(gIdx, uAtlasGridW);
    const row = floor(gIdx.div(uAtlasGridW));
    const atlasUV = vec2(
      col.add(su).div(uAtlasGridW),
      row.add(float(1).sub(faceUV.y)).div(uAtlasGridH),
    );
    const s    = texture(atlasTexture, atlasUV);
    const msdf = median3(s.r, s.g, s.b);
    // mix(msdf, mix(msdf, s.a, blendSDF), uAtlasMTSDF):
    //   uAtlasMTSDF=0 → msdf (legacy bypass)
    //   uAtlasMTSDF=1 → mix(msdf, s.a, blendSDF) (MTSDF blend)
    return mix(msdf, mix(msdf, s.a, blendSDF), uAtlasMTSDF);
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
    vColCenterX.assign(0.0);
    vLockState.assign(vec4(float(-9999), float(-1), float(0), float(0)));
    vCyclePhase.assign(0.0);

    // Unpack per-column attributes — apply camera-follow offset to XZ world position
    const aWX    = aColAAttr.x.add(uColumnOffset.x);
    const aWZ    = aColAAttr.y.add(uColumnOffset.y);
    const aSpeed = aColAAttr.z;
    const aSeed  = aColAAttr.w;
    const aYOff  = aColBAttr.x;
    const aScale = aColBAttr.y;
    const aAlpha = aColBAttr.z;
    const aTrail = aColBAttr.w;

    // ── Startup cascade — columns boot over 2.5 s ─────────────────────
    const bootDelay   = h2(vec2(aColIdxAttr.mul(0.31), 0.77)).mul(2.5);
    const bootElapsed = uTime.sub(uBootStart);
    const bootFadeRaw = smoothstep(bootDelay, bootDelay.add(0.3), bootElapsed);
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
    const densityPasses = h2(vec2(aColIdxAttr.mul(0.137).add(0.5), float(42.7))).lessThanEqual(zonedDensity);

    // ── Lock state — read before density cull so bypass logic is always available ──
    const aLockStateAttr = attribute('aLockState', 'vec4');
    const isLocked      = aLockStateAttr.z.greaterThan(float(0.0));
    const isSpawnActive = aLockStateAttr.w.greaterThan(float(0.5));
    // Write varying unconditionally so fragment always has a valid value
    vLockState.assign(aLockStateAttr);

    // Spawn wave gate — columns with aSpawnTheta >= uSpawnWaveFront are suppressed.
    // isLocked and isSpawnActive columns (message reveal, reserves) bypass this gate.
    const spawnGatePasses = aSpawnThetaAttr.lessThan(uSpawnWaveFront);

    // Bypass density+frustum cull for locked columns and spawn-below columns
    If(densityPasses.and(aFrustumVisAttr.greaterThan(float(0.5))).and(spawnGatePasses).or(isLocked).or(isSpawnActive), () => {

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
      const zoneBrightBias  = mix(uZoneBrightInner, uZoneBrightOuter, t_zone);
      const clusterAlphaMul = float(1.0).add(aClusterBiasAttr.mul(uClusterBiasAmt));
      vAlpha.assign(aAlpha.mul(alphaJitter).mul(zoneBrightBias).mul(clusterAlphaMul));

      // Static world-Y of this cell
      const cellY = aYOff.add(uWorldH.mul(0.5))
        .sub(aRowIdxAttr.mul(cellStep))
        .add(yJitter);

      // Speed entrainment wave — computed before speedMul to avoid a forward reference.
      // Use aSpawnTheta ([0,1], baked per-column) rather than atan(aWZ,aWX) so that the
      // wave sweeps correctly across all topologies:
      //   shell/ring      → genuine azimuth/2π  (rotating band around sphere/ring)
      //   curtain         → X fraction [0,1]    (left-to-right sweep)
      //   rectangle       → X fraction [0,1]    (left-to-right sweep)
      // atan(wz,wx) was degenerate for curtain (wz=0 → collapses to ±π/2) and
      // rectangle (wz random → spatially incoherent).
      const thetaEntrain  = aSpawnThetaAttr.mul(Math.PI * 2).sub(Math.PI);  // [0,1] → [−π,π]
      const entrainWave   = sin(
        thetaEntrain.mul(uEntrainCrests).add(uTime.mul(uEntrainSpeed))
      ).mul(uEntrainAmt);

      // ── Column burst — 0.5 % of columns get a 4 s speed surge ───────
      const burstCycle  = float(4.0);
      const burstBucket = floor(uTime.div(burstCycle));
      const burstH      = h2(vec2(aColIdxAttr.mul(0.41), burstBucket.mul(0.19)));
      const burstIndiv  = step(float(1).sub(uBurstProb), burstH);
      // Cluster sync burst: all columns in a cluster fire when its periodic window is open.
      // This is probabilistic cluster-simultaneous firing, not true spatial contagion.
      const clusterBurstPhase = fract(uTime.div(burstCycle).add(aClusterBurstSeedAttr));
      const clusterIsBursting = step(clusterBurstPhase, float(0.08));
      const colContagionRand  = h2(vec2(aColIdxAttr.mul(0.53), float(0.13)));
      const contagionBurst    = clusterIsBursting.mul(step(colContagionRand, uContagionStrength));
      const burstActive       = burstIndiv.add(contagionBurst).clamp(0.0, 1.0);
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
        .mul(zoneSpeedBias)
        .mul(float(1).add(entrainWave));
      vBurst.assign(burstActive.mul(burstFrac));

      // ── Head sweep ──────────────────────────────────────────────────
      const cycleH    = uWorldH.add(uNRows.mul(cellStep));
      // Traveling wave: 3 crests sweep around the shell at ~42 s/revolution.
      // Use aSpawnTheta ([0,1]) for topology-correct azimuth — same fix as entrainWave.
      const thetaWave  = aSpawnThetaAttr.mul(Math.PI * 2).sub(Math.PI);  // [0,1] → [−π,π]
      const wavePhase  = thetaWave.mul(uWaveCrests).add(uTime.mul(uWaveSpeed));
      const waveOffset = sin(wavePhase).mul(uWaveAmt.mul(4.0));

      // Cluster speed bias — applied here so setClusterBias() takes effect without a rebuild.
      // uClusterBiasAmt ∈ [0, 1]; aClusterBias ∈ [−1, 1] → speed multiplier ∈ [0.6, 1.4] at bias=0.40.
      const effectiveSpeed = aSpeed.mul(float(1.0).add(aClusterBiasAttr.mul(uClusterBiasAmt)));

      // Squad phase coherence: blend between squad-shared phase (0) and individual random (1)
      const phaseSeed = mix(aSquadPhaseAttr, aSeed, uSquadCoherence);
      const naturalCyclePos = mod(
        uTime.mul(effectiveSpeed).mul(speedMul).add(phaseSeed.mul(cycleH)),
        cycleH
      );
      // Scanline sync: blend natural per-column phase toward a shared phase.
      // uScanSyncAmt=0 → identity (vanilla rain); uScanSyncAmt=1 → all heads at same Y.
      const cyclePos = mix(
        naturalCyclePos,
        mod(uScanPhase, cycleH),
        uScanSyncAmt
      ).toVar('cyclePos');
      const cyclePhase = cyclePos.div(cycleH);
      vCyclePhase.assign(cyclePhase);

      // Death fade — smooth-out in the last portion of cycle before wrap (tunable via uEolFadeStart)
      const deathRamp = smoothstep(uEolFadeStart, float(1.0), cyclePhase);
      vDeathFade.assign(float(1).sub(deathRamp));

      // Per-column reverse: stable per-column hash decides direction.
      // uReverseChance = 0 → all fall down; 1 → all fall up.
      const revH  = h2(vec2(aColIdxAttr.mul(0.23), 0.69));
      const isRev = revH.greaterThanEqual(float(1).sub(uReverseChance));
      // Reverse columns invert cyclePos so head sweeps bottom→top.
      const revCyclePos = select(isRev, cycleH.sub(cyclePos), cyclePos);

      const headY = aYOff.add(uWorldH.mul(0.5)).sub(revCyclePos).toVar('headY');

      // ── Lock-freeze: pin headY for locked columns ────────────────────
      headY.assign(select(isLocked, aLockStateAttr.x, headY));
      // Suppress death-fade so the frozen glyph never vanishes mid-hold
      vDeathFade.assign(select(isLocked, float(1.0), vDeathFade));

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
        // Lock-head cells snap to lockY so all message chars align on the same Y.
        const isVertLockHead = isLocked
          .and(dist.greaterThanEqual(float(-0.5)))
          .and(dist.lessThan(float(0.5)));
        const lockedCellY = select(isVertLockHead, aLockStateAttr.x, cellY.add(waveOffset));
        vCellWorldY.assign(lockedCellY);
        const colCenter   = vec3(aWX, lockedCellY, wz).toVar();
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
        // Suppressed for locked head cells so message chars stay perfectly still.
        const sway = select(isVertLockHead, float(0),
          sin(uTime.mul(0.4).add(aSeed.mul(6.2832)))
            .mul(uSwayAmt)
            .mul(exp(dist.negate().mul(uSwayDecay)))
        );
        colCenter.addAssign(right.mul(sway));

        // Per-column Z-rotation ±5°
        const rotAngle = h2(vec2(aSeed, 42.0)).sub(0.5).mul(uZRotRange);
        const cosR     = cos(rotAngle);
        const sinR     = sin(rotAngle);
        const rotRight = right.mul(cosR).add(vec3(0, 1, 0).mul(sinR));
        const rotUp    = vec3(0, 1, 0).mul(cosR).sub(right.mul(sinR));

        // Drip stretch — Y-scale at head for mercury-drip effect
        // Disabled for locked heads so message chars are uniformly sized.
        const scaleJitter = float(1).add(
          h2(vec2(aColIdxAttr.mul(0.53), aRowIdxAttr.mul(0.17))).sub(0.5).mul(0.20)
        );
        const dripStretch = select(isVertLockHead, float(1),
          float(1).add(uDripAmt.mul(exp(max(dist, 0.0).negate().mul(1.5))))
        );
        const sX = aScale.mul(scaleJitter).mul(2.2);
        const sY = aScale.mul(scaleJitter).mul(2.2).mul(dripStretch);

        const worldPos = colCenter
          .add(rotRight.mul(positionGeometry.x).mul(uCellW).mul(sX))
          .add(rotUp.mul(positionGeometry.y).mul(uCellH).mul(sY));
        vWorldPos.assign(worldPos);
        vColCenterX.assign(aColAAttr.x.add(uColumnOffset.x));

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

    // (Old cascade wave machinery removed — replaced by per-column lock state)

    // During burst, each cell independently cycles at uBurstGlyphRate Hz by replacing
    // holdSec with 1/uBurstGlyphRate. This preserves per-cell phase staggering (via
    // cellPhase) so cells don't all flash simultaneously — they cycle independently.
    // The old approach (additive global floor(t*rate)) was a synchronized whole-column
    // strobe because the same counter value applied to every cell at the same instant.
    const isBursting       = vBurst.greaterThan(0.5);
    const burstHoldSec     = float(1.0).div(uBurstGlyphRate);
    const effectiveHoldSec = select(isBursting, burstHoldSec, holdSec);
    // Glyph freeze — during EOL window the head glyph locks to a cycle-stable tick.
    // select() avoids non-uniform control flow; both branches evaluate but no divergence cost.
    const isFreezeActive = vCyclePhase.greaterThan(uEolFreezeStart);
    const isHeadCell     = vDist.greaterThanEqual(float(-0.5))
                               .and(vDist.lessThan(float(0.5)));
    const frozenTick     = floor(vCyclePhase.mul(20.0));
    const normalTick     = floor(
      cellPhase.mul(effectiveHoldSec).add(uTime).div(effectiveHoldSec)
    );
    const changeTick     = select(
      isFreezeActive.and(isHeadCell),
      frozenTick,
      normalTick
    );
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
    const baseOrMut   = select(
      isDeepTrail.or(stability.lessThan(uStability)),
      baseGlyph,
      mutGlyph,
    );
    const glyphIdx = baseOrMut.toVar('glyphIdx');

    // ── Lock-head glyph override ───────────────────────────────────────────
    // Locked columns have their head glyph frozen to the target character.
    const lockGlyph  = vLockState.y;
    const lockActive = vLockState.z.greaterThan(float(0.0));
    const isLockHead = lockActive
      .and(vDist.greaterThanEqual(float(-0.5)))
      .and(vDist.lessThan(float(0.5)));
    const hasLockTarget = lockGlyph.greaterThanEqual(float(0.0));
    glyphIdx.assign(select(isLockHead.and(hasLockTarget), lockGlyph, glyphIdx));

    // Suppress non-locked fragments inside the message reveal band.
    // Gated by uMsgBandSuppress (user toggle) and uMsgRevealActive (set when first glyph locks).
    // X bounds (screen UV) are computed from the message text layout so suppression
    // covers only the text's horizontal extent, not the full screen width.
    If(uMsgBandSuppress.greaterThan(float(0.0))
        .and(uMsgRevealActive.greaterThan(float(0.0)))
        .and(lockActive.not()), () => {
      const inY = abs(vCellWorldY.sub(uMsgRevealY)).lessThan(uMsgRevealBand);
      const inX = screenUV.x.greaterThan(uMsgXMin).and(screenUV.x.lessThan(uMsgXMax));
      If(inY.and(inX), () => { Discard(); });
    });

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

    // ── Terminal flash — head surges bright near EOL ───────────────────────
    // Gaussian peak centred just before the death fade (eolFlashPeak ≈ uEolFadeStart - 0.01).
    // Applied only at the head (dist ≈ 0) via headFrac to avoid lighting the trail.
    const eolFlashPeak   = uEolFadeStart.sub(0.01);
    const eolFlashWidth  = float(0.04);
    const eolFlashDelta  = vCyclePhase.sub(eolFlashPeak).div(eolFlashWidth);
    const eolFlashCurve  = exp(eolFlashDelta.mul(eolFlashDelta).negate());
    const eolFlashAmt    = eolFlashCurve.mul(uEolFlash).mul(headFrac);
    col2.addAssign(col2.mul(eolFlashAmt));

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

    // ── Lock-head brightness settle ────────────────────────────────────
    // Brief flare on lock, then cool down to normal trail-head brightness over 1 s.
    const lockAge    = uTime.sub(vLockState.z);  // seconds since lock fired
    const lockSettle = smoothstep(0.0, 1.0, lockAge); // 0 → 1 over 1 s
    const lockBoost  = mix(uMsgBoost, float(1.0), lockSettle);
    col2.mulAssign(select(isLockHead, lockBoost, float(1.0)));

    // ── Panel tangent frame (kept for lighting) ───────────────────────
    const panelRight = vec3(vOutward.z, 0.0, vOutward.x.negate());

    // ── Screen-space parallax ─────────────────────────────────────────
    // Traditional tangent-space POM is zero for camera-facing billboards.
    // Instead: use the fragment's screen position relative to centre as the
    // march direction — always non-zero, always produces visible displacement.
    // Fragments far from screen centre get proportionally more parallax.

    // MTSDF blend factor — computed here in uniform control flow (dFdx/dFdy
    // are invalid inside the POM loop which is non-uniform control flow).
    // screenPx ≈ glyph width in screen pixels; useSDF:
    //   < 3 px (tiny rain glyph) → useSDF=1 → true SDF (no colour fringing)
    //   > 6 px (large CRT glyph) → useSDF=0 → MSDF (sharp corners)
    const screenPx = float(1).div(abs(dFdx(vUvRain.x)).add(abs(dFdy(vUvRain.x))));
    const useSDF   = smoothstep(float(6), float(3), screenPx);

    const numSteps = int(max(uPomSteps.toFloat(), 3.0));
    const stepSize = float(1).div(numSteps.toFloat());
    // Locked head cells (message reveal) get zero POM depth — concave glyphs like 'R'
    // flicker as the screen-space march direction changes with camera movement, causing
    // the ray to oscillate between different ink regions across the glyph's counter.
    const pomDepth = select(isLockHead, float(0.0), uDepth);
    const stepFace = screenUV.sub(0.5).mul(2.0).mul(pomDepth).mul(stepSize);

    const currentFace = vUvRain.toVar('cfUV');
    const prevFace    = vUvRain.toVar('pfUV');
    const currentH    = float(1).toVar('cH');
    const prevH       = float(1).toVar('pH');

    // Ray-march into the SDF surface
    Loop({ start: int(0), end: int(8), type: 'int' }, ({ i }) => {
      If(i.greaterThanEqual(numSteps), () => { Break(); });
      prevFace.assign(currentFace);
      prevH.assign(currentH);
      currentFace.assign(clamp(currentFace.add(stepFace), 0.005, 0.995));
      currentH.subAssign(stepSize);
      If(sampleGlyph(currentFace, glyphIdx, float(1)).greaterThanEqual(currentH), () => { Break(); });
    });

    // Binary refinement — 3 bisection steps for sub-step accuracy
    const loFace = prevFace.toVar('loF');
    const hiFace = currentFace.toVar('hiF');
    const loH    = prevH.toVar('loH');
    const hiH    = currentH.toVar('hiH');
    Loop(3, () => {
      const midFace = loFace.add(hiFace).mul(0.5).toVar('midF');
      const midH    = loH.add(hiH).mul(0.5).toVar('midH');
      const s       = sampleGlyph(midFace, glyphIdx, float(1));
      If(s.greaterThanEqual(midH), () => {
        hiFace.assign(midFace);
        hiH.assign(midH);
      }).Else(() => {
        loFace.assign(midFace);
        loH.assign(midH);
      });
    });

    const finalFace = loFace.add(hiFace).mul(0.5);

    // MTSDF anti-aliased mask at POM-displaced position
    const sdfG = sampleGlyph(finalFace, glyphIdx, useSDF);
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
    const rMask  = smoothstep(float(0.5).sub(fw), float(0.5).add(fw), sampleGlyph(rUV, glyphIdx, useSDF));
    const bMask  = smoothstep(float(0.5).sub(fw), float(0.5).add(fw), sampleGlyph(bUV, glyphIdx, useSDF));
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
      const mL  = sampleGlyph(finalFace.add(vec2(eps.negate(), 0)), glyphIdx, useSDF);
      const mR  = sampleGlyph(finalFace.add(vec2(eps,           0)), glyphIdx, useSDF);
      const mD  = sampleGlyph(finalFace.add(vec2(0, eps.negate())), glyphIdx, useSDF);
      const mU  = sampleGlyph(finalFace.add(vec2(0, eps          )), glyphIdx, useSDF);
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
    const rawBright = trail.mul(mask).mul(vAlpha).mul(vDepthDim).toVar('rawBright');
    // Locked head cell: force full brightness so the glyph always shows at head position
    rawBright.assign(select(isLockHead, float(1.0), rawBright));
    // Trail cells of locked columns: fade in over 0.6 s so they don't pop in abruptly
    const trailFadeIn = smoothstep(0.0, 0.6, lockAge);
    const isLockTrail = lockActive.and(isLockHead.not());
    rawBright.assign(select(isLockTrail, rawBright.mul(trailFadeIn), rawBright));
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
    depthTest:          false,
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

// buildMsgColumnMaterial removed — message reveal now uses per-column lock state
// in the main rain geometry (see aLockState attribute and vLockState varying).
// Kept as dead stub for tree-shaking; exported name removed from imports in webgpu.js.
function _removedBuildMsgColumnMaterial(uniforms, atlasTexture) {
  const {
    uAtlasGridW, uAtlasGridH, uGlyphCount,
    uColor, uMsgBoost, uAtlasMTSDF,
    uMsgRevealProgress, uMsgWaveX, uMsgWaveR,
    uMsgCascadeMode, uMsgSettleSharpness,
    uTime,
  } = uniforms;

  // Per-instance attributes — TSL auto-promotes to interpolated varyings.
  // All 4 vertices of each instance share the same value so interpolation
  // produces the correct per-character value in every fragment.
  const aMsgGlyph = attribute('aMsgGlyph', 'float');
  const aMsgPhase = attribute('aMsgPhase', 'float');

  // ── Fragment ─────────────────────────────────────────────────────────────
  // uv() reads the geometry UV (PlaneGeometry: 0→1 in XY) — auto-varying.
  const outputNode = Fn(() => {
    const faceUV = uv();

    // ── Cascade wave front ─────────────────────────────────────────────────
    const isRadial = uMsgCascadeMode.greaterThanEqual(float(0.5))
      .and(uMsgCascadeMode.lessThan(float(1.5)));
    const waveGapW   = uMsgWaveX.sub(aMsgPhase);
    const waveGapR   = uMsgWaveR.sub(aMsgPhase);
    const waveGapRaw = select(isRadial, waveGapR, waveGapW);
    const waveGap01  = clamp(waveGapRaw.mul(uMsgSettleSharpness), float(0.0), float(1.0));
    const wavePast   = step(float(0.0), waveGapRaw);

    // ── Settle amount for this character ──────────────────────────────────
    const settleAmt = smoothstep(float(0.0), float(0.35), waveGap01).mul(uMsgRevealProgress);

    // ── Scramble then crystallise ──────────────────────────────────────────
    const changeTick = floor(uTime.mul(15.0));
    const mutGlyph   = floor(
      fract(sin(changeTick.mul(17.3).add(aMsgPhase.mul(431.2))).mul(43758.5))
        .mul(uGlyphCount)
    );
    const coin = fract(sin(changeTick.mul(23.7).add(aMsgPhase.mul(891.3))).mul(43758.5));

    const hasTarget  = aMsgGlyph.greaterThanEqual(float(0.0));
    const useTarget  = coin.lessThan(settleAmt).and(hasTarget);
    const glyphIdx   = clamp(
      select(useTarget, aMsgGlyph, mutGlyph),
      float(0.0),
      uGlyphCount.sub(1.0),
    );

    // ── MTSDF atlas sample ────────────────────────────────────────────────
    const col     = mod(glyphIdx, uAtlasGridW);
    const row     = floor(glyphIdx.div(uAtlasGridW));
    const atlasUV = vec2(
      col.add(faceUV.x).div(uAtlasGridW),
      row.add(float(1.0).sub(faceUV.y)).div(uAtlasGridH),
    );
    const s    = texture(atlasTexture, atlasUV);
    const msdf = median3(s.r, s.g, s.b);
    const sdfV = mix(msdf, s.a, uAtlasMTSDF);
    const fw   = abs(dFdx(sdfV)).add(abs(dFdy(sdfV))).mul(0.7);
    const gMask = smoothstep(float(0.5).sub(fw), float(0.5).add(fw), sdfV);

    If(gMask.lessThan(float(0.01)), () => { Discard(); });

    const alpha = gMask.mul(wavePast).mul(uMsgRevealProgress);
    return vec4(uColor.mul(uMsgBoost), alpha);
  })();

  // ── Material ──────────────────────────────────────────────────────────────
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite:  false,
    depthTest:   false,
    blending:    THREE.NormalBlending,
    side:        THREE.FrontSide,
  });
  material.toneMapped = false;
  material.outputNode = outputNode;
  // No vertexNode — Three.js InstancedMesh standard MVP handles positioning.

  return material;
}
