// Shared geo math used by both the box-mode fire layer (fires.js) and the
// regional Drive Board proximity engine (regional/proximity.js). Pure
// arithmetic, no DOM, no dependencies. Distances use an equirectangular
// approximation that is accurate to well under a percent at the scale of these
// routes (tens of km in eastern Oregon).

// Equirectangular metric distance between two lon/lat points. Good for
// parcel-scale and route-scale spans.
export function metersBetween(lon1, lat1, lon2, lat2) {
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  const dx = (lon2 - lon1) * mPerDegLon;
  const dy = (lat2 - lat1) * mPerDegLat;
  return Math.hypot(dx, dy);
}

// Axis-aligned bbox of a GeoJSON Polygon/MultiPolygon geometry's coordinates,
// for a cheap reject test before a full point-in-polygon or distance scan.
export function geometryBounds(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  for (const poly of polys) {
    const ring = poly && poly[0];
    if (!ring) continue;
    for (const pt of ring) {
      if (pt[0] < minX) minX = pt[0];
      if (pt[0] > maxX) maxX = pt[0];
      if (pt[1] < minY) minY = pt[1];
      if (pt[1] > maxY) maxY = pt[1];
    }
  }
  return { minX, minY, maxX, maxY };
}
