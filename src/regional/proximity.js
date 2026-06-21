// Regional Drive Board proximity engine. Pure arithmetic on plain GeoJSON,
// runs on the MAIN thread (no worker, no terrain). Given a town's baked route
// polyline and the live fire + ODOT incident data, it decides a CLEAR /
// CAUTION / AVOID verdict and the deciding reason.
//
// Distances use the shared equirectangular helper (geomath.js). Routes are
// sampled ~every 2 km; everything is bbox-prefiltered so a route only tests the
// handful of fires/incidents near it.

import { metersBetween, geometryBounds } from '../data/geomath.js';

// ---- thresholds (named constants, all in km) ----
export const AVOID_KM = 2;      // fire or closure/wildfire incident within this -> AVOID
export const CAUTION_KM = 8;    // fire within this (about 5 mi) -> CAUTION
export const INCIDENT_KM = 2;   // any ODOT incident within this counts for the route
export const SAMPLE_KM = 2;     // route is densified to a sample roughly every this far

export const VERDICT = { AVOID: 'avoid', CAUTION: 'caution', CLEAR: 'clear', UNKNOWN: 'unknown' };
// numeric severity so we can take the worst across hazards
const RANK = { clear: 0, caution: 1, avoid: 2, unknown: 1 };
export function worstVerdict(a, b) {
  return RANK[a] >= RANK[b] ? a : b;
}

// ---- geometry primitives ----

// Shortest distance (km) from point P to segment AB, all [lon,lat].
export function pointToSegmentKm(plon, plat, alon, alat, blon, blat) {
  // work in a local metric frame anchored at A using the equirectangular scale
  const latRef = (alat + blat) / 2;
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((latRef * Math.PI) / 180);
  const ax = 0, ay = 0;
  const bx = (blon - alon) * mPerDegLon, by = (blat - alat) * mPerDegLat;
  const px = (plon - alon) * mPerDegLon, py = (plat - alat) * mPerDegLat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy) / 1000;
}

// Shortest distance (km) from point P to a polyline (array of [lon,lat]).
export function pointToPolylineKm(plon, plat, line) {
  if (!line || line.length === 0) return Infinity;
  if (line.length === 1) return metersBetween(plon, plat, line[0][0], line[0][1]) / 1000;
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const d = pointToSegmentKm(plon, plat, line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]);
    if (d < best) best = d;
  }
  return best;
}

// Shortest distance (km) between two polylines. Cheap approximation: min over
// each vertex of A to polyline B (and vice versa). Good enough at these scales
// for the "is this fire edge near the road" test.
export function polylineToPolylineKm(a, b) {
  if (!a || !b || !a.length || !b.length) return Infinity;
  let best = Infinity;
  for (const p of a) {
    const d = pointToPolylineKm(p[0], p[1], b);
    if (d < best) best = d;
  }
  for (const p of b) {
    const d = pointToPolylineKm(p[0], p[1], a);
    if (d < best) best = d;
  }
  return best;
}

// Axis-aligned bbox of a polyline [[lon,lat],...], optionally padded (deg).
function lineBounds(line, padDeg = 0) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of line) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX: minX - padDeg, minY: minY - padDeg, maxX: maxX + padDeg, maxY: maxY + padDeg };
}

function boundsOverlap(a, b) {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

// Distance (km) from a point to a route polyline only if the point is within a
// padded bbox, else Infinity (cheap reject).
function pointToRoutePrefiltered(plon, plat, route, routeBox) {
  if (plon < routeBox.minX || plon > routeBox.maxX || plat < routeBox.minY || plat > routeBox.maxY) {
    return Infinity;
  }
  return pointToPolylineKm(plon, plat, route);
}

// Pull the outer-ring vertices of a GeoJSON Polygon/MultiPolygon as polylines.
function geometryRings(geom) {
  if (!geom) return [];
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : (geom.type === 'Polygon' ? [geom.coordinates] : []);
  const rings = [];
  for (const poly of polys) {
    if (poly && poly[0]) rings.push(poly[0]);
  }
  return rings;
}

// ---- ODOT incident classification ----

// True if an ODOT incident's category/comments indicate a road closure or a
// wildfire (either forces AVOID when near a route).
export function incidentForcesAvoid(inc) {
  const cat = (inc.category || '').toLowerCase();
  const sub = (inc.subType || '').toLowerCase();
  const ev = (inc.eventType || '').toLowerCase();
  const txt = (inc.comments || '').toLowerCase();
  const sev = (inc.severity || '').toLowerCase();
  if (sub.includes('wildfire') || txt.includes('wildfire') || txt.includes('wild fire')) return true;
  if (txt.includes('closed') || txt.includes('closure') || cat.includes('closure')) return true;
  if (sev.includes('closed') || sev.includes('road closed')) return true;
  // explicit fire mentions in the free text
  if (ev.includes('disaster') && (sub.includes('fire') || txt.includes('fire'))) return true;
  return false;
}

// ---- the main per-route risk computation ----
//
// route:    [[lon,lat],...] baked polyline
// fire:     { perimeters: FeatureCollection, hotspots: [{lon,lat,...}] }
// incidents:[{lon,lat,route,category,subType,eventType,severity,comments,beginMarker,...}]
//
// Returns { verdict, nearestFireKm, reason, hazard, fireSamples, incidentHits }.
export function computeRouteRisk(route, fire, incidents) {
  const routeBox = lineBounds(route, 0.12); // ~13 km pad in deg for prefilter
  let nearestFireKm = Infinity;
  let nearestFireKind = null; // 'perimeter' | 'hotspot' | 'inside'
  let insidePerimeter = false;

  // ---- fire: hotspots ----
  const hotspots = (fire && Array.isArray(fire.hotspots)) ? fire.hotspots : [];
  for (const h of hotspots) {
    if (!Number.isFinite(h.lon) || !Number.isFinite(h.lat)) continue;
    const d = pointToRoutePrefiltered(h.lon, h.lat, route, routeBox);
    if (d < nearestFireKm) { nearestFireKm = d; nearestFireKind = 'hotspot'; }
  }

  // ---- fire: perimeters (ring-to-route distance, bbox-prefiltered) ----
  const perims = (fire && fire.perimeters && Array.isArray(fire.perimeters.features))
    ? fire.perimeters.features : [];
  for (const f of perims) {
    if (!f || !f.geometry) continue;
    const gb = geometryBounds(f.geometry);
    const fb = { minX: gb.minX, minY: gb.minY, maxX: gb.maxX, maxY: gb.maxY };
    if (!boundsOverlap(fb, routeBox)) continue;
    const rings = geometryRings(f.geometry);
    for (const ring of rings) {
      const d = polylineToPolylineKm(route, ring);
      if (d < nearestFireKm) { nearestFireKm = d; nearestFireKind = 'perimeter'; }
    }
    // a route sample inside the perimeter -> distance 0, AVOID
    if (!insidePerimeter) {
      for (const ring of rings) {
        // sample test using point-in-ring on route vertices
        for (const p of route) {
          if (pointInRing(p[0], p[1], ring)) { insidePerimeter = true; nearestFireKm = 0; nearestFireKind = 'inside'; break; }
        }
        if (insidePerimeter) break;
      }
    }
  }

  // ---- ODOT incidents near this route ----
  const incidentHits = [];
  for (const inc of (incidents || [])) {
    if (!Number.isFinite(inc.lon) || !Number.isFinite(inc.lat)) continue;
    const d = pointToRoutePrefiltered(inc.lon, inc.lat, route, routeBox);
    if (d <= INCIDENT_KM) {
      incidentHits.push({ ...inc, distKm: d, forcesAvoid: incidentForcesAvoid(inc) });
    }
  }
  incidentHits.sort((a, b) => a.distKm - b.distKm);

  // ---- combine into a verdict ----
  let verdict = VERDICT.CLEAR;
  let reason = 'No fire or incidents reported near this route.';
  let hazard = null;

  // fire contributions
  if (insidePerimeter) {
    verdict = worstVerdict(verdict, VERDICT.AVOID);
    reason = 'Route passes inside an active fire perimeter.';
    hazard = { type: 'fire', kind: 'inside', distKm: 0 };
  } else if (Number.isFinite(nearestFireKm)) {
    if (nearestFireKm <= AVOID_KM) {
      verdict = worstVerdict(verdict, VERDICT.AVOID);
      reason = `Active fire about ${nearestFireKm.toFixed(1)} km from the route.`;
      hazard = { type: 'fire', kind: nearestFireKind, distKm: nearestFireKm };
    } else if (nearestFireKm <= CAUTION_KM) {
      verdict = worstVerdict(verdict, VERDICT.CAUTION);
      reason = `Active fire about ${nearestFireKm.toFixed(1)} km from the route.`;
      hazard = { type: 'fire', kind: nearestFireKind, distKm: nearestFireKm };
    }
  }

  // incident contributions (can escalate the verdict and override the reason)
  const avoidInc = incidentHits.find((i) => i.forcesAvoid);
  if (avoidInc) {
    verdict = worstVerdict(verdict, VERDICT.AVOID);
    reason = incidentHeadline(avoidInc);
    hazard = { type: 'incident', incident: avoidInc, distKm: avoidInc.distKm };
  } else if (incidentHits.length) {
    verdict = worstVerdict(verdict, VERDICT.CAUTION);
    // only override the reason if fire did not already set an AVOID
    if (verdict !== VERDICT.AVOID || !hazard) {
      const top = incidentHits[0];
      reason = incidentHeadline(top);
      if (!hazard || hazard.type !== 'fire') hazard = { type: 'incident', incident: top, distKm: top.distKm };
    }
  }

  return {
    verdict,
    nearestFireKm,
    reason,
    hazard,
    incidentHits,
  };
}

// A short human headline for an incident row/card.
export function incidentHeadline(inc) {
  const where = inc.beginMarker || inc.route || 'state highway';
  const what = inc.subType || inc.category || 'incident';
  const note = inc.comments ? ` ${inc.comments}` : '';
  return `${what} on ${where}.${note}`.trim();
}

// Ray-casting point-in-ring (ring = [[lon,lat],...]). Local copy so proximity.js
// has no cross-module dependency on the worker-side fires.js.
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

// Find the worst stretch of a route near its deciding hazard: returns a small
// bbox around the closest route point to the hazard, used to pre-draw the
// "Inspect this ground" box. boxKm is the half-size in km.
export function hazardBox(route, hazard, boxKm = 3) {
  let center = null;
  if (hazard && hazard.type === 'incident' && hazard.incident) {
    center = nearestRoutePoint(route, hazard.incident.lon, hazard.incident.lat);
  } else if (hazard && hazard.type === 'fire' && hazard.hazardLon != null) {
    center = { lon: hazard.hazardLon, lat: hazard.hazardLat };
  }
  if (!center) {
    // fall back to the route midpoint
    const mid = route[Math.floor(route.length / 2)] || route[0];
    center = { lon: mid[0], lat: mid[1] };
  }
  const dLat = boxKm / 111.32;
  const dLon = boxKm / (111.32 * Math.cos((center.lat * Math.PI) / 180));
  return {
    west: center.lon - dLon, east: center.lon + dLon,
    south: center.lat - dLat, north: center.lat + dLat,
  };
}

function nearestRoutePoint(route, lon, lat) {
  let best = Infinity, bestPt = route[0];
  for (const p of route) {
    const d = metersBetween(lon, lat, p[0], p[1]);
    if (d < best) { best = d; bestPt = p; }
  }
  return { lon: bestPt[0], lat: bestPt[1] };
}
