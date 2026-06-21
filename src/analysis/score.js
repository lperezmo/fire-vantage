// Fire-vantage scoring: turn a built parcel (heights + fuel) plus the live fire
// layer and current wind into a spread-risk raster for the heatmap and a ranked
// set of points. What the points represent depends on ui.goalMode:
//   'safety'  - safest staging spots (low risk, far from spread, can see the fire)
//   'risk'    - the highest spread-risk cells (where it is most dangerous)
//   'lookout' - best fire-watch lookouts (max visibility of the fire-prone ground)
//
// Spread risk per cell blends three transparent factors: vegetation fuel load,
// slope (fire runs uphill), and wind alignment (fire runs downwind), all boosted
// by proximity to an active perimeter or hotspot.

import { observeScore, observeFootprint } from './viewshed.js';
import { buildFireProximity } from '../data/fires.js';

const TREE_HEIGHT = 16; // metres of mature canopy

// Effective sight-blocking canopy height for a fuel density 0..1. Density-gated
// so open ground and sparse cover stay see-through, while only closed canopy
// walls off the line-of-sight to a distant fire.
function effectiveCanopy(density) {
  const t = Math.max(0, Math.min(1, (density - 0.25) / 0.55));
  return t * t * TREE_HEIGHT;
}

// Build the derived layers the scorer needs: the occlusion surface (terrain +
// canopy) for the viewshed, plus a summed-area table for fast local prominence.
function deriveLayers(parcel) {
  const { gridW, gridH, heights, fuel } = parcel;
  const n = gridW * gridH;
  const zc = new Float32Array(n);
  for (let i = 0; i < n; i++) zc[i] = heights[i] + effectiveCanopy(fuel[i] / 255);

  // summed-area table of heights for O(1) local mean (prominence)
  const sat = new Float64Array((gridW + 1) * (gridH + 1));
  const sw = gridW + 1;
  for (let r = 0; r < gridH; r++) {
    let rowSum = 0;
    for (let c = 0; c < gridW; c++) {
      rowSum += heights[r * gridW + c];
      sat[(r + 1) * sw + (c + 1)] = sat[r * sw + (c + 1)] + rowSum;
    }
  }
  const localMean = (c, r, rad) => {
    const c0 = Math.max(0, c - rad), c1 = Math.min(gridW - 1, c + rad);
    const r0 = Math.max(0, r - rad), r1 = Math.min(gridH - 1, r + rad);
    const area = (c1 - c0 + 1) * (r1 - r0 + 1);
    const s = sat[(r1 + 1) * sw + (c1 + 1)] - sat[r0 * sw + (c1 + 1)] - sat[(r1 + 1) * sw + c0] + sat[r0 * sw + c0];
    return s / area;
  };

  return { zc, localMean };
}

function normalize(arr) {
  let min = Infinity, max = -Infinity;
  for (const v of arr) { if (v < min) min = v; if (v > max) max = v; }
  const span = max - min || 1;
  return (v) => (v - min) / span;
}

// Local terrain slope (degrees) at a grid cell.
function slopeDegAt(heights, gridW, gridH, c, r, mpp) {
  const cl = Math.max(c - 1, 0), cr = Math.min(c + 1, gridW - 1);
  const ru = Math.max(r - 1, 0), rd = Math.min(r + 1, gridH - 1);
  const dx = (heights[r * gridW + cr] - heights[r * gridW + cl]) / ((cr - cl) * mpp);
  const dz = (heights[rd * gridW + c] - heights[ru * gridW + c]) / ((rd - ru) * mpp);
  return (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
}

// Signed terrain gradient (metres rise per metre run) at a cell, returned as the
// uphill direction unit-ish vector components du,dv in grid space (east, south)
// plus the slope magnitude in degrees. du>0 means ground rises to the east; dv>0
// means ground rises to the south (toward higher row index).
function gradientAt(heights, gridW, gridH, c, r, mpp) {
  const cl = Math.max(c - 1, 0), cr = Math.min(c + 1, gridW - 1);
  const ru = Math.max(r - 1, 0), rd = Math.min(r + 1, gridH - 1);
  // east-positive, south-positive (matches grid: col+ = east, row+ = south)
  const ge = (heights[r * gridW + cr] - heights[r * gridW + cl]) / ((cr - cl) * mpp);
  const gs = (heights[rd * gridW + c] - heights[ru * gridW + c]) / ((rd - ru) * mpp);
  const mag = Math.hypot(ge, gs);
  const slopeDeg = (Math.atan(mag) * 180) / Math.PI;
  return { ge, gs, mag, slopeDeg };
}

// Mean fuel density (0..1) in a small box around a cell.
function localFuel(fuel, gridW, gridH, c, r, rad) {
  const c0 = Math.max(0, c - rad), c1 = Math.min(gridW - 1, c + rad);
  const r0 = Math.max(0, r - rad), r1 = Math.min(gridH - 1, r + rad);
  let sum = 0, n = 0;
  for (let rr = r0; rr <= r1; rr++) {
    for (let cc = c0; cc <= c1; cc++) { sum += fuel[rr * gridW + cc]; n++; }
  }
  return n ? sum / n / 255 : 0;
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function analyze(parcel, ui, fire, wind) {
  const { gridW, gridH, heights, fuel, metersPerPx, bbox } = parcel;
  const goalMode = ui.goalMode || 'safety';
  const { zc, localMean } = deriveLayers(parcel);

  // weights (UI gives 0..100; renormalise to sum 1)
  const wRaw = ui.weights || { spread: 25, los: 20, fuel: 20, ground: 20, slope: 15 };
  const wSum = Object.values(wRaw).reduce((a, b) => a + b, 0) || 1;
  const w = {};
  for (const k in wRaw) w[k] = wRaw[k] / wSum;

  // wind "to" unit vector in grid space. Meteorological dir is the direction wind
  // comes FROM, so the direction it blows TO is dir+180. Convert compass degrees
  // (0=N, 90=E) into grid components: east-positive, south-positive.
  //   toRad measured from north, clockwise. east comp = sin(toRad),
  //   north comp = cos(toRad); grid south-positive means dv = -north comp.
  let windTo = null;
  if (ui.useWind && wind && Number.isFinite(wind.dirDeg)) {
    const toDeg = (wind.dirDeg + 180) % 360;
    const toRad = (toDeg * Math.PI) / 180;
    const east = Math.sin(toRad);
    const north = Math.cos(toRad);
    windTo = { du: east, dv: -north }; // dv south-positive
  }

  // fire proximity grid at full resolution (1 on/inside a perimeter or hotspot)
  const fireProx = buildFireProximity(parcel, fire);

  // --- full-resolution spread-risk and the per-cell importance weight grid ---
  // risk = fuel * (1 + slopeFactor) * (1 + windAlignFactor), boosted by fireProx.
  // slopeFactor: steeper ground spreads fire faster (capped). windAlignFactor: a
  // cell is riskier when the wind blows uphill across it (wind and the uphill
  // direction agree), pushing flame into fresh upslope fuel.
  const riskFull = new Float32Array(gridW * gridH);
  for (let r = 0; r < gridH; r++) {
    for (let c = 0; c < gridW; c++) {
      const i = r * gridW + c;
      const f = fuel[i] / 255;
      const grad = gradientAt(heights, gridW, gridH, c, r, metersPerPx);
      // slopeFactor 0..~1.2: rule-of-thumb fire speed roughly doubles per ~20 deg
      const slopeFactor = Math.min(1.2, grad.slopeDeg / 20);

      // windAlignFactor 0..1: alignment of wind-to vector with the uphill
      // direction. Uphill vector is -gradient (gradient points downhill in our
      // east/south convention since positive ge means rising east).
      let windAlign = 0;
      if (windTo && grad.mag > 1e-4) {
        const upE = grad.ge / grad.mag; // uphill points toward higher ground
        const upS = grad.gs / grad.mag;
        const dot = windTo.du * upE + windTo.dv * upS; // -1..1
        const speedScale = Math.min(1, (wind.speedMph || 0) / 25);
        windAlign = Math.max(0, dot) * speedScale;
      }

      let risk = f * (1 + slopeFactor) * (1 + windAlign);
      // boost by proximity to active fire: on/adjacent to a perimeter is max risk
      risk = risk * (1 + 1.5 * fireProx[i]) + 0.6 * fireProx[i];
      riskFull[i] = risk;
    }
  }
  const nRiskFull = normalize(riskFull);

  // importance weight grid for the lookout viewshed: normalized blend of fire
  // proximity and fuel, so "seeing fire-prone ground" counts (perimeters/hotspots
  // weighted highest, then heavy-fuel ground).
  const weightGrid = new Float32Array(gridW * gridH);
  for (let i = 0; i < weightGrid.length; i++) {
    weightGrid[i] = 0.6 * fireProx[i] + 0.4 * (fuel[i] / 255);
  }

  const g = { gridW, gridH, heights, zc, metersPerPx };
  const gWeighted = { gridW, gridH, heights, zc, metersPerPx, weight: weightGrid };

  const p = {
    eyeHeight: ui.eyeHeight,
    maxRange: ui.maxRange,
    rays: 96,
  };

  // candidate grid (subsampled to keep the work bounded)
  const stride = Math.max(1, Math.round(Math.sqrt((gridW * gridH) / 2600)));
  const cgW = Math.floor((gridW - 1) / stride) + 1;
  const cgH = Math.floor((gridH - 1) / stride) + 1;
  const promRad = Math.min(60, Math.max(6, Math.round(280 / metersPerPx)));
  const fuelRad = Math.min(8, Math.max(2, Math.round(40 / metersPerPx)));

  const lonOf = (col) => bbox.west + (gridW <= 1 ? 0 : (col / (gridW - 1)) * (bbox.east - bbox.west));
  const latOf = (row) => bbox.north + (gridH <= 1 ? 0 : (row / (gridH - 1)) * (bbox.south - bbox.north));

  // nearest active fire distance (km) from a candidate cell, over hotspots AND
  // perimeter vertices (equirectangular approx, same as fires.js).
  const perims = (fire && fire.perimeters && fire.perimeters.features) || [];
  const hotspots = (fire && fire.hotspots) || [];
  const nearestFireKm = (ox, oy) => {
    if (!perims.length && !hotspots.length) return Infinity;
    const clon = lonOf(ox), clat = latOf(oy);
    const mPerDegLat = 111_320;
    let best = Infinity;
    for (const h of hotspots) {
      if (!Number.isFinite(h.lon) || !Number.isFinite(h.lat)) continue;
      const mPerDegLon = 111_320 * Math.cos((((clat + h.lat) / 2) * Math.PI) / 180);
      const dx = (h.lon - clon) * mPerDegLon;
      const dy = (h.lat - clat) * mPerDegLat;
      const d = Math.hypot(dx, dy);
      if (d < best) best = d;
    }
    for (const f of perims) {
      const ring = f && f.geometry &&
        (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates[0] && f.geometry.coordinates[0][0] : f.geometry.coordinates && f.geometry.coordinates[0]);
      if (!ring) continue;
      for (const pt of ring) {
        const mPerDegLon = 111_320 * Math.cos((((clat + pt[1]) / 2) * Math.PI) / 180);
        const dx = (pt[0] - clon) * mPerDegLon;
        const dy = (pt[1] - clat) * mPerDegLat;
        const d = Math.hypot(dx, dy);
        if (d < best) best = d;
      }
    }
    return Number.isFinite(best) ? best / 1000 : Infinity;
  };

  // --- per-candidate factor layers ---
  const losA = new Float32Array(cgW * cgH);   // visibility of fire-prone ground
  const riskA = new Float32Array(cgW * cgH);  // local spread risk
  const fuelOpenA = new Float32Array(cgW * cgH); // open, low-fuel ground (0..1)
  const groundA = new Float32Array(cgW * cgH);   // level, low-fuel staging pad (0..1)
  const slopeSafeA = new Float32Array(cgW * cgH);// off the upslope/downwind path (0..1)
  const farA = new Float32Array(cgW * cgH);   // distance from active fire (0..1)
  const promA = new Float32Array(cgW * cgH);  // prominence (m above surroundings)
  const nearFireKmA = new Float32Array(cgW * cgH);

  // distances normalized over the parcel diagonal (km) for the "far" factor
  const diagKm = (Math.hypot(gridW, gridH) * metersPerPx) / 1000;

  for (let cy = 0; cy < cgH; cy++) {
    for (let cx = 0; cx < cgW; cx++) {
      const ox = Math.min(cx * stride, gridW - 1);
      const oy = Math.min(cy * stride, gridH - 1);
      const i = oy * gridW + ox;
      const ci = cy * cgW + cx;

      // visibility weighted by fire-prone importance (seeing dangerous ground)
      const o = observeScore(gWeighted, ox, oy, p);
      losA[ci] = o.visArea;

      // local spread risk at the candidate (normalized full-res value)
      riskA[ci] = nRiskFull(riskFull[i]);

      const slope = slopeDegAt(heights, gridW, gridH, ox, oy, metersPerPx);
      const fOpen = 1 - Math.min(1, localFuel(fuel, gridW, gridH, ox, oy, fuelRad) * 1.3);
      fuelOpenA[ci] = fOpen;

      const slopeOk = Math.max(0, Math.min(1, (18 - slope) / 18));
      groundA[ci] = 0.55 * slopeOk + 0.45 * fOpen;

      // off the spread path: low local risk = not on the upslope/downwind run
      slopeSafeA[ci] = 1 - riskA[ci];

      // far from active fire
      const fkm = nearestFireKm(ox, oy);
      nearFireKmA[ci] = fkm;
      farA[ci] = Number.isFinite(fkm) ? Math.min(1, fkm / Math.max(0.5, diagKm)) : 1;

      promA[ci] = heights[i] - localMean(ox, oy, promRad);
    }
  }

  const nLos = normalize(losA), nProm = normalize(promA), nRiskA = normalize(riskA);

  // --- compose the candidate score by goal mode ---
  const score = new Float32Array(cgW * cgH);
  for (let i = 0; i < score.length; i++) {
    if (goalMode === 'risk') {
      // pure spread risk: most dangerous cells rank highest
      score[i] = nRiskA(riskA[i]);
    } else if (goalMode === 'lookout') {
      // best fire-watch: maximize weighted visibility + prominence
      score[i] =
        (w.los + w.spread) * nLos(losA[i]) +
        w.slope * nProm(promA[i]) +
        (w.fuel + w.ground) * 0.5 * groundA[i];
    } else {
      // safety (default): low risk + far from spread + open level low-fuel ground
      // + good fire visibility + off the upslope/downwind path
      score[i] =
        w.spread * farA[i] +
        w.los * nLos(losA[i]) +
        w.fuel * fuelOpenA[i] +
        w.ground * groundA[i] +
        w.slope * slopeSafeA[i];
    }
  }

  // non-maximum suppression -> distinct top spots
  const spacing = Math.max(2, Math.round(160 / metersPerPx / stride));
  const order = Array.from(score.keys()).sort((a, b) => score[b] - score[a]);
  const picked = [];
  const taken = new Uint8Array(cgW * cgH);
  for (const idx of order) {
    if (picked.length >= 6) break;
    const cx = idx % cgW, cy = (idx / cgW) | 0;
    if (taken[idx]) continue;
    picked.push({ cx, cy, idx, s: score[idx] });
    for (let dy = -spacing; dy <= spacing; dy++) {
      for (let dx = -spacing; dx <= spacing; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && ny >= 0 && nx < cgW && ny < cgH) taken[ny * cgW + nx] = 1;
      }
    }
  }

  // detail pass on the winners: footprint + reasons
  const sMin = picked.length ? picked[picked.length - 1].s : 0;
  const sMax = picked.length ? picked[0].s : 1;
  const cellAcres = (metersPerPx * metersPerPx) / 4047;

  const spots = picked.map((pk, rank) => {
    const ox = Math.min(pk.cx * stride, gridW - 1);
    const oy = Math.min(pk.cy * stride, gridH - 1);
    const i = oy * gridW + ox;

    // footprint always run on the plain (near-weighted) surface so the cyan
    // overlay shows true line-of-sight; visibleFireAcres weights by importance.
    const fp = observeFootprint(g, ox, oy, p);
    let weightedSeen = 0;
    for (let k = 0; k < fp.vis.length; k++) if (fp.vis[k]) weightedSeen += weightGrid[k];
    const visibleFireAcres = Math.round(weightedSeen * cellAcres);

    const prom = heights[i] - localMean(ox, oy, promRad);
    const fkm = nearFireKmA[pk.idx];
    const localRisk = riskA[pk.idx];
    const fOpen = fuelOpenA[pk.idx];

    // why-text contributions, ranked by weighted value and goal mode
    let contrib;
    if (goalMode === 'risk') {
      const rPct = Math.round(localRisk * 100);
      contrib = [
        { v: localRisk, t: `high spread-risk ground (about ${rPct}% of peak risk here)` },
        { v: 1 - fOpen, t: 'heavy continuous fuel feeds the fire' },
        { v: Math.min(1, (slopeDegAt(heights, gridW, gridH, ox, oy, metersPerPx)) / 30), t: 'steep slope drives fire uphill fast' },
        { v: fireProx[i], t: fireProx[i] > 0.5 ? 'on or beside an active fire perimeter' : 'near active fire detections' },
      ].filter((x) => x.v > 0.05).sort((a, b) => b.v - a.v);
    } else if (goalMode === 'lookout') {
      contrib = [
        { v: w.los * nLos(losA[pk.idx]), t: `sees about ${visibleFireAcres} acres of fire-prone ground` },
        { v: w.slope * nProm(promA[pk.idx]), t: prom > 2 ? `sits ${Math.round(prom)} m above the surrounding ground` : 'reads the terrain well for a wide field of view' },
        { v: w.ground * groundA[pk.idx], t: 'open, accessible ground to set up a watch' },
      ].filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
    } else {
      contrib = [
        { v: w.spread * farA[pk.idx], t: Number.isFinite(fkm) ? `${fkm.toFixed(1)} km from the nearest active fire` : 'no active fire near this parcel' },
        { v: w.slope * slopeSafeA[pk.idx], t: 'off the upslope, downwind spread path' },
        { v: w.fuel * fOpen, t: 'open, low-fuel ground' },
        { v: w.ground * groundA[pk.idx], t: 'level, accessible staging pad' },
        { v: w.los * nLos(losA[pk.idx]), t: `can watch about ${visibleFireAcres} acres of fire-prone ground` },
      ].filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
    }

    const why = capitalize(contrib.slice(0, 3).map((x) => x.t).join(' / '));
    const rel = sMax > sMin ? (pk.s - sMin) / (sMax - sMin) : 1;
    const rating = Math.round(55 + rel * 44); // 55..99

    return {
      rank: rank + 1,
      lon: lonOf(ox), lat: latOf(oy),
      elevation: Math.round(heights[i]),
      rating,
      why,
      visibleFireAcres,
      nearestFireKm: fkm,
      footprint: fp.vis,
      ox, oy,
    };
  });

  // --- normalized spread-risk raster at candidate resolution for the heatmap ---
  const risk = new Float32Array(cgW * cgH);
  for (let cy = 0; cy < cgH; cy++) {
    for (let cx = 0; cx < cgW; cx++) {
      const ox = Math.min(cx * stride, gridW - 1);
      const oy = Math.min(cy * stride, gridH - 1);
      risk[cy * cgW + cx] = nRiskFull(riskFull[oy * gridW + ox]);
    }
  }

  return {
    gridW, gridH, cgW, cgH, stride,
    bbox, metersPerPx,
    heights, fuel,
    risk, spots,
    demZoom: parcel.demZoom,
    fire: {
      ok: !!(fire && fire.ok),
      perimeters: (fire && fire.perimeters) || { type: 'FeatureCollection', features: [] },
      hotspots: (fire && fire.hotspots) || [],
      nearestKm: fire && Number.isFinite(fire.nearestKm) ? fire.nearestKm : Infinity,
    },
    wind: wind || null,
  };
}
