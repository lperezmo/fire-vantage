// Vercel serverless function (and Vite dev middleware) that proxies Washington
// State DOT HighwayAlerts for the Walla Walla / US-12 corridor.
//
// Why a proxy: the WSDOT Traveler Information API needs a free AccessCode and
// does NOT send permissive CORS headers, so a direct browser fetch is blocked
// and the key would leak to the client. This proxy reads the key from the
// server-side env var WSDOT_ACCESS_CODE, calls WSDOT, trims the payload to
// alerts in/near Walla Walla County (and the US-12 corridor bbox), adds CORS,
// and returns a small JSON list.
//
//   GET /api/wa-alerts
//
// Returns:
//   { configured: true,  alerts: [ ...trimmed alerts... ] }   when the key is set
//   { configured: false, alerts: [] }                          when the key is UNSET
//
// IMPORTANT: never returns 500. If the key is missing we report configured:false
// (HTTP 200) so the client keeps the honest "Washington roads not included yet"
// note. If WSDOT is down we report configured:true with an empty list and an
// `error` flag, so the client degrades to the same honest note.
//
// Upstream (needs AccessCode):
//   https://wsdot.wa.gov/Traffic/api/HighwayAlerts/HighwayAlertsREST.svc/GetAlertsAsJson?AccessCode={CODE}
// Each alert: { AlertID, County, EventCategory, EventStatus, Priority,
//   HeadlineDescription, ExtendedDescription, StartTime, EndTime,
//   StartRoadwayLocation{RoadName,Direction,MilePost,Latitude,Longitude},
//   EndRoadwayLocation{...} }. Dates are MS "/Date(ms-0700)/" format.

const WSDOT_URL =
  'https://wsdot.wa.gov/Traffic/api/HighwayAlerts/HighwayAlertsREST.svc/GetAlertsAsJson';

// Walla Walla corridor bbox: a generous box around Walla Walla (46.0, -118.4)
// covering the US-12 stretch up from the Oregon line. [west, south, east, north].
const WW_BBOX = { west: -118.7, south: 45.9, east: -118.1, north: 46.25 };
const WW_COUNTY = 'walla walla';

const UA = { 'User-Agent': 'fire-vantage (github.com/lperezmo/fire-vantage)' };

// Parse a WSDOT ".NET" date string like "/Date(1718841600000-0700)/" to epoch ms.
function parseMsDate(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/\/Date\((-?\d+)([+-]\d{4})?\)\//);
  if (!m) return null;
  const ms = Number(m[1]);
  return Number.isFinite(ms) ? ms : null;
}

function inBbox(lat, lon, b) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
}

// Keep only alerts relevant to the Walla Walla corridor: county match OR a
// start/end roadway point inside the bbox.
function isRelevant(a) {
  const county = (a.County || '').toLowerCase();
  if (county.includes(WW_COUNTY)) return true;
  const s = a.StartRoadwayLocation || {};
  const e = a.EndRoadwayLocation || {};
  if (inBbox(Number(s.Latitude), Number(s.Longitude), WW_BBOX)) return true;
  if (inBbox(Number(e.Latitude), Number(e.Longitude), WW_BBOX)) return true;
  return false;
}

// Reduce a raw WSDOT alert to the light shape the client uses. The lon/lat is
// the start roadway point so the verdict engine can test route proximity.
function reduceAlert(a) {
  const s = a.StartRoadwayLocation || {};
  const lon = Number(s.Longitude);
  const lat = Number(s.Latitude);
  return {
    id: a.AlertID ?? null,
    county: a.County || null,
    category: a.EventCategory || null,
    status: a.EventStatus || null,
    priority: a.Priority || null,
    headline: a.HeadlineDescription || null,
    extended: a.ExtendedDescription || null,
    road: s.RoadName || null,
    direction: s.Direction || null,
    milePost: Number.isFinite(+s.MilePost) ? +s.MilePost : null,
    lon: Number.isFinite(lon) ? lon : null,
    lat: Number.isFinite(lat) ? lat : null,
    startTime: parseMsDate(a.StartTime),
    endTime: parseMsDate(a.EndTime),
  };
}

export async function proxyWaAlerts(reqUrl, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const code = process.env.WSDOT_ACCESS_CODE;

  // Not configured: honest, HTTP 200, never 500. The client keeps the "not
  // included yet" note when configured is false.
  if (!code) {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: false, alerts: [] }));
    return;
  }

  try {
    const url = `${WSDOT_URL}?AccessCode=${encodeURIComponent(code)}`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const j = await r.json();
    const list = Array.isArray(j) ? j : [];
    const alerts = list
      .filter(isRelevant)
      .map(reduceAlert);
    res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=300');
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: true, alerts }));
  } catch (err) {
    // WSDOT down or bad key: degrade gracefully. configured stays true (a key
    // is present) but alerts is empty and we flag the error; the client still
    // shows the honest note rather than crashing.
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=30');
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: true, alerts: [], error: String(err?.message || 'wsdot error') }));
  }
}

export default function handler(req, res) {
  return proxyWaAlerts(req.url, res);
}
