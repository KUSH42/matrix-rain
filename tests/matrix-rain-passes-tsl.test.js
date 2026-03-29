/**
 * Unit tests for matrix-rain-passes-tsl.js
 *
 * Tests run in Node (no GPU). They cover:
 *   - All pass builders are exported and callable
 *   - Each builder returns an object with at minimum an `outputNode`
 *   - Known uniform defaults for each pass (catches regressions like the
 *     uDecay 0.33→0.96 mismatch that was fixed in this codebase)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildDustPass,
  buildFogPass,
  buildGodRaysPass,
  buildHeatPass,
  buildHoloPass,
  buildPhosphorPass,
  buildRadialChromaPass,
  buildSoftenPass,
  buildStreakPass,
} from '../matrix-rain-passes-tsl.js';
import { uniform } from 'three/tsl';

// A minimal dummy input — a vec4 uniform node works as a stand-in for any rtt output.
function dummyInput() {
  return uniform([0, 0, 0, 1]);
}

// ─── Exports ────────────────────────────────────────────────────────────────

describe('pass builder exports', () => {
  const builders = {
    buildDustPass,
    buildFogPass,
    buildGodRaysPass,
    buildHeatPass,
    buildHoloPass,
    buildPhosphorPass,
    buildRadialChromaPass,
    buildSoftenPass,
    buildStreakPass,
  };

  for (const [name, fn] of Object.entries(builders)) {
    it(`${name} is exported as a function`, () => {
      expect(typeof fn).toBe('function');
    });
  }
});

// ─── Output shape: every builder must return an outputNode ──────────────────

describe('pass builder output shape', () => {
  it('buildHeatPass returns outputNode', () => {
    const p = buildHeatPass(dummyInput());
    expect(p).toHaveProperty('outputNode');
  });

  it('buildGodRaysPass returns outputNode', () => {
    const p = buildGodRaysPass(dummyInput());
    expect(p).toHaveProperty('outputNode');
  });

  it('buildPhosphorPass returns outputNode', () => {
    const p = buildPhosphorPass(dummyInput(), dummyInput(), 0.88);
    expect(p).toHaveProperty('outputNode');
  });

  it('buildHoloPass returns outputNode', () => {
    const p = buildHoloPass(dummyInput(), dummyInput());
    expect(p).toHaveProperty('outputNode');
  });

  it('buildStreakPass returns outputNode', () => {
    const p = buildStreakPass(dummyInput(), dummyInput());
    expect(p).toHaveProperty('outputNode');
  });

  it('buildSoftenPass returns outputNode', () => {
    const p = buildSoftenPass(dummyInput());
    expect(p).toHaveProperty('outputNode');
  });

  it('buildDustPass returns outputNode', () => {
    const p = buildDustPass(dummyInput());
    expect(p).toHaveProperty('outputNode');
  });

  it('buildFogPass returns outputNode', () => {
    const p = buildFogPass(dummyInput());
    expect(p).toHaveProperty('outputNode');
  });

  it('buildRadialChromaPass returns outputNode', () => {
    const p = buildRadialChromaPass(dummyInput());
    expect(p).toHaveProperty('outputNode');
  });
});

// ─── buildGodRaysPass uniform defaults ──────────────────────────────────────

describe('buildGodRaysPass uniform defaults', () => {
  let p;
  beforeAll(() => { p = buildGodRaysPass(dummyInput()); });

  // uDecay was previously 0.33 (bug); correct default is 0.96 to match _ppState.
  it('uDecay defaults to 0.96', () => expect(p.uDecay.value).toBeCloseTo(0.96));
  it('uDensity defaults to 0.93', () => expect(p.uDensity.value).toBeCloseTo(0.93));
  it('uWeight defaults to 0.35', () => expect(p.uWeight.value).toBeCloseTo(0.35));
  it('uExposure defaults to 0.45', () => expect(p.uExposure.value).toBeCloseTo(0.45));
  it('uEnabled defaults to 1', () => expect(p.uEnabled.value).toBe(1));
  it('returns uLightPos', () => expect(p).toHaveProperty('uLightPos'));
});

// ─── buildHeatPass uniform defaults ─────────────────────────────────────────

describe('buildHeatPass uniform defaults', () => {
  let p;
  beforeAll(() => { p = buildHeatPass(dummyInput()); });

  it('returns uHeatAmt', () => expect(p).toHaveProperty('uHeatAmt'));
  it('uHeatAmt defaults to 0.004', () => expect(p.uHeatAmt.value).toBeCloseTo(0.004));
  it('returns uHeatFreq', () => expect(p).toHaveProperty('uHeatFreq'));
  it('returns uHeatSpeed', () => expect(p).toHaveProperty('uHeatSpeed'));
});

// ─── buildHoloPass uniform defaults ─────────────────────────────────────────

describe('buildHoloPass uniform defaults', () => {
  let p;
  beforeAll(() => { p = buildHoloPass(dummyInput(), dummyInput()); });

  it('returns uVignetteStrength', () => expect(p).toHaveProperty('uVignetteStrength'));
  it('returns uScanlineOpacity', () => expect(p).toHaveProperty('uScanlineOpacity'));
  it('returns uAberrationAmt', () => expect(p).toHaveProperty('uAberrationAmt'));
  it('returns uGlitchAmt', () => expect(p).toHaveProperty('uGlitchAmt'));
  it('returns uInterlaceAmt', () => expect(p).toHaveProperty('uInterlaceAmt'));
  it('uGlitchAmt defaults to 0 (off)', () => expect(p.uGlitchAmt.value).toBe(0));
});

// ─── buildStreakPass uniform defaults ────────────────────────────────────────

describe('buildStreakPass uniform defaults', () => {
  let p;
  beforeAll(() => { p = buildStreakPass(dummyInput(), dummyInput()); });

  it('returns uStreakAmt', () => expect(p).toHaveProperty('uStreakAmt'));
  it('uStreakAmt defaults to 0.055', () => expect(p.uStreakAmt.value).toBeCloseTo(0.055));
  it('returns uAspect', () => expect(p).toHaveProperty('uAspect'));
});

// ─── buildSoftenPass uniform defaults ────────────────────────────────────────

describe('buildSoftenPass uniform defaults', () => {
  let p;
  beforeAll(() => { p = buildSoftenPass(dummyInput()); });

  it('returns uBlurStrength', () => expect(p).toHaveProperty('uBlurStrength'));
});

// ─── buildDustPass uniform defaults ─────────────────────────────────────────

describe('buildDustPass uniform defaults', () => {
  let p;
  beforeAll(() => { p = buildDustPass(dummyInput()); });

  it('returns uDustAmt', () => expect(p).toHaveProperty('uDustAmt'));
  it('uDustAmt defaults to 0 (off)', () => expect(p.uDustAmt.value).toBe(0));
});

// ─── buildFogPass uniform defaults ──────────────────────────────────────────

describe('buildFogPass uniform defaults', () => {
  let p;
  beforeAll(() => { p = buildFogPass(dummyInput()); });

  it('returns uFogAmt', () => expect(p).toHaveProperty('uFogAmt'));
  it('uFogAmt defaults to 0 (off)', () => expect(p.uFogAmt.value).toBe(0));
  it('returns uFogColor', () => expect(p).toHaveProperty('uFogColor'));
});

// ─── buildRadialChromaPass uniform defaults ──────────────────────────────────

describe('buildRadialChromaPass uniform defaults', () => {
  let p;
  beforeAll(() => { p = buildRadialChromaPass(dummyInput()); });

  it('returns uRadialChromaticAmt', () => expect(p).toHaveProperty('uRadialChromaticAmt'));
  it('uRadialChromaticAmt defaults to 0 (off)', () => expect(p.uRadialChromaticAmt.value).toBe(0));
});
