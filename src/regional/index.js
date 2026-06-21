// Regional Drive Board orchestrator. MAIN THREAD ONLY: no worker, no terrain,
// no viewshed. Flow: render static town/route layers immediately (zero network)
// -> hydrate live fire + ODOT incidents + NWS alerts + wind -> recompute
// verdicts -> re-render the panel and recolor the map.
//
// Caching: an in-memory cache plus sessionStorage with a ~10 min TTL keyed by
// the region bbox, so panning/zooming never refetches and a reload inside the
// TTL is instant. Everything degrades gracefully: a failed fetch yields CAUTION
// rather than a false CLEAR.

import { HUB, TOWNS, REGION_BBOX } from './towns.js';
import { computeRouteRisk, hazardBox, VERDICT } from './proximity.js';
import { createRegionalLayers } from './layers.js';
import { renderDriveBoard, setupBottomSheet } from './panel.js';

const TTL_MS = 10 * 60 * 1000;
const CACHE_KEY = 'fv-regional-v1';

// ODOT Traffic Incidents (keyless, CORS-open, browser-direct). The f=geojson
// output flattens service fields under an "attributes_" prefix and leaves the
// GeoJSON geometry as a Point built from start lat/lon.
const ODOT_URL =
  'https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/ODOT_Traffic_Incidents/FeatureServer/0/query' +
  '?geometry=-119.6,44.4,-117.4,46.2&geometryType=esriGeometryEnvelope&inSR=4326' +
  '&spatialRel=esriSpatialRelIntersects&outFields=*&f=geojson';

const NWS_URL =
  `https://api.weather.gov/alerts/active?point=${HUB.lat},${HUB.lon}`;
const NWS_UA = 'fire-vantage (github.com/lperezmo/fire-vantage)';

const OPENMETEO_URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${HUB.lat.toFixed(4)}&longitude=${HUB.lon.toFixed(4)}` +
  `&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=mph`;

// ---- data fetchers (each never throws; returns null/empty on failure) ----

async function fetchFire() {
  try {
    const b = REGION_BBOX;
    // Wider regional payload: ask the proxy to simplify + trim coordinate
    // precision so the perimeters stay light. Backward compatible (box mode
    // does not pass these).
    const url = `/api/fires?w=${b.west}&s=${b.south}&e=${b.east}&n=${b.north}&maxAllowableOffset=0.002&precision=5`;
    const r = await fetch(url);
    if (!r.ok) return { ok: false };
    const j = await r.json();
    return {
      ok: !!(j && (j.perimOk || j.hotOk)),
      perimeters: (j && j.perimeters && Array.isArray(j.perimeters.features))
        ? j.perimeters : { type: 'FeatureCollection', features: [] },
      hotspots: (j && Array.isArray(j.hotspots)) ? j.hotspots : [],
    };
  } catch {
    return { ok: false };
  }
}

async function fetchIncidents() {
  try {
    const r = await fetch(ODOT_URL);
    if (!r.ok) return { ok: false, incidents: [] };
    const j = await r.json();
    const feats = (j && Array.isArray(j.features)) ? j.features : [];
    const incidents = [];
    for (const f of feats) {
      const p = f.properties || {};
      // prefer the Point geometry; fall back to start lat/lon
      let lon = null, lat = null;
      if (f.geometry && f.geometry.type === 'Point' && Array.isArray(f.geometry.coordinates)) {
        [lon, lat] = f.geometry.coordinates;
      }
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        lat = Number(p.attributes_startLatitude);
        lon = Number(p.attributes_startLongitude);
      }
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      incidents.push({
        lon, lat,
        route: p.attributes_route || null,
        category: p.attributes_odotCategoryDescript || null,
        subType: p.attributes_eventSubTypeName || null,
        eventType: p.attributes_eventTypeName || null,
        severity: p.attributes_odotSeverityDescript || null,
        comments: p.attributes_comments || null,
        beginMarker: p.attributes_beginMarker || null,
        incidentId: p.attributes_incidentId || null,
        lastUpdated: p.attributes_lastUpdated || null,
      });
    }
    return { ok: true, incidents };
  } catch {
    return { ok: false, incidents: [] };
  }
}

async function fetchAlert() {
  try {
    const r = await fetch(NWS_URL, { headers: { 'User-Agent': NWS_UA, Accept: 'application/geo+json' } });
    if (!r.ok) return { active: false };
    const j = await r.json();
    const feats = (j && Array.isArray(j.features)) ? j.features : [];
    // surface the first Red Flag Warning / Fire Weather Watch
    for (const f of feats) {
      const ev = (f.properties && f.properties.event) || '';
      if (/red flag|fire weather/i.test(ev)) {
        return { active: true, event: ev, headline: (f.properties && f.properties.headline) || '' };
      }
    }
    return { active: false };
  } catch {
    return { active: false };
  }
}

// WSDOT (Washington) road alerts for the Walla Walla / US-12 corridor, through
// our env-gated serverless proxy. The proxy returns { configured, alerts } and
// never 500s: when the WSDOT_ACCESS_CODE env var is unset it returns
// configured:false so the UI keeps the honest "Washington roads not included
// yet" note. Never throws.
async function fetchWaAlerts() {
  try {
    const r = await fetch('/api/wa-alerts');
    if (!r.ok) return { configured: false, alerts: [] };
    const j = await r.json();
    return {
      configured: !!(j && j.configured),
      alerts: (j && Array.isArray(j.alerts)) ? j.alerts : [],
    };
  } catch {
    return { configured: false, alerts: [] };
  }
}

async function fetchWind() {
  try {
    const r = await fetch(OPENMETEO_URL);
    if (!r.ok) return null;
    const j = await r.json();
    const c = j && j.current;
    if (!c) return null;
    const speedMph = Number(c.wind_speed_10m);
    const dirDeg = Number(c.wind_direction_10m);
    if (!Number.isFinite(speedMph) || !Number.isFinite(dirDeg)) return null;
    return { speedMph, dirDeg, gustMph: Number(c.wind_gusts_10m) };
  } catch {
    return null;
  }
}

// ---- cache ----
function readCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || (Date.now() - obj.t) > TTL_MS) return null;
    return obj.data;
  } catch { return null; }
}
function writeCache(data) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), data })); } catch { /* ignore quota */ }
}

let memCache = null;

// ---- verdict computation over all towns ----
function computeAll(data) {
  const fire = data.fireOk ? { perimeters: data.perimeters, hotspots: data.hotspots } : null;
  const incidents = data.incidentsOk ? data.incidents : [];
  // If BOTH fire and incidents failed, we have no live signal -> degrade to
  // CAUTION for every route (honesty rule: never a false CLEAR).
  const degraded = !data.fireOk && !data.incidentsOk;

  // WSDOT alerts only apply to legs that enter Washington, and only when the
  // proxy reported a configured key with real data to consider.
  const waConfigured = !!data.waConfigured;
  const waAlerts = waConfigured && Array.isArray(data.waAlerts) ? data.waAlerts : [];

  const results = TOWNS.map((town) => {
    const legWa = town.crossesWA ? waAlerts : [];
    const risk = computeRouteRisk(town.route, fire, incidents, legWa);
    let verdict = risk.verdict;
    if (degraded) verdict = VERDICT.CAUTION;
    // The honest WA note stays unless WA data is configured AND this leg has
    // actual WA alerts to show instead.
    const waCovered = town.crossesWA && waConfigured && risk.waHits && risk.waHits.length > 0;
    return {
      town,
      verdict,
      nearestFireKm: risk.nearestFireKm,
      reason: degraded ? "Couldn't load live data - drive with caution and check TripCheck." : risk.reason,
      hazard: risk.hazard,
      incidentHits: risk.incidentHits,
      waHits: risk.waHits || [],
      waConfigured,
      waCovered,
      wind: data.wind || null,
    };
  });
  return { results, degraded };
}

export function createRegional(map) {
  const layers = createRegionalLayers(map);
  let sheet = null;
  let current = null; // last computed results

  // build a synthetic route-results array for the static first paint (unknown verdicts)
  function staticResults() {
    return TOWNS.map((town) => ({ town, verdict: VERDICT.UNKNOWN }));
  }

  // ---- handlers ----
  function onSelect(townId) {
    layers.highlightRoute(townId);
    const r = current && current.results.find((x) => x.town.id === townId);
    if (r) {
      map.flyTo({ center: [r.town.lon, r.town.lat], zoom: Math.max(map.getZoom(), 8.5), duration: 600 });
    }
    // deep link ?to=
    const u = new URL(location.href);
    u.searchParams.set('to', townId);
    history.replaceState(null, '', u);
  }

  function onMaps() { /* href handles it */ }

  let inspectHandler = null;   // set by main.js: (bbox) => runAnalysis
  let drawCustomHandler = null;

  function onInspect(townId) {
    const r = current && current.results.find((x) => x.town.id === townId);
    if (!r || !inspectHandler) return;
    const box = hazardBox(r.town.route, r.hazard, 3);
    inspectHandler(box);
  }

  function onDrawCustom() {
    if (drawCustomHandler) drawCustomHandler();
  }

  const handlers = { onSelect, onInspect, onMaps, onDrawCustom };

  function render(state) {
    const board = document.getElementById('drive-board');
    if (!board) return;
    const ctl = renderDriveBoard(board, state, handlers);
    if (!sheet) sheet = setupBottomSheet(board);
    return ctl;
  }

  async function hydrate() {
    // memory cache first, then sessionStorage, else fetch
    let data = memCache || readCache();
    if (!data) {
      const [fire, inc, alert, wind, wa] = await Promise.all([
        fetchFire(), fetchIncidents(), fetchAlert(), fetchWind(), fetchWaAlerts(),
      ]);
      data = {
        fireOk: !!fire.ok,
        perimeters: fire.perimeters || { type: 'FeatureCollection', features: [] },
        hotspots: fire.hotspots || [],
        incidentsOk: !!inc.ok,
        incidents: inc.incidents || [],
        alert,
        wind,
        waConfigured: !!wa.configured,
        waAlerts: wa.alerts || [],
      };
      memCache = data;
      writeCache(data);
    }

    const { results, degraded } = computeAll(data);
    current = { results, degraded, data };

    // paint live layers
    layers.setFirePerimeters(data.perimeters);
    layers.setHotspots(data.hotspots);
    layers.setRoutes(results);
    layers.setTownMarkers(HUB, results, onSelect);

    // panel
    render({ hub: HUB, results, dataDegraded: degraded, alert: data.alert });

    // honor ?to= deep link by selecting that town
    const to = new URL(location.href).searchParams.get('to');
    if (to && results.some((r) => r.town.id === to)) onSelect(to);
  }

  // ---- public start: paint static immediately, then hydrate ----
  function start() {
    const stat = staticResults();
    layers.setRoutes(stat);
    layers.setTownMarkers(HUB, stat, onSelect);
    layers.fitToTowns(HUB, TOWNS);
    // static panel so the user sees structure before data lands
    render({
      hub: HUB,
      results: stat.map((s) => ({ ...s, nearestFireKm: Infinity, reason: 'Loading live fire and road data...', incidentHits: [] })),
      dataDegraded: false,
      alert: null,
    });
    hydrate();
  }

  return {
    start,
    setInspectHandler: (fn) => { inspectHandler = fn; },
    setDrawCustomHandler: (fn) => { drawCustomHandler = fn; },
    destroy: () => layers.destroy(),
  };
}
