// Radial line-of-sight viewshed for a ground observer (a lookout, staging area,
// or person) watching the surrounding terrain for a wildfire.
//
// The observer eye sits at ground + eyeHeight. The thing we want to keep in sight
// is GROUND-level fire/smoke at a distant ridge or fire front: the target sits at
// the destination cell's ground height plus a small flame/smoke allowance, NOT a
// flying drone. A sightline is blocked by the occluder surface `zc`: bare terrain
// plus the effective vegetation canopy height (tall trees wall off the view to a
// distant fire). Classic R2 sweep: march each ray outward tracking the running
// max elevation angle of the occluders, and test the ground target against it.

const TWO_PI = Math.PI * 2;
const FLAME_HEIGHT = 5; // metres of flame/smoke the target stands above the ground

// Scalar score of a candidate observer position. Accumulates, over every visible
// cell within range:
//   visArea - importance-weighted count. If g.weight is present (fire-prone
//             importance grid) we add weight[idx] so seeing dangerous ground
//             counts most (lookout/fire-watch mode). Otherwise we fall back to
//             near-weighting (closer ground counts more).
//   cells - raw covered cell count (for the coverage-% reason string)
export function observeScore(g, ox, oy, p) {
  const { gridW, gridH, heights, zc, metersPerPx, weight } = g;
  const eyeZ = heights[oy * gridW + ox] + p.eyeHeight;
  const rangeCells = p.maxRange / metersPerPx;
  const nRays = p.rays;

  let visArea = 0, cells = 0;

  for (let a = 0; a < nRays; a++) {
    const ang = (a / nRays) * TWO_PI;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    let maxSlope = -Infinity;
    for (let t = 1; t <= rangeCells; t++) {
      const fx = ox + dx * t, fy = oy + dy * t;
      const ix = fx | 0, iy = fy | 0;
      if (ix < 0 || iy < 0 || ix >= gridW || iy >= gridH) break;
      const idx = iy * gridW + ix;
      const dist = t * metersPerPx;
      // target is ground + a small flame/smoke height at this cell
      const targetSlope = (heights[idx] + FLAME_HEIGHT - eyeZ) / dist;
      if (targetSlope >= maxSlope) {
        const near = 1 - t / rangeCells;
        visArea += weight ? weight[idx] : near;
        cells++;
      }
      // occluder rises from the bare terrain plus the vegetation canopy
      const occSlope = (zc[idx] - eyeZ) / dist;
      if (occSlope > maxSlope) maxSlope = occSlope;
    }
  }

  return { visArea, cells };
}

// Accurate covered-cell footprint for a single observer position (for the map
// overlay) plus the covered fraction of the in-range disc. Unlike the radial
// sweep above (fast, fine for relative ranking), this tests EVERY cell in the
// disc with its own line-of-sight march to the ground target, so the footprint is
// dense and the percentage is real. Only run for the winning spots.
export function observeFootprint(g, ox, oy, p) {
  const { gridW, gridH, heights, zc, metersPerPx } = g;
  const eyeZ = heights[oy * gridW + ox] + p.eyeHeight;
  const rangeCells = p.maxRange / metersPerPx;
  const r2 = rangeCells * rangeCells;
  const vis = new Uint8Array(gridW * gridH);
  const rc = Math.ceil(rangeCells);

  let seen = 0, inDisc = 0;
  const c0 = Math.max(0, ox - rc), c1 = Math.min(gridW - 1, ox + rc);
  const r0 = Math.max(0, oy - rc), r1 = Math.min(gridH - 1, oy + rc);

  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const ddx = c - ox, ddy = r - oy;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 > r2) continue;
      inDisc++;
      if (d2 === 0) { vis[r * gridW + c] = 1; seen++; continue; }

      const targetDist = Math.sqrt(d2);
      const steps = Math.max(1, Math.round(targetDist));
      // target = ground + flame/smoke height at this cell
      const targetSlope = (heights[r * gridW + c] + FLAME_HEIGHT - eyeZ) / (targetDist * metersPerPx);
      let blocked = false;
      // walk the intermediate cells; an occluder hides the target only if it rises
      // above the eye->target line, measured at the occluder's OWN distance (not
      // the parametric step) so the angle comparison is exact.
      for (let s = 1; s < steps; s++) {
        const fx = ox + (ddx * s) / steps;
        const fy = oy + (ddy * s) / steps;
        const ix = fx | 0, iy = fy | 0;
        const od = Math.hypot(ix - ox, iy - oy);
        if (od < 0.5 || od >= targetDist - 0.5) continue;
        const occSlope = (zc[iy * gridW + ix] - eyeZ) / (od * metersPerPx);
        if (occSlope > targetSlope + 1e-6) { blocked = true; break; }
      }
      if (!blocked) { vis[r * gridW + c] = 1; seen++; }
    }
  }
  return { vis, seen, visiblePercent: inDisc ? seen / inDisc : 0 };
}
