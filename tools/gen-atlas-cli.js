/**
 * gen-atlas-cli.js — MTSDF atlas generator for matrix-rain-webgpu.
 *
 * Uses the msdf-atlas-gen binary (bundled in node_modules/msdf-atlas-gen/bin/)
 * to generate per-set MTSDF atlases and composes them into fixed-grid PNGs.
 *
 * Usage:
 *   node tools/gen-atlas-cli.js [--set <name>|all] [--size <px>]
 *
 * Output: data/<set>_msdf.png  (RGBA MTSDF, 4-channel)
 *
 * TODO: For even higher quality, evaluate msdf-atlas-gen v2+ WASM API once
 * it exposes MTSDF support natively without requiring the C++ binary.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createCanvas, loadImage } from 'canvas';
import { fileURLToPath } from 'node:url';

// ── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const DATA_DIR  = join(ROOT, 'data');
const FONTS_DIR = join(DATA_DIR, 'fonts');
const BIN_PATH  = join(ROOT, 'node_modules', 'msdf-atlas-gen', 'bin',
  `msdf-atlas-gen-${process.platform}`);

// ── Set → font mapping ───────────────────────────────────────────────────────

const FONT_MAP = {
  matrix1999: join(FONTS_DIR, 'noto', 'NotoSansJP-Regular.ttf'),
  latin:      join(FONTS_DIR, 'Google_Sans_Code', 'static', 'GoogleSansCode-Regular.ttf'),
  ascii:      join(FONTS_DIR, 'Iosevka_Charon_Mono', 'IosevkaCharonMono-Regular.ttf'),
  cyber:      join(FONTS_DIR, 'noto', 'NotoSansJP-Regular.ttf'),
  cyrillic:   join(FONTS_DIR, 'Iosevka_Charon_Mono', 'IosevkaCharonMono-Regular.ttf'),
  japanese:   join(FONTS_DIR, 'noto', 'NotoSansJP-Regular.ttf'),
  chinese:    join(FONTS_DIR, 'noto', 'NotoSansTC-Regular.ttf'),
  orbitron:   join(FONTS_DIR, 'Orbitron', 'static', 'Orbitron-Bold.ttf'),
  iosevka:    join(FONTS_DIR, 'Iosevka_Charon_Mono', 'IosevkaCharonMono-Regular.ttf'),
  datatype:   join(FONTS_DIR, 'Datatype', 'static', 'Datatype-Regular.ttf'),
  gsanscode:  join(FONTS_DIR, 'Google_Sans_Code', 'static', 'GoogleSansCode-Regular.ttf'),
};

const ALL_SETS = Object.keys(FONT_MAP);

// ── CLI args ─────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const setIdx  = args.indexOf('--set');
const sizeIdx = args.indexOf('--size');
const setArg  = setIdx !== -1 ? (args[setIdx + 1] ?? 'all') : 'all';
const sizeArg = sizeIdx !== -1 ? parseInt(args[sizeIdx + 1] ?? '48', 10) : 48;
const CELL_PX = 64;  // fixed grid cell size in pixels

const setsToRun = setArg === 'all' ? ALL_SETS : [setArg];

// ── Validate binary ───────────────────────────────────────────────────────────

if (!existsSync(BIN_PATH)) {
  console.error(`[gen-atlas] Binary not found: ${BIN_PATH}`);
  console.error(`  Expected platform binary: msdf-atlas-gen-${process.platform}`);
  process.exit(1);
}

try {
  execFileSync('chmod', ['+x', BIN_PATH]);
} catch { /* ignore chmod errors */ }

// ── Load glyph set definitions ────────────────────────────────────────────────

const { GLYPH_SETS } = await import('../data/glyph-sets.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Write a charset file listing Unicode codepoints for the binary.
 * Format: one hex codepoint per line (0x0041).
 * Custom path glyphs are skipped (handled separately via canvas).
 * @returns {string[]} codepoints included
 */
function writeCharsetFile(glyphs, outPath) {
  const lines = [];
  for (const g of glyphs) {
    if (!g.char) continue;
    const cp = g.char.codePointAt(0);
    lines.push(`0x${cp.toString(16).toUpperCase().padStart(4, '0')}`);
  }
  writeFileSync(outPath, lines.join('\n'));
  return lines;
}

/**
 * Run the msdf-atlas-gen binary and return { atlasPath, jsonPath }.
 * The atlas is packed (not grid-ordered); use the JSON to remap glyphs.
 */
function runBinary(fontPath, charsetPath, { size = 48, pxRange = 4 } = {}) {
  const tmpId    = randomUUID();
  const atlasOut = join(tmpdir(), `${tmpId}.png`);
  const jsonOut  = join(tmpdir(), `${tmpId}.json`);

  const binaryArgs = [
    '-font',     fontPath,
    '-charset',  charsetPath,
    '-type',     'mtsdf',
    '-format',   'png',
    '-size',     String(size),
    '-pxrange',  String(pxRange),
    '-square',                    // pack into smallest square that fits all glyphs
    '-imageout', atlasOut,
    '-json',     jsonOut,
  ];

  execFileSync(BIN_PATH, binaryArgs, { stdio: 'inherit' });
  return { atlasOut, jsonOut };
}

/**
 * Given a glyph's planeBounds (fractional, 0=baseline) and advance, compute
 * the centered destination rectangle within a CELL_PX × CELL_PX cell.
 *
 * MTSDF atlases use bottom-origin. atlasBounds coordinates are in pixels
 * with y=0 at image bottom — convert to top-origin for canvas drawImage.
 *
 * @param {object} atlasGlyph  entry from binary JSON { atlasBounds, planeBounds, advance }
 * @param {number} atlasH      total atlas image height in pixels
 * @returns {{ sx, sy, sw, sh }}  source rect in binary atlas (canvas/top-origin coords)
 */
function srcRect(atlasGlyph, atlasH) {
  const b  = atlasGlyph.atlasBounds;
  const sx = Math.floor(b.left);
  const sy = Math.floor(atlasH - b.top);   // flip y: top-origin
  const sw = Math.ceil(b.right) - sx;
  const sh = Math.ceil(b.top) - Math.floor(b.bottom);
  return { sx, sy, sw, sh };
}

/**
 * Render a custom path-drawn glyph (from glyph-sets.js path definition) to
 * a CELL_PX × CELL_PX canvas using an EDT-based MTSDF approximation.
 * R=G=B=A=SDF (single-channel; corner preservation is not available via
 * canvas 2D — this is the best achievable without the binary).
 *
 * @param {object} pathDef  { path: [...cmds], stroke, strokeWidth }
 * @returns {Canvas}
 */
function renderPathGlyph(pathDef) {
  const SIZE   = CELL_PX;
  const canvas = createCanvas(SIZE, SIZE);
  const ctx    = canvas.getContext('2d');

  ctx.fillStyle   = '#000';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.strokeStyle = '#fff';
  ctx.fillStyle   = '#fff';
  ctx.lineWidth   = pathDef.strokeWidth ?? 5;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';

  ctx.beginPath();
  for (const cmd of pathDef.path) {
    switch (cmd[0]) {
      case 'M': ctx.moveTo(cmd[1] * SIZE, cmd[2] * SIZE); break;
      case 'L': ctx.lineTo(cmd[1] * SIZE, cmd[2] * SIZE); break;
      case 'C': ctx.bezierCurveTo(
        cmd[1] * SIZE, cmd[2] * SIZE,
        cmd[3] * SIZE, cmd[4] * SIZE,
        cmd[5] * SIZE, cmd[6] * SIZE); break;
      case 'Q': ctx.quadraticCurveTo(
        cmd[1] * SIZE, cmd[2] * SIZE,
        cmd[3] * SIZE, cmd[4] * SIZE); break;
      case 'Z': ctx.closePath(); break;
    }
  }
  if (pathDef.stroke) {
    ctx.stroke();
  } else {
    ctx.fill();
  }

  // Approximate EDT-based SDF: erode/dilate luminance into a distance field.
  // Stored as R=G=B=A so it degrades gracefully under the MTSDF blend formula.
  const imgData = ctx.getImageData(0, 0, SIZE, SIZE);
  const pix     = imgData.data;
  const INF     = SIZE * SIZE;

  // Build binary mask from luminance
  const mask = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    mask[i] = pix[i * 4] > 127 ? 1 : 0;  // r channel as luminance proxy
  }

  // Brute-force EDT (acceptable for 64×64 cells)
  const distSq = new Float32Array(SIZE * SIZE).fill(INF);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!mask[y * SIZE + x]) continue;
      for (let ny = Math.max(0, y - 16); ny < Math.min(SIZE, y + 16); ny++) {
        for (let nx = Math.max(0, x - 16); nx < Math.min(SIZE, x + 16); nx++) {
          const d = (nx - x) ** 2 + (ny - y) ** 2;
          if (d < distSq[ny * SIZE + nx]) distSq[ny * SIZE + nx] = d;
        }
      }
    }
  }

  const SPREAD = 8.0;
  for (let i = 0; i < SIZE * SIZE; i++) {
    const d    = Math.sqrt(distSq[i]);
    const sdf  = mask[i]
      ? 0.5 + 0.5 * Math.min(d / SPREAD, 1.0)   // inside: 0.5–1.0
      : 0.5 - 0.5 * Math.min(d / SPREAD, 1.0);  // outside: 0.5–0.0
    const byte = Math.round(sdf * 255);
    pix[i * 4 + 0] = byte;
    pix[i * 4 + 1] = byte;
    pix[i * 4 + 2] = byte;
    pix[i * 4 + 3] = byte;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

// ── Main per-set generation ───────────────────────────────────────────────────

async function generateSet(name, opts = {}) {
  const setDef   = GLYPH_SETS[name];
  const fontPath = FONT_MAP[name];

  if (!setDef) {
    console.error(`[gen-atlas] Unknown set '${name}'. Valid: ${ALL_SETS.join(', ')}`);
    process.exit(1);
  }
  if (!existsSync(fontPath)) {
    console.error(`[gen-atlas] Font file not found for '${name}': ${fontPath}`);
    console.error(`  See tools/README.md for font installation instructions.`);
    process.exit(1);
  }

  const { gridW, gridH, glyphs } = setDef;
  const atlasW = gridW * CELL_PX;
  const atlasH = gridH * CELL_PX;

  console.log(`\n[gen-atlas] Generating '${name}' (${gridW}×${gridH}, ${glyphs.length} glyphs) ...`);

  // Separate text glyphs from custom path glyphs
  const textGlyphs = glyphs.filter(g => g.char);
  const pathGlyphs = glyphs.map((g, i) => g.path ? { idx: i, def: g } : null).filter(Boolean);

  // Generate MTSDF atlas from binary for text glyphs
  const tmpCharset = join(tmpdir(), `${randomUUID()}.txt`);
  writeCharsetFile(textGlyphs, tmpCharset);

  const { atlasOut, jsonOut } = runBinary(fontPath, tmpCharset, {
    size:    opts.size ?? sizeArg,
    pxRange: 4,
  });

  // Load binary output
  const binaryAtlas = await loadImage(atlasOut);
  const binaryJson  = JSON.parse(readFileSync(jsonOut, 'utf8'));

  // Build codepoint → glyph data map from binary JSON
  const cpMap = new Map();
  for (const g of binaryJson.glyphs) {
    cpMap.set(g.unicode, g);
  }

  // Build output fixed-grid atlas canvas
  const outCanvas = createCanvas(atlasW, atlasH);
  const outCtx    = outCanvas.getContext('2d');
  outCtx.fillStyle = 'rgba(0,0,0,0)';
  outCtx.fillRect(0, 0, atlasW, atlasH);

  // Temporary canvas for drawing from binary atlas (canvas drawImage needs HTMLImageElement or Canvas)
  const srcCanvas = createCanvas(binaryAtlas.width, binaryAtlas.height);
  const srcCtx    = srcCanvas.getContext('2d');
  srcCtx.drawImage(binaryAtlas, 0, 0);

  const bH = binaryAtlas.height;

  for (let i = 0; i < glyphs.length; i++) {
    const g    = glyphs[i];
    const cellX = (i % gridW) * CELL_PX;
    const cellY = Math.floor(i / gridW) * CELL_PX;

    if (g.path) {
      // Custom path glyph — render via canvas EDT approximation
      const pathCanvas = renderPathGlyph(g);
      outCtx.drawImage(pathCanvas, cellX, cellY);
    } else if (g.char) {
      const cp    = g.char.codePointAt(0);
      const binG  = cpMap.get(cp);
      if (!binG || !binG.atlasBounds) {
        console.warn(`  [warn] Glyph ${g.char} (U+${cp.toString(16).toUpperCase()}) not found in binary atlas — leaving blank`);
        continue;
      }

      const { sx, sy, sw, sh } = srcRect(binG, bH);
      if (sw <= 0 || sh <= 0) continue;

      // Center the source glyph within the CELL_PX × CELL_PX cell
      const destX = cellX + Math.round((CELL_PX - sw) / 2);
      const destY = cellY + Math.round((CELL_PX - sh) / 2);

      outCtx.drawImage(srcCanvas, sx, sy, sw, sh, destX, destY, sw, sh);
    }
    // unused slots (beyond glyphs.length) remain transparent
  }

  // Save
  const outPath = join(DATA_DIR, `${name}_msdf.png`);
  const buf     = outCanvas.toBuffer('image/png');
  writeFileSync(outPath, buf);
  console.log(`[gen-atlas] Saved ${outPath} (${atlasW}×${atlasH})`);
}

// ── Run ───────────────────────────────────────────────────────────────────────

for (const name of setsToRun) {
  if (!FONT_MAP[name]) {
    console.error(`[gen-atlas] No font mapping for set '${name}'. Known sets: ${ALL_SETS.join(', ')}`);
    process.exit(1);
  }
  await generateSet(name);
}

console.log('\n[gen-atlas] Done.');
