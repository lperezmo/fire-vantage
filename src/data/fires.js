// Live wildfire layer - fetches current interagency fire perimeters (polygons)
// and VIIRS satellite hotspots through /api/fires, computes how close the nearest
// active fire is to the parcel, and rasterizes a per-cell "fire proximity" grid
// the scorer uses to weight spread risk.
//
// Runs inside the analysis Web Worker (fetch + plain JS only, no DOM). Degrades
// gracefully: if the fetch fails the parcel is treated as having no active fire
// (nearestKm Infinity, empty perimeters/hotspots) so the rest of the app still
// runs.

import { metersBetween, geometryBounds } from './geomath.js';

// Per-cell geo mapping - MUST match build.js / the shared contract exactly so all
// grids align: row 0 = north edge, last row = south edge.
function cellLon(bbox, gridW, col) {
  return gridW <= 1 ? bbox.west : bbox.west + (col / (gridW - 1)) * (bbox.east - bbox.west);
}
function cellLat(bbox, gridH, row) {
  return gridH <= 1 ? bbox.north : bbox.north + (row / (gridH - 1)) * (bbox.south - bbox.north);
}

// Ray-casting point-in-polygon against a single ring [[lon,lat],...].
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect =
      (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Point in a GeoJSON Polygon coordinate array: outer ring minus holes.
function pointInPolygon(lon, lat, rings) {
  if (!rings || !rings.length) return false;
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) {
    if (pointInRing(lon, lat, rings[h])) return false; // inside a hole
  }
  return true;
}

// Point in a GeoJSON geometry (Polygon or MultiPolygon).
function pointInGeometry(lon, lat, geom) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return pointInPolygon(lon, lat, geom.coordinates);
  if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) {
      if (pointInPolygon(lon, lat, poly)) return true;
    }
    return false;
  }
  return false;
}

// Iterate every vertex of a Polygon/MultiPolygon geometry's rings.
function forEachVertex(geom, fn) {
  if (!geom) return;
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  for (const poly of polys) {
    if (!poly) continue;
    for (const ring of poly) {
      if (!ring) continue;
      for (const pt of ring) fn(pt[0], pt[1]);
    }
  }
}

const EMPTY = () => ({
  ok: false,
  perimeters: { type: 'FeatureCollection', features: [] },
  hotspots: [],
  nearestKm: Infinity,
});

export async function fetchFireData(bbox, onProgress = () => {}) {
  onProgress(0.05, 'Fetching active fires...');

  let payload;
  try {
    const url = `/api/fires?w=${bbox.west}&s=${bbox.south}&e=${bbox.east}&n=${bbox.north}`;
    const r = await fetch(url);
    if (!r.ok) return EMPTY();
    payload = await r.json();
  } catch {
    return EMPTY();
  }

  if (!payload || payload.ok === false) {
    // The proxy reports ok:false only when BOTH layers failed; otherwise keep
    // whatever it returned (one layer may be empty but valid).
    if (!payload || (payload.perimOk === false && payload.hotOk === false)) return EMPTY();
  }

  const perimeters =
    payload.perimeters && Array.isArray(payload.perimeters.features)
      ? payload.perimeters
      : { type: 'FeatureCollection', features: [] };
  const hotspots = Array.isArray(payload.hotspots) ? payload.hotspots : [];

  onProgress(0.6, 'Measuring fire distance...');

  // nearestKm: closest active fire to the bbox center, taking the min over every
  // hotspot point AND every perimeter vertex (equirectangular approx).
  const cLon = (bbox.west + bbox.east) / 2;
  const cLat = (bbox.north + bbox.south) / 2;
  let bestM = Infinity;
  for (const h of hotspots) {
    if (!Number.isFinite(h.lon) || !Number.isFinite(h.lat)) continue;
    const d = metersBetween(cLon, cLat, h.lon, h.lat);
    if (d < bestM) bestM = d;
  }
  for (const f of perimeters.features) {
    if (!f || !f.geometry) continue;
    forEachVertex(f.geometry, (lon, lat) => {
      const d = metersBetween(cLon, cLat, lon, lat);
      if (d < bestM) bestM = d;
    });
  }
  const nearestKm = Number.isFinite(bestM) ? bestM / 1000 : Infinity;

  onProgress(1, 'Fires ready');

  return {
    ok: !!(perimeters.features.length || hotspots.length),
    perimeters,
    hotspots,
    nearestKm,
  };
}

// Build a per-cell fire-proximity grid Float32Array(gridW*gridH), 0..1, where:
//   1.0  - the cell sits inside an active perimeter polygon, or right on a hotspot
//   <1   - distance falloff away from the nearest hotspot, decaying to ~0 over the
//          parcel diagonal (so closeness scales with the size of the area drawn)
// Used by score.js as the fireProximity term that boosts spread risk and as part
// of the per-cell importance weight for the lookout viewshed.
export function buildFireProximity(parcel, fire) {
  const { gridW, gridH, bbox, metersPerPx } = parcel;
  const out = new Float32Array(gridW * gridH);
  if (!fire) return out;

  const perims = (fire.perimeters && fire.perimeters.features) || [];
  const hotspots = fire.hotspots || [];
  if (!perims.length && !hotspots.length) return out;

  // Precompute perimeter bounds for a cheap reject test.
  const prepared = [];
  for (const f of perims) {
    if (!f || !f.geometry) continue;
    prepared.push({ geom: f.geometry, bounds: geometryBounds(f.geometry) });
  }

  // Falloff scale: the parcel diagonal in metres. Closeness decays to ~0 over it.
  const diagM = Math.hypot(gridW, gridH) * metersPerPx;
  const falloff = Math.max(1, diagM); // metres

  for (let row = 0; row < gridH; row++) {
    const lat = cellLat(bbox, gridH, row);
    for (let col = 0; col < gridW; col++) {
      const lon = cellLon(bbox, gridW, col);
      const ci = row * gridW + col;

      // inside any perimeter -> max proximity
      let inside = false;
      for (let k = 0; k < prepared.length; k++) {
        const b = prepared[k].bounds;
        if (lon < b.minX || lon > b.maxX || lat < b.minY || lat > b.maxY) continue;
        if (pointInGeometry(lon, lat, prepared[k].geom)) { inside = true; break; }
      }
      if (inside) { out[ci] = 1; continue; }

      // otherwise, distance falloff from the nearest hotspot
      let nearM = Infinity;
      for (let h = 0; h < hotspots.length; h++) {
        const hs = hotspots[h];
        if (!Number.isFinite(hs.lon) || !Number.isFinite(hs.lat)) continue;
        const d = metersBetween(lon, lat, hs.lon, hs.lat);
        if (d < nearM) nearM = d;
      }
      if (Number.isFinite(nearM)) {
        out[ci] = Math.max(0, 1 - nearM / falloff);
      }
    }
  }

  return out;
}
