/**
 * glyph-sets.js — canonical glyph set definitions for atlas generation.
 *
 * Consumed by tools/gen-atlas.html to produce MSDF-approx and bitmap atlases.
 * NOT loaded at runtime by the matrix rain library.
 *
 * Entry shapes:
 *   { char: '字', mirror: bool }    — Unicode character, optionally mirrored horizontally
 *   { path: [...cmds], stroke: bool, strokeWidth: number }  — custom drawn glyph
 *
 * Path command micro-format (coordinates normalised 0–1 within the cell, origin top-left):
 *   ['M', x, y]                           moveTo
 *   ['L', x, y]                           lineTo
 *   ['C', cx1, cy1, cx2, cy2, x, y]       bezierCurveTo
 *   ['Q', cx, cy, x, y]                   quadraticCurveTo
 *   ['Z']                                 closePath
 *
 * mirror: true  → glyph is drawn horizontally reflected (baked into the atlas cell).
 * stroke: true  → drawPath calls ctx.stroke() instead of ctx.fill().
 * strokeWidth   → line width in pixels (applied to the 64×64 cell before drawing).
 *
 * Reference: specs/matrix-rain-analysis.md §2 "Visual & Typographic Anatomy"
 */

// ── Custom glyph paths ────────────────────────────────────────────────────

// ψ-like: vertical stroke with two curved arms branching from upper-centre.
const PSI_PATH = {
  path: [
    ['M', 0.50, 0.08], ['L', 0.50, 0.92],           // central vertical
    ['M', 0.50, 0.28], ['Q', 0.20, 0.28, 0.18, 0.58], ['L', 0.22, 0.72], // left arm
    ['M', 0.50, 0.28], ['Q', 0.80, 0.28, 0.82, 0.58], ['L', 0.78, 0.72], // right arm
    ['M', 0.33, 0.88], ['L', 0.67, 0.88],            // base crossbar
  ],
  stroke: true, strokeWidth: 5,
};

// Ω-like: arch closed at top, open at bottom with small outward feet.
const OMEGA_PATH = {
  path: [
    ['M', 0.20, 0.82],
    ['L', 0.20, 0.72],
    ['Q', 0.18, 0.30, 0.50, 0.12],
    ['Q', 0.82, 0.30, 0.80, 0.72],
    ['L', 0.80, 0.82],
    ['M', 0.14, 0.82], ['L', 0.36, 0.82],  // left foot
    ['M', 0.64, 0.82], ['L', 0.86, 0.82],  // right foot
  ],
  stroke: true, strokeWidth: 5,
};

// Mirrored Z: Z reflected horizontally — top-right to top-left diagonal.
const MIRZ_PATH = {
  path: [
    ['M', 0.78, 0.15], ['L', 0.22, 0.15],  // top bar (right-to-left)
    ['L', 0.78, 0.85],                      // diagonal (top-left to bottom-right)
    ['L', 0.22, 0.85],                      // bottom bar
  ],
  stroke: true, strokeWidth: 5,
};

// Rotated T (90° clockwise): horizontal top stroke, vertical going right.
const ROTT_PATH = {
  path: [
    ['M', 0.15, 0.50], ['L', 0.85, 0.50],  // horizontal bar
    ['M', 0.15, 0.20], ['L', 0.15, 0.80],  // vertical bar on left
  ],
  stroke: true, strokeWidth: 5,
};

// Double-struck vertical bar: two parallel vertical strokes.
const DBAR_PATH = {
  path: [
    ['M', 0.35, 0.12], ['L', 0.35, 0.88],
    ['M', 0.65, 0.12], ['L', 0.65, 0.88],
  ],
  stroke: true, strokeWidth: 5,
};

// Diamond outline ◇.
const DIAMOND_PATH = {
  path: [
    ['M', 0.50, 0.10],
    ['L', 0.88, 0.50],
    ['L', 0.50, 0.90],
    ['L', 0.12, 0.50],
    ['Z'],
  ],
  stroke: true, strokeWidth: 5,
};

// Angular bracket pair ⌐ ¬ stacked — two reversed corners.
const BRACKET_PATH = {
  path: [
    ['M', 0.22, 0.22], ['L', 0.22, 0.48], ['L', 0.78, 0.48],  // top ⌐
    ['M', 0.22, 0.52], ['L', 0.78, 0.52], ['L', 0.78, 0.78],  // bottom ¬
  ],
  stroke: true, strokeWidth: 5,
};

// Triple horizontal rule — three stacked short bars of decreasing width.
const TRIBAR_PATH = {
  path: [
    ['M', 0.18, 0.28], ['L', 0.82, 0.28],
    ['M', 0.24, 0.50], ['L', 0.76, 0.50],
    ['M', 0.30, 0.72], ['L', 0.70, 0.72],
  ],
  stroke: true, strokeWidth: 5,
};

// ── Glyph set definitions ─────────────────────────────────────────────────

export const GLYPH_SETS = {

  /**
   * matrix1999 — film-accurate character set. 64 glyphs filling an 8×8 grid.
   *
   * Composition (per specs/matrix-rain-analysis.md §2):
   *   46 half-width katakana (U+FF65–U+FF9F), ~15 mirrored horizontally
   *   10 Arabic numerals (0–9)
   *    8 custom/modified glyphs (path-drawn)
   *
   * Half-width katakana used: all main forms. Small vowels (ｧ–ｮ, ｯ) and
   * voiced/semi-voiced marks (ﾞﾟ) excluded as in the film.
   */
  matrix1999: {
    gridW: 8, gridH: 8,
    /**
     * Per-glyph complexity weights for weighted glyph sampling (SPEC-2d-organic §4).
     * Three classes: complex (≥8 strokes) = 2.5 | medium = 1.0 | simple (≤4 strokes) = 0.5
     * One entry per glyph slot, length = gridW * gridH = 64.
     */
    weights: [
      1.0, 1.0, 1.0, 1.0, 1.0,  // 0–4  vowels (ｱｲｳｴｵ) — medium
      1.0, 1.0, 1.0, 1.0, 1.0,  // 5–9  K-row — medium
      1.0, 1.0, 1.0, 1.0, 1.0,  // 10–14 S-row — medium
      1.0, 1.0, 1.0, 2.5, 1.0,  // 15–19 T-row; ﾃ=18 complex (≥8 strokes)
      1.0, 2.5, 1.0, 1.0, 1.0,  // 20–24 N-row; ﾆ=21 complex
      2.5, 1.0, 1.0, 1.0, 2.5,  // 25–29 H-row; ﾊ=25 ﾎ=29 complex
      1.0, 1.0, 1.0, 1.0, 1.0,  // 30–34 M-row — medium
      1.0, 1.0, 1.0,             // 35–37 Y-row — medium
      1.0, 2.5, 2.5, 2.5, 2.5,  // 38–42 R-row; ﾘ=39 ﾙ=40 ﾚ=41 ﾛ=42 complex
      1.0, 1.0, 0.5,             // 43–45 WA/N/prolonged; ｰ=45 simple
      0.5, 0.5, 0.5, 0.5, 0.5,  // 46–50 numerals 0–4 — simple
      0.5, 0.5, 0.5, 0.5, 0.5,  // 51–55 numerals 5–9 — simple
      1.0, 1.0, 1.0, 1.0,        // 56–59 custom glyphs (ψ Ω ⌐ ⌐) — medium
      1.0, 1.0, 1.0, 1.0,        // 60–63 custom glyphs (◇ ⌐¬ ≡ ) — medium
    ],
    glyphs: [
      // ── Half-width katakana — vowel row ─────────────────────────────
      { char: 'ｱ', mirror: false },  // 0  A
      { char: 'ｲ', mirror: false },  // 1  I
      { char: 'ｳ', mirror: true  },  // 2  U      (mirrored)
      { char: 'ｴ', mirror: false },  // 3  E
      { char: 'ｵ', mirror: false },  // 4  O
      // ── K-row ────────────────────────────────────────────────────────
      { char: 'ｶ', mirror: true  },  // 5  KA     (mirrored)
      { char: 'ｷ', mirror: false },  // 6  KI
      { char: 'ｸ', mirror: true  },  // 7  KU     (mirrored)
      { char: 'ｹ', mirror: false },  // 8  KE
      { char: 'ｺ', mirror: false },  // 9  KO
      // ── S-row ────────────────────────────────────────────────────────
      { char: 'ｻ', mirror: false },  // 10 SA
      { char: 'ｼ', mirror: true  },  // 11 SI     (mirrored)
      { char: 'ｽ', mirror: true  },  // 12 SU     (mirrored)
      { char: 'ｾ', mirror: true  },  // 13 SE     (mirrored)
      { char: 'ｿ', mirror: true  },  // 14 SO     (mirrored)
      // ── T-row ────────────────────────────────────────────────────────
      { char: 'ﾀ', mirror: false },  // 15 TA
      { char: 'ﾁ', mirror: true  },  // 16 TI     (mirrored)
      { char: 'ﾂ', mirror: true  },  // 17 TU     (mirrored)
      { char: 'ﾃ', mirror: true  },  // 18 TE     (mirrored)
      { char: 'ﾄ', mirror: false },  // 19 TO
      // ── N-row ────────────────────────────────────────────────────────
      { char: 'ﾅ', mirror: true  },  // 20 NA     (mirrored)
      { char: 'ﾆ', mirror: false },  // 21 NI
      { char: 'ﾇ', mirror: false },  // 22 NU
      { char: 'ﾈ', mirror: false },  // 23 NE
      { char: 'ﾉ', mirror: true  },  // 24 NO     (mirrored)
      // ── H-row ────────────────────────────────────────────────────────
      { char: 'ﾊ', mirror: false },  // 25 HA
      { char: 'ﾋ', mirror: true  },  // 26 HI     (mirrored)
      { char: 'ﾌ', mirror: false },  // 27 HU
      { char: 'ﾍ', mirror: false },  // 28 HE
      { char: 'ﾎ', mirror: false },  // 29 HO
      // ── M-row ────────────────────────────────────────────────────────
      { char: 'ﾏ', mirror: false },  // 30 MA
      { char: 'ﾐ', mirror: false },  // 31 MI
      { char: 'ﾑ', mirror: true  },  // 32 MU     (mirrored)
      { char: 'ﾒ', mirror: false },  // 33 ME
      { char: 'ﾓ', mirror: false },  // 34 MO
      // ── Y-row ────────────────────────────────────────────────────────
      { char: 'ﾔ', mirror: false },  // 35 YA
      { char: 'ﾕ', mirror: false },  // 36 YU
      { char: 'ﾖ', mirror: false },  // 37 YO
      // ── R-row ────────────────────────────────────────────────────────
      { char: 'ﾗ', mirror: false },  // 38 RA
      { char: 'ﾘ', mirror: false },  // 39 RI
      { char: 'ﾙ', mirror: true  },  // 40 RU     (mirrored)
      { char: 'ﾚ', mirror: true  },  // 41 RE     (mirrored)
      { char: 'ﾛ', mirror: true  },  // 42 RO     (mirrored)
      // ── W-row + misc ─────────────────────────────────────────────────
      { char: 'ﾜ', mirror: false },  // 43 WA
      { char: 'ﾝ', mirror: false },  // 44 N
      { char: 'ｰ', mirror: false },  // 45 prolonged sound mark
      // ── Numerals (0–9) ───────────────────────────────────────────────
      { char: '0', mirror: false },  // 46
      { char: '1', mirror: false },  // 47
      { char: '2', mirror: false },  // 48
      { char: '3', mirror: false },  // 49
      { char: '4', mirror: false },  // 50
      { char: '5', mirror: false },  // 51
      { char: '6', mirror: false },  // 52
      { char: '7', mirror: false },  // 53
      { char: '8', mirror: false },  // 54
      { char: '9', mirror: false },  // 55
      // ── Custom / modified glyphs (film-specific symbols) ─────────────
      PSI_PATH,      // 56 ψ-like
      OMEGA_PATH,    // 57 Ω-like
      MIRZ_PATH,     // 58 mirrored Z
      ROTT_PATH,     // 59 rotated T
      DBAR_PATH,     // 60 double bar
      DIAMOND_PATH,  // 61 diamond outline
      BRACKET_PATH,  // 62 angular bracket pair
      TRIBAR_PATH,   // 63 triple horizontal rule
    ],
  },

  /**
   * latin — uppercase A–Z plus digits 0–9. 36 glyphs in an 8×8 grid (28 slots unused).
   * Uniform weights (all 1.0) — no complexity bias for latin characters.
   */
  latin: {
    gridW: 8, gridH: 8,
    weights: Array.from({ length: 36 }, () => 1.0),
    glyphs: [
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c => ({ char: c, mirror: false })),
      ...'0123456789'.split('').map(c => ({ char: c, mirror: false })),
    ],
  },

  /**
   * ascii — all 95 printable ASCII characters (U+0020–U+007E).
   * Requires a 10×10 grid (100 slots, 5 unused) and the uAtlasGridW/H shader fix.
   * Uniform weights (all 1.0) — no complexity bias for ASCII characters.
   */
  ascii: {
    gridW: 10, gridH: 10,
    weights: Array.from({ length: 95 }, () => 1.0),
    glyphs: Array.from({ length: 95 }, (_, i) => ({
      char: String.fromCharCode(0x20 + i),
      mirror: false,
    })),
  },
};
