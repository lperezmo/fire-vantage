// Vercel serverless function (and Vite dev middleware) that proxies live wildfire
// data from the NIFC public ArcGIS organization.
//
// Why a proxy: the NIFC ArcGIS FeatureServers are keyless but do not send
// permissive CORS headers for arbitrary browser origins, so a direct browser
// fetch is blocked. This proxy fetches them server-side, adds
// `Access-Control-Allow-Origin`, trims the payload to what the client needs, and
// edge-caches the result. Open-Meteo wind is CORS-open and is fetched directly
// from the client, so it is NOT proxied here.
//
//   GET /api/fires?w=<west>&s=<south>&e=<east>&n=<north>   (degrees, EPSG:4326)
//
// Returns: { ok, perimeters: <GeoJSON FeatureCollection>, hotspots: [...] }
//
// Sources (both keyless, verified live in the NIFC org T4QMspbfLg3qTGWY):
//   WFIGS_Interagency_Perimeters_Current - current interagency fire perimeters
//     (polygons). Fields: poly_IncidentName, attr_IncidentSize, poly_GISAcres,
//     attr_PercentContained, attr_FireDiscoveryDateTime.
//   VIIRS_Heat_Detections - satellite thermal hotspots, ~7-day rolling window
//     (points). Fields: DetectionDate, AgeInHours, Confidence, FRP, Sensor.

const ORG = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services';
const PERIM = `${ORG}/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query`;
const HOTSPOT = `${ORG}/VIIRS_Heat_Detections/FeatureServer/0/query`;

const PERIM_FIELDS =
  'poly_IncidentName,attr_IncidentName,poly_GISAcres,attr_IncidentSize,attr_PercentContained,attr_FireDiscoveryDateTime,attr_POOState';
const HOTSPOT_FIELDS = 'DetectionDate,AgeInHours,Confidence,FRP,Sensor';

const MAX_PERIM = 200;
const MAX_HOTSPOT = 2000;

function envelopeQuery(base, w, s, e, n, outFields, count, geometry = true) {
  const q = new URLSearchParams({
    where: '1=1',
    geometry: `${w},${s},${e},${n}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',          // required by the service even though values are WGS84
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields,
    returnGeometry: geometry ? 'true' : 'false',
    f: 'geojson',
    resultRecordCount: String(count),
  });
  return `${base}?${q.toString()}`;
}

const UA = { 'User-Agent': 'fire-vantage (github.com/lperezmo/fire-vantage)' };

async function fetchGeoJSON(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  const j = await r.json();
  return Array.isArray(j?.features) ? j.features : [];
}

// Reduce hotspot polygon/point features to light {lon, lat, ageHours, confidence}.
function reduceHotspots(features) {
  const out = [];
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    let lon, lat;
    if (g.type === 'Point') { [lon, lat] = g.coordinates; }
    else continue;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const p = f.properties || {};
    out.push({
      lon, lat,
      ageHours: Number.isFinite(+p.AgeInHours) ? +p.AgeInHours : null,
      confidence: p.Confidence ?? null,
    });
  }
  return out;
}

export async function proxyFires(reqUrl, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  let params;
  try {
    params = new URL(reqUrl, 'http://localhost').searchParams;
  } catch {
    res.statusCode = 400;
    res.end('bad url');
    return;
  }

  const w = Number(params.get('w'));
  const s = Number(params.get('s'));
  const e = Number(params.get('e'));
  const n = Number(params.get('n'));

  if (![w, s, e, n].every(Number.isFinite) || w >= e || s >= n) {
    res.statusCode = 400;
    res.end('expected ?w&s&e&n (degrees) with w<e and s<n');
    return;
  }

  // Pad the perimeter query so a large fire whose body sits just outside the
  // drawn box still shows its edge; hotspots use the tight box.
  const padX = (e - w) * 0.6, padY = (n - s) * 0.6;

  let perimeters = { type: 'FeatureCollection', features: [] };
  let hotspots = [];
  let perimOk = false, hotOk = false;

  // Perimeters and hotspots are fetched independently; either can fail without
  // killing the other, so the client always gets whatever is available.
  try {
    const feats = await fetchGeoJSON(
      envelopeQuery(PERIM, w - padX, s - padY, e + padX, n + padY, PERIM_FIELDS, MAX_PERIM)
    );
    perimeters = { type: 'FeatureCollection', features: feats };
    perimOk = true;
  } catch { /* leave empty, ok:false below if both fail */ }

  try {
    const feats = await fetchGeoJSON(
      envelopeQuery(HOTSPOT, w, s, e, n, HOTSPOT_FIELDS, MAX_HOTSPOT)
    );
    hotspots = reduceHotspots(feats);
    hotOk = true;
  } catch { /* hotspots are optional; perimeters alone are fine */ }

  res.setHeader('Content-Type', 'application/json');
  // Live data: short edge cache so the overlay stays reasonably current.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900');
  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: perimOk || hotOk,
    perimOk,
    hotOk,
    perimeters,
    hotspots,
  }));
}

export default function handler(req, res) {
  return proxyFires(req.url, res);
}
