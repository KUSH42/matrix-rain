import { describe, expect, it } from 'vitest';
import {
  ATLAS_FIELD_MODES,
  CHAR_SETS,
  atlasFieldModeToValue,
  resolveAtlasDescriptor,
} from '../matrix-rain-glyphs.js';

describe('glyph atlas descriptors', () => {
  it('matrixcode stays on the compatibility path', () => {
    expect(CHAR_SETS.matrixcode.fieldMode).toBe(ATLAS_FIELD_MODES.compat);
    expect(CHAR_SETS.matrixcode.pxRange).toBe(4);
    expect(CHAR_SETS.matrixcode.atlasWidth).toBe(512);
    expect(CHAR_SETS.matrixcode.atlasHeight).toBe(512);
  });

  it('mtsdf charsets carry explicit decode metadata', () => {
    expect(CHAR_SETS.ascii.fieldMode).toBe(ATLAS_FIELD_MODES.mtsdf);
    expect(CHAR_SETS.ascii.pxRange).toBe(4);
    expect(CHAR_SETS.ascii.atlasWidth).toBe(640);
    expect(CHAR_SETS.ascii.atlasHeight).toBe(640);
  });
});

describe('atlas metadata helpers', () => {
  it('maps field modes to stable numeric shader values', () => {
    expect(atlasFieldModeToValue('compat')).toBe(0);
    expect(atlasFieldModeToValue('msdf')).toBe(1);
    expect(atlasFieldModeToValue('mtsdf')).toBe(2);
  });

  it('keeps explicit atlasPath on documented compat defaults unless metadata is supplied', () => {
    const desc = resolveAtlasDescriptor({ atlasPath: '/tmp/custom.png' });
    expect(desc.path).toBe('/tmp/custom.png');
    expect(desc.fieldMode).toBe(ATLAS_FIELD_MODES.compat);
    expect(desc.glyphCount).toBe(56);
    expect(desc.gridW).toBe(8);
    expect(desc.gridH).toBe(8);
    expect(desc.atlasWidth).toBe(512);
    expect(desc.atlasHeight).toBe(512);
  });

  it('allows explicit atlasPath metadata overrides', () => {
    const desc = resolveAtlasDescriptor({
      atlasPath: '/tmp/custom.png',
      atlasGlyphCount: 95,
      atlasGridW: 10,
      atlasGridH: 10,
      atlasFieldMode: 'mtsdf',
      atlasPxRange: 6,
      atlasWidth: 640,
      atlasHeight: 640,
    });
    expect(desc.fieldMode).toBe(ATLAS_FIELD_MODES.mtsdf);
    expect(desc.glyphCount).toBe(95);
    expect(desc.gridW).toBe(10);
    expect(desc.gridH).toBe(10);
    expect(desc.pxRange).toBe(6);
    expect(desc.atlasWidth).toBe(640);
    expect(desc.atlasHeight).toBe(640);
  });
});
