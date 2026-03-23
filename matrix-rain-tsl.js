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
  positionGeometry, uv, frontFacing,
  select, texture,
  If, Loop, Break, Discard,
  dFdx, dFdy,
} from 'three/tsl';
import * as THREE from 'three/webgpu';

// ── Stable 2-component hash ───────────────────────────────────────────────
// Identical to H2_GLSL in the original — keeps inputs small with fract() to
// avoid GPU sin() precision issues at large t values.
const h2 = Fn(([v]) => {
  const s = fract(v.mul(vec2(0.1031, 0.1030))).toVar();
  s.addAssign(dot(s, s.yx.add(33.33)));
  return fract(s.x.add(s.y).mul(s.x));
});

// ── MSDF median — preserves sharp corners ────────────────────────────────
const median3 = Fn(([a, b, c]) => max(min(a, b), min(max(a, b), c)));

// ── Uniform factory ───────────────────────────────────────────────────────
/**
 * @param {number} [glyphCount=48]  total glyphs in the MSDF atlas
 * @returns {object}  all mutable TSL uniform nodes
 */
export function makeUniforms(glyphCount = 48) {
  return {
    uGlyphCount:     uniform(glyphCount),
    uAtlasCols:      uniform(8),
    uAtlasGrid:      uniform(8),
    uTime:           uniform(0),
    uCellW:          uniform(0.12),
    uCellH:          uniform(0.08),
    uWorldH:         uniform(16),
    uNRows:          uniform(120),
    uColor:          uniform(new THREE.Vector3(0, 1, 0.44)),
    uGlobalAlpha:    uniform(0.82),
    uDepth:          uniform(0.04),
    uPomSteps:       uniform(6),
    uNormalStrength: uniform(6),
    uLightDir:       uniform(new THREE.Vector3(-0.4, 0.8, 0.5).normalize()),
    uGlobeInteract:  uniform(1.0),
    uGlyphChroma:    uniform(1.0),
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
    uGlyphCount, uAtlasCols, uAtlasGrid, uTime,
    uCellW, uCellH, uWorldH, uNRows,
    uColor, uGlobalAlpha, uDepth, uPomSteps, uNormalStrength,
    uLightDir, uGlobeInteract, uGlyphChroma,
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
  const vGlobeProx = varying(float(),  'vGlobeProx');

  // ── MSDF sampling (closure over atlasTexture + uniforms) ──────────────
  const sampleGlyph = Fn(([faceUV, gIdx]) => {
    // Back-face U-flip: mirror U on the rear face of each billboard quad
    const su  = select(frontFacing, faceUV.x, float(1).sub(faceUV.x));
    const col = mod(gIdx, uAtlasCols);
    const row = floor(gIdx.div(uAtlasCols));
    const atlasUV = vec2(
      col.add(su).div(uAtlasGrid),
      row.add(float(1).sub(faceUV.y)).div(uAtlasGrid),
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
    vGlobeProx.assign(0.0);
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
    const bootFadeVal = smoothstep(bootDelay, bootDelay.add(0.3), uTime);
    vBootFade.assign(bootFadeVal);

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
      vAlpha.assign(aAlpha.mul(alphaJitter));

      // Static world-Y of this cell
      const cellY = aYOff.add(uWorldH.mul(0.5))
        .sub(aRowIdxAttr.mul(cellStep))
        .add(yJitter);

      // ── Column burst — 0.5 % of columns get a 4 s speed surge ───────
      const burstCycle  = float(4.0);
      const burstBucket = floor(uTime.div(burstCycle));
      const burstH      = h2(vec2(aColIdxAttr.mul(0.41), burstBucket.mul(0.19)));
      const burstActive = step(0.995, burstH);
      const burstPhase  = fract(uTime.div(burstCycle));
      const burstFrac   = smoothstep(0.0, 0.1, burstPhase)
        .mul(float(1).sub(smoothstep(0.25, 0.35, burstPhase)));
      const speedMul    = float(1).add(burstActive.mul(burstFrac).mul(2));
      vBurst.assign(burstActive.mul(burstFrac));

      // ── Head sweep ──────────────────────────────────────────────────
      const cycleH    = uWorldH.add(uNRows.mul(cellStep));
      const cyclePos  = mod(
        uTime.mul(aSpeed).mul(speedMul).add(aSeed.mul(cycleH)),
        cycleH
      );
      const cyclePhase = cyclePos.div(cycleH);

      // Death fade — smooth-out in the last 12 % of cycle before wrap
      const deathRamp = smoothstep(0.88, 1.0, cyclePhase);
      vDeathFade.assign(float(1).sub(deathRamp));

      const headY = aYOff.add(uWorldH.mul(0.5)).sub(cyclePos);
      const dist  = cellY.sub(headY).div(cellStep);
      vDist.assign(dist);

      // ── Globe proximity pulse ────────────────────────────────────────
      const xzProx = float(1).sub(
        smoothstep(1.0, 7.0, length(vec2(aWX, aWZ)).sub(1.0))
      );
      const yProx  = float(1).sub(smoothstep(0.0, 1.2, abs(headY)));
      vGlobeProx.assign(
        xzProx.mul(yProx).mul(smoothstep(3.0, 0.0, max(dist, 0.0)))
      );

      // Cull glyphs outside the visible trail window
      const maxVisible = min(float(4.42).div(aTrail), uNRows.mul(1.2));
      If(dist.greaterThanEqual(-0.5).and(dist.lessThanEqual(maxVisible)), () => {

        // ── 3D world-space placement ───────────────────────────────────
        // Columns converge toward a point 2 units behind origin on Z.
        // Each column has ±5° facing jitter for subtle parallax.
        const colCenter   = vec3(aWX, cellY, aWZ).toVar();
        const toTarget    = vec2(aWX.negate(), float(-2).sub(aWZ));
        const targetAngle = atan(toTarget.x, toTarget.y);
        const facingAngle = targetAngle.add(
          h2(vec2(aColIdxAttr.mul(0.73), 0.51)).sub(0.5).mul(0.1745) // ±5°
        );
        const outward = vec3(sin(facingAngle), 0.0, cos(facingAngle));
        const right   = vec3(outward.z, 0.0, outward.x.negate()); // cross(Y, outward)
        vOutward.assign(outward);

        // Sinusoidal lateral sway — head leads, tail lags
        const sway = sin(uTime.mul(0.4).add(aSeed.mul(6.2832))).mul(0.04)
          .mul(float(1).sub(clamp(dist.div(uNRows), 0.0, 1.0)));
        colCenter.addAssign(right.mul(sway));

        // Per-column Z-rotation ±5°
        const rotAngle = h2(vec2(aSeed, 42.0)).sub(0.5).mul(0.1745);
        const cosR     = cos(rotAngle);
        const sinR     = sin(rotAngle);
        const rotRight = right.mul(cosR).add(vec3(0, 1, 0).mul(sinR));
        const rotUp    = vec3(0, 1, 0).mul(cosR).sub(right.mul(sinR));

        // Drip stretch — Y-scale at head for mercury-drip effect
        const scaleJitter = float(1).add(
          h2(vec2(aColIdxAttr.mul(0.53), aRowIdxAttr.mul(0.17))).sub(0.5).mul(0.20)
        );
        const dripStretch = float(1).add(
          float(0.35).mul(exp(max(dist, 0.0).negate().mul(1.5)))
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

    // ── Globe occlusion ───────────────────────────────────────────────
    const toFrag   = vWorldPos.sub(cameraPosition);
    const fragDist = length(toFrag);
    const viewDir  = toFrag.div(fragDist);
    const ob       = dot(cameraPosition, viewDir);
    const oc       = dot(cameraPosition, cameraPosition).sub(1.0); // globe r=1
    const disc     = ob.mul(ob).sub(oc);
    const occlude  = float(1.0).toVar();
    If(disc.greaterThan(0.0), () => {
      const tNear = ob.negate().sub(sqrt(disc));
      If(tNear.greaterThan(0.0).and(fragDist.greaterThan(tNear)), () => {
        occlude.assign(
          float(1).sub(float(0.8).mul(smoothstep(0.0, 0.12, sqrt(disc))))
        );
      });
    });

    // Early discard if max possible alpha is sub-visible
    const maxAlpha = pow(trail.mul(vAlpha).mul(vDepthDim), 1.3)
      .mul(uGlobalAlpha).mul(occlude).mul(vBootFade);
    If(maxAlpha.lessThan(0.015), () => { Discard(); });

    // ── Glyph selection ───────────────────────────────────────────────
    const cellId      = vec2(floor(vColIdx.add(0.5)), floor(vRowIdx.add(0.5)));
    const cellPhase   = h2(cellId.mul(0.37));
    const stability   = h2(cellId.mul(0.91));
    const holdSec     = float(0.45).add(h2(cellId.mul(0.29)).mul(7.15));
    const burstOffset = select(
      vBurst.greaterThan(0.5), floor(uTime.mul(12.0)), float(0)
    );
    const changeTick  = floor(
      cellPhase.mul(holdSec).add(uTime).div(holdSec)
    ).add(burstOffset);
    const baseGlyph   = floor(h2(cellId.mul(0.47).add(0.5)).mul(uGlyphCount));
    const mutGlyph    = floor(
      h2(cellId.mul(0.37).add(changeTick.mul(vec2(0.11, 0.07)))).mul(uGlyphCount)
    );
    const glyphIdx    = select(stability.lessThan(0.30), baseGlyph, mutGlyph);

    // Film grain
    const sampleX = select(frontFacing, vUvRain.x, float(1).sub(vUvRain.x));
    const grain   = h2(vec2(
      sampleX.mul(47.3).add(vUvRain.y.mul(31.7)).add(vColIdx.mul(0.53)),
      uTime.mul(7.3).add(vRowIdx.mul(0.19))
    )).sub(0.5).mul(0.07);

    // Per-column hue shift — G-B plane rotation for yellow-green ↔ cyan
    const hueShift   = h2(vec2(cellId.x.mul(0.17), 0.0)).sub(0.5).mul(2.0);
    const hueRad     = hueShift.mul(0.14); // ±8°
    const cosH       = cos(hueRad);
    const sinH_      = sin(hueRad);
    const tintedColor = vec3(
      uColor.x,
      uColor.y.mul(cosH).sub(uColor.z.mul(sinH_)),
      uColor.y.mul(sinH_).add(uColor.z.mul(cosH)),
    );

    // Color: head burns white, trail is deep saturated green
    const headFrac = float(1).sub(smoothstep(0.0, 0.8, vDist));
    const col2 = mix(
      tintedColor.mul(1.6),
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
    col2.assign(mix(col2, col2.mul(vec3(0.6, 0.85, 1.1)), depthTint.mul(0.4)));

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
    const aberration = exp(max(vDist, 0.0).negate().mul(1.5)).mul(uGlyphChroma);
    const chromaOff  = aberration.mul(0.012);
    const rUV    = clamp(vec2(finalFace.x.add(chromaOff), finalFace.y), 0.005, 0.995);
    const bUV    = clamp(vec2(finalFace.x.sub(chromaOff), finalFace.y), 0.005, 0.995);
    const rMask  = smoothstep(float(0.5).sub(fw), float(0.5).add(fw), sampleGlyph(rUV, glyphIdx));
    const bMask  = smoothstep(float(0.5).sub(fw), float(0.5).add(fw), sampleGlyph(bUV, glyphIdx));
    const safeMask = max(mask, 0.01);
    // Component-wise chroma correction
    col2.assign(vec3(
      col2.x.mul(rMask.div(safeMask)),
      col2.y,
      col2.z.mul(bMask.div(safeMask)),
    ));

    // Edge emission glow — laser-etched holographic corona
    const edgeDist = abs(sdfG.sub(0.5));
    const edgeGlow = exp(edgeDist.negate().mul(18.0)).mul(0.4);
    col2.addAssign(uColor.mul(edgeGlow).mul(trail));

    // Globe impact pulse — additive glow when head nears globe surface
    const impulseBright = vGlobeProx.mul(trail).mul(mask).mul(4.0).mul(uGlobeInteract);
    col2.addAssign(vec3(0.6, 1.0, 0.7).mul(impulseBright));

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

    // ── Final alpha ────────────────────────────────────────────────────
    const rawBright = trail.mul(mask).mul(vAlpha).mul(vDepthDim);
    const contrast  = pow(rawBright, 1.3);
    const alpha     = contrast.mul(uGlobalAlpha).mul(occlude).mul(vBootFade).mul(vDeathFade);
    If(alpha.lessThan(0.015), () => { Discard(); });

    // Pre-multiplied alpha — additive compositing on the canvas
    return vec4(col2.mul(alpha), alpha);
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
