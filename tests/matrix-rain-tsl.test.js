/**
 * Unit tests for matrix-rain-tsl.js
 *
 * These tests run in Node (no GPU). They cover:
 *   - Module shape: exported symbols exist with correct types
 *   - makeUniforms(): default values match documented shader defaults
 *   - makeUniforms(): idempotency — two calls return independent objects
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildGlyphMaterial, h2, hueRotateRGB, makeUniforms, median3 } from '../matrix-rain-tsl.js';

// ─── Exports ────────────────────────────────────────────────────────────────

describe('module exports', () => {
  it('h2 is a callable TSL Fn', () => {
    expect(typeof h2).toBe('function');
  });

  it('median3 is a callable TSL Fn', () => {
    expect(typeof median3).toBe('function');
  });

  it('hueRotateRGB is a callable TSL Fn', () => {
    expect(typeof hueRotateRGB).toBe('function');
  });

  it('buildGlyphMaterial is a function', () => {
    expect(typeof buildGlyphMaterial).toBe('function');
  });
});

// ─── makeUniforms() ─────────────────────────────────────────────────────────

describe('makeUniforms() shape', () => {
  it('returns a non-null object', () => {
    const u = makeUniforms();
    expect(u).toBeTruthy();
    expect(typeof u).toBe('object');
  });

  it('contains at least 90 uniform entries', () => {
    const u = makeUniforms();
    expect(Object.keys(u).length).toBeGreaterThanOrEqual(90);
  });

  it('every value has a .value property', () => {
    const u = makeUniforms();
    for (const [key, node] of Object.entries(u)) {
      expect(node, `uniform "${key}" should have .value`).toHaveProperty('value');
    }
  });

  it('two calls return independent objects (no shared state)', () => {
    const a = makeUniforms();
    const b = makeUniforms();
    expect(a).not.toBe(b);
    a.uDepth.value = 999;
    expect(b.uDepth.value).not.toBe(999);
  });
});

describe('makeUniforms() default scalar values', () => {
  let u;
  beforeAll(() => { u = makeUniforms(); });

  // Atlas grid
  it('uAtlasGridW defaults to 8', () => expect(u.uAtlasGridW.value).toBe(8));
  it('uAtlasGridH defaults to 8', () => expect(u.uAtlasGridH.value).toBe(8));
  it('uGlyphCount defaults to 56', () => expect(u.uGlyphCount.value).toBe(56));

  // Cell dimensions
  it('uCellW defaults to 0.12', () => expect(u.uCellW.value).toBeCloseTo(0.12));
  it('uCellH defaults to 0.08', () => expect(u.uCellH.value).toBeCloseTo(0.08));
  it('uNRows defaults to 120', () => expect(u.uNRows.value).toBe(120));
  it('uWorldH defaults to 16', () => expect(u.uWorldH.value).toBe(16));

  // Core appearance
  it('uGlobalAlpha defaults to 0.82', () => expect(u.uGlobalAlpha.value).toBeCloseTo(0.82));
  it('uDepth defaults to 0.04', () => expect(u.uDepth.value).toBeCloseTo(0.04));
  it('uNormalStrength defaults to 6', () => expect(u.uNormalStrength.value).toBeCloseTo(6.0));
  it('uBrightness defaults to 1', () => expect(u.uBrightness.value).toBeCloseTo(1.0));

  // uColor — Matrix green
  it('uColor defaults to (0, 1, 0.44)', () => {
    expect(u.uColor.value.x).toBeCloseTo(0);
    expect(u.uColor.value.y).toBeCloseTo(1);
    expect(u.uColor.value.z).toBeCloseTo(0.44);
  });

  // Time starts at zero
  it('uTime defaults to 0', () => expect(u.uTime.value).toBe(0));

  // Globe / chroma
  it('uGlobeInteract defaults to 1 (on)', () => expect(u.uGlobeInteract.value).toBe(1));
  it('uGlyphChroma defaults to 1 (on)', () => expect(u.uGlyphChroma.value).toBe(1));

  // POM
  it('uPomSteps defaults to 6', () => expect(u.uPomSteps.value).toBe(6));

  // Column dynamics
  it('uReverseChance defaults to 0', () => expect(u.uReverseChance.value).toBe(0));
  it('uDensity defaults to 1', () => expect(u.uDensity.value).toBe(1));
  it('uSectorStrength defaults to 0 (off)', () => expect(u.uSectorStrength.value).toBe(0));
  it('uHeightFade defaults to 0 (off)', () => expect(u.uHeightFade.value).toBe(0));
  it('uSpawnWaveFront defaults to 2 (all active)', () => expect(u.uSpawnWaveFront.value).toBe(2));

  // Message reveal
  it('uMsgBoost defaults to 2', () => expect(u.uMsgBoost.value).toBe(2));
  it('uMsgRevealActive defaults to 0', () => expect(u.uMsgRevealActive.value).toBe(0));
  it('uMsgBandSuppress defaults to 0', () => expect(u.uMsgBandSuppress.value).toBe(0));
  it('uMsgSettleSharpness defaults to 4', () => expect(u.uMsgSettleSharpness.value).toBe(4));

  // EOL
  it('uEolFlash defaults to 0.6', () => expect(u.uEolFlash.value).toBeCloseTo(0.6));
  it('uEolFreezeStart defaults to 0.80', () => expect(u.uEolFreezeStart.value).toBeCloseTo(0.80));
  it('uEolFadeStart defaults to 0.88', () => expect(u.uEolFadeStart.value).toBeCloseTo(0.88));

  // Cluster
  it('uClusterHueRange defaults to 18', () => expect(u.uClusterHueRange.value).toBe(18));
  it('uClusterBrightRange defaults to 0.35', () => expect(u.uClusterBrightRange.value).toBeCloseTo(0.35));
  it('uClusterSpeedRange defaults to 0.30', () => expect(u.uClusterSpeedRange.value).toBeCloseTo(0.30));
  it('uContagionStrength defaults to 0.35', () => expect(u.uContagionStrength.value).toBeCloseTo(0.35));

  // Entrainment
  it('uEntrainAmt defaults to 0.15', () => expect(u.uEntrainAmt.value).toBeCloseTo(0.15));
  it('uEntrainSpeed defaults to 0.25', () => expect(u.uEntrainSpeed.value).toBeCloseTo(0.25));
  it('uEntrainCrests defaults to 3', () => expect(u.uEntrainCrests.value).toBe(3));

  // FX defaults off
  it('uShimmerAmt defaults to 0 (off)', () => expect(u.uShimmerAmt.value).toBe(0));
  it('uShimmerFreq defaults to 2', () => expect(u.uShimmerFreq.value).toBe(2));
  it('uInversionChance defaults to 0 (off)', () => expect(u.uInversionChance.value).toBe(0));
  it('uGlyphSpinAmt defaults to 0 (off)', () => expect(u.uGlyphSpinAmt.value).toBe(0));
  it('uGlyphSpinSpeed defaults to 1', () => expect(u.uGlyphSpinSpeed.value).toBe(1));
  it('uHueDriftRate defaults to 0 (off)', () => expect(u.uHueDriftRate.value).toBe(0));
  it('uHueDriftAmt defaults to 0 (off)', () => expect(u.uHueDriftAmt.value).toBe(0));
  it('uHeadOvershootAmt defaults to 0 (off)', () => expect(u.uHeadOvershootAmt.value).toBe(0));
  it('uGravityStrength defaults to 0 (off)', () => expect(u.uGravityStrength.value).toBe(0));
  it('uGravityRate defaults to 0.2', () => expect(u.uGravityRate.value).toBeCloseTo(0.2));
  it('uMorseAmt defaults to 0 (off)', () => expect(u.uMorseAmt.value).toBe(0));
  it('uMorseRate defaults to 2', () => expect(u.uMorseRate.value).toBe(2));
  it('uSpiralAmt defaults to 0 (off)', () => expect(u.uSpiralAmt.value).toBe(0));
  it('uSpiralRate defaults to 0.1', () => expect(u.uSpiralRate.value).toBeCloseTo(0.1));
  it('uSpiralPitch defaults to π', () => expect(u.uSpiralPitch.value).toBeCloseTo(Math.PI));
  it('uPerspectiveStrength defaults to 0 (off)', () => expect(u.uPerspectiveStrength.value).toBe(0));
});
