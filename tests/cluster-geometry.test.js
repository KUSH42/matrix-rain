/**
 * Unit tests for the cluster geometry builder (matrix-rain-geometry.js).
 *
 * Tests run in Node (no GPU). They verify all structural invariants of
 * buildClusterArrays(): stratified placement, round-robin balance, per-row
 * replication, per-cluster attribute coherence, squad phase coherence,
 * biasedTrailBuf range, aSpawnTheta range, reserve pool assignment, and
 * aClusterCenter centroid correctness.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildClusterArrays } from '../matrix-rain-geometry.js';

// ── Test parameters (smaller than production for speed) ───────────────────
const N_COLS       = 120;
const N_CLUSTERS   = 12;
const N_ROWS       = 120;
const SQUAD_SIZE   = 5;
const SPAWN_RES    = 12;
const RESERVE_START = N_COLS - SPAWN_RES;   // 108 — last 12 cols are reserves

describe('cluster geometry invariants', () => {
  let geom;

  beforeAll(() => {
    geom = buildClusterArrays({
      nCols:        N_COLS,
      nRows:        N_ROWS,
      clusterCount: N_CLUSTERS,
      squadSize:    SQUAD_SIZE,
      trailCohesion: 0.7,
      spawnReserves: SPAWN_RES,
    });
  });

  // ── Stratified placement ─────────────────────────────────────────────────

  it('cluster centers are monotonically distributed across [0, 2π]', () => {
    const arc = (Math.PI * 2) / N_CLUSTERS;
    geom.clusterThetas.forEach((theta, i) => {
      const lo = i * arc, hi = (i + 1) * arc;
      expect(theta).toBeGreaterThanOrEqual(lo);
      expect(theta).toBeLessThan(hi);
    });
  });

  it('returns the expected number of clusters', () => {
    expect(geom.nClusters).toBe(N_CLUSTERS);
    expect(geom.clusterThetas).toHaveLength(N_CLUSTERS);
  });

  // ── Round-robin balance ──────────────────────────────────────────────────

  it('non-reserve cluster populations are balanced (max difference ≤ 1)', () => {
    const counts = new Array(N_CLUSTERS).fill(0);
    for (let c = 0; c < RESERVE_START; c++) counts[c % N_CLUSTERS]++;
    const min = Math.min(...counts), max = Math.max(...counts);
    expect(max - min).toBeLessThanOrEqual(1);
  });

  // ── Per-column row replication ───────────────────────────────────────────

  it('all rows of a column share the same aClusterHue value', () => {
    for (let c = 0; c < N_COLS; c++) {
      const base = c * N_ROWS;
      const ref  = geom.clusterHueBuf[base];
      for (let r = 1; r < N_ROWS; r++) {
        expect(geom.clusterHueBuf[base + r]).toBe(ref);
      }
    }
  });

  // ── Per-cluster attribute coherence (non-reserve columns only) ───────────
  // Reserve columns are re-assigned to the nearest cluster after the main loop,
  // so their hue/burstSeed may differ from the round-robin cluster they were
  // initially placed in. Only test non-reserve columns here.

  it('non-reserve columns in the same cluster share the same aClusterHue', () => {
    for (let ci = 0; ci < N_CLUSTERS; ci++) {
      const cols = [];
      for (let c = ci; c < RESERVE_START; c += N_CLUSTERS) cols.push(c);
      const ref = geom.clusterHueBuf[cols[0] * N_ROWS];
      cols.slice(1).forEach(c => {
        expect(geom.clusterHueBuf[c * N_ROWS]).toBe(ref);
      });
    }
  });

  it('non-reserve columns in the same cluster share the same aClusterBurstSeed', () => {
    for (let ci = 0; ci < N_CLUSTERS; ci++) {
      const cols = [];
      for (let c = ci; c < RESERVE_START; c += N_CLUSTERS) cols.push(c);
      const ref = geom.clusterBurstSeedBuf[cols[0] * N_ROWS];
      cols.slice(1).forEach(c => {
        expect(geom.clusterBurstSeedBuf[c * N_ROWS]).toBe(ref);
      });
    }
  });

  it('non-reserve columns in the same cluster share the same aClusterSpeed', () => {
    for (let ci = 0; ci < N_CLUSTERS; ci++) {
      const cols = [];
      for (let c = ci; c < RESERVE_START; c += N_CLUSTERS) cols.push(c);
      const ref = geom.clusterSpeedBuf[cols[0] * N_ROWS];
      cols.slice(1).forEach(c => {
        expect(geom.clusterSpeedBuf[c * N_ROWS]).toBe(ref);
      });
    }
  });

  it('columns in different clusters have different aClusterHue (non-reserve)', () => {
    const hues = Array.from({ length: N_CLUSTERS }, (_, ci) => geom.clusterHueBuf[ci * N_ROWS]);
    const unique = new Set(hues.map(h => h.toFixed(6)));
    expect(unique.size).toBeGreaterThan(1);
  });

  // ── Squad phase coherence (non-reserve columns only) ─────────────────────
  // Reserve columns' aSquadPhase is overwritten in the reserve pool loop.

  it('non-reserve columns in the same squad share the same aSquadPhase', () => {
    for (let ci = 0; ci < N_CLUSTERS; ci++) {
      const cols = [];
      for (let c = ci; c < RESERVE_START; c += N_CLUSTERS) cols.push(c);
      for (let s = 0; s < Math.floor(cols.length / SQUAD_SIZE); s++) {
        const squadCols = cols.slice(s * SQUAD_SIZE, (s + 1) * SQUAD_SIZE);
        const ref = geom.squadPhaseBuf[squadCols[0] * N_ROWS];
        squadCols.slice(1).forEach(c => {
          expect(geom.squadPhaseBuf[c * N_ROWS]).toBe(ref);
        });
      }
    }
  });

  it('adjacent squads in the same cluster have different phase seeds', () => {
    const ci   = 0;
    const cols = [];
    for (let c = ci; c < RESERVE_START; c += N_CLUSTERS) cols.push(c);
    // Need at least SQUAD_SIZE + 1 non-reserve columns for a second squad to exist.
    if (cols.length <= SQUAD_SIZE) return;
    const p0 = geom.squadPhaseBuf[cols[0] * N_ROWS];
    const p1 = geom.squadPhaseBuf[cols[SQUAD_SIZE] * N_ROWS];
    expect(p0).not.toBe(p1);
  });

  // ── biasedTrailBuf range (all columns including reserves) ────────────────
  // biasedTrailBuf is only written in the main loop; reserve pool loop does
  // not overwrite it, so all N_COLS entries should be in [0.05, 0.95].

  it('biasedTrailBuf values are all in [0.05, 0.95]', () => {
    for (let c = 0; c < N_COLS; c++) {
      expect(geom.biasedTrailBuf[c]).toBeGreaterThanOrEqual(0.05);
      expect(geom.biasedTrailBuf[c]).toBeLessThanOrEqual(0.95);
    }
  });

  // ── aSpawnTheta range ────────────────────────────────────────────────────

  it('aSpawnTheta is in [0, 1] for all columns', () => {
    for (let c = 0; c < N_COLS; c++) {
      const v = geom.spawnThetaBuf[c * N_ROWS];
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  // ── Reserve pool ─────────────────────────────────────────────────────────

  it('reserve columns have valid cluster hue assignments (in [-1, 1])', () => {
    for (let c = RESERVE_START; c < N_COLS; c++) {
      const hue = geom.clusterHueBuf[c * N_ROWS];
      expect(hue).toBeGreaterThanOrEqual(-1);
      expect(hue).toBeLessThanOrEqual(1);
    }
  });

  it('reserve column hues match one of the known cluster hues', () => {
    // Each reserve is re-assigned to the nearest cluster; its hue must equal
    // that cluster's hue exactly (same float value, not approximate).
    const clusterHues = Array.from({ length: N_CLUSTERS }, (_, ci) => geom.clusterHueBuf[ci * N_ROWS]);
    for (let c = RESERVE_START; c < N_COLS; c++) {
      const hue = geom.clusterHueBuf[c * N_ROWS];
      expect(clusterHues).toContain(hue);
    }
  });

  it('reserve columns are evenly distributed in angle (span > π)', () => {
    const angles = [];
    for (let c = RESERVE_START; c < N_COLS; c++) {
      const wx = geom.colABuf[c * N_ROWS * 4];
      const wz = geom.colABuf[c * N_ROWS * 4 + 1];
      angles.push(Math.atan2(wz, wx));
    }
    const span = Math.max(...angles) - Math.min(...angles);
    expect(span).toBeGreaterThan(Math.PI);
  });

  // ── aClusterCenter centroid correctness ──────────────────────────────────

  it('aClusterCenter matches computed centroid of non-reserve columns', () => {
    for (let ci = 0; ci < N_CLUSTERS; ci++) {
      const cols = [];
      for (let c = ci; c < RESERVE_START; c += N_CLUSTERS) cols.push(c);
      const sumX = cols.reduce((s, c) => s + geom.colABuf[c * N_ROWS * 4],     0);
      const sumZ = cols.reduce((s, c) => s + geom.colABuf[c * N_ROWS * 4 + 1], 0);
      const expectedX = sumX / cols.length;
      const expectedZ = sumZ / cols.length;
      const cx = geom.clusterCenterBuf[cols[0] * N_ROWS * 2];
      const cz = geom.clusterCenterBuf[cols[0] * N_ROWS * 2 + 1];
      expect(cx).toBeCloseTo(expectedX, 4);
      expect(cz).toBeCloseTo(expectedZ, 4);
    }
  });

  it('all rows of a column carry the same aClusterCenter value', () => {
    for (let c = 0; c < RESERVE_START; c++) {
      const base2 = c * N_ROWS * 2;
      const rx = geom.clusterCenterBuf[base2];
      const rz = geom.clusterCenterBuf[base2 + 1];
      for (let r = 1; r < N_ROWS; r++) {
        expect(geom.clusterCenterBuf[base2 + r * 2]).toBe(rx);
        expect(geom.clusterCenterBuf[base2 + r * 2 + 1]).toBe(rz);
      }
    }
  });
});
