import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { setupMap } from './ui/map.js';
import { renderResults } from './ui/panel.js';
import { bboxAreaKm2 } from './data/geo.js';
import { createRegional } from './regional/index.js';

const $ = (id) => document.getElementById(id);
const MAX_AREA_KM2 = 60;

// The heavy box pipeline (terrain + worker + viewshed) is UNCHANGED. The worker
// is created lazily so the default regional Drive Board never spins it up.
let worker = null;
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./analysis/worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onWorkerMessage;
  }
  return worker;
}

let lastResult = null;
let panelCtl = null;
let selectedRank = null;
let running = false;
let fireVisible = true;
let riskVisible = true;
let mode = 'regional'; // 'regional' | 'box'

const map = setupMap((box) => {
  $('analyze-btn').disabled = false;
  $('clear-btn').hidden = false;
  const area = bboxAreaKm2(box);
  $('draw-hint').textContent =
    area > MAX_AREA_KM2
      ? `Heads up: ~${area.toFixed(0)} km2 is large. Analysis is capped at ${MAX_AREA_KM2} km2 and may be coarse. Draw a smaller area for detail.`
      : `Area ~${area.toFixed(1)} km2. Ready - press "Run fire analysis".`;
  endDrawUi();
});

const DEFAULT_HINT = 'Tap "Draw analysis area", then drag a box across the ground you want to assess.';
let drawingMode = false;

function endDrawUi() {
  drawingMode = false;
  document.body.classList.remove('drawing');
  $('draw-btn').classList.remove('active');
  $('draw-btn').textContent = 'Draw analysis area';
}

// ---- mode routing ----
function enterBoxMode() {
  mode = 'box';
  document.body.classList.add('mode-box');
  $('drive-board').hidden = true;
  $('sidebar').hidden = false;
}
function enterRegionalMode() {
  mode = 'regional';
  document.body.classList.remove('mode-box');
  $('sidebar').hidden = true;
  $('drive-board').hidden = false;
  // clear box overlays so the regional layers are unobstructed
  map.clearAll();
  lastResult = null; selectedRank = null;
  $('results').innerHTML = '';
  $('analyze-btn').disabled = true;
  $('clear-btn').hidden = true;
  $('conditions').hidden = true; $('conditions').innerHTML = '';
  const u = new URL(location.href);
  u.searchParams.delete('bbox');
  history.replaceState(null, '', u);
}

// ---- search ----
async function doSearch() {
  const q = $('search').value.trim();
  if (!q) return;
  $('search-btn').textContent = '...';
  const ok = await map.geocode(q);
  $('search-btn').textContent = 'Go';
  if (!ok) $('draw-hint').textContent = 'Could not find that place. Try lat,lng or a more specific name.';
}
$('search-btn').addEventListener('click', doSearch);
$('search').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

// ---- back to drive board ----
$('back-to-board').addEventListener('click', () => {
  endDrawUi();
  map.cancelDraw();
  enterRegionalMode();
});

// ---- draw (toggle: tap again to cancel) ----
$('draw-btn').addEventListener('click', () => {
  if (drawingMode) {
    map.cancelDraw();
    endDrawUi();
    $('draw-hint').textContent = DEFAULT_HINT;
    return;
  }
  map.beginDraw();
  drawingMode = true;
  document.body.classList.add('drawing'); // collapses the sidebar on mobile for room
  $('draw-btn').classList.add('active');
  $('draw-btn').textContent = 'Cancel drawing';
  $('draw-hint').textContent = 'Drag a box across the ground - press and drag on the map (touch works).';
});
$('clear-btn').addEventListener('click', () => {
  map.clearAll();
  endDrawUi();
  lastResult = null; selectedRank = null;
  $('results').innerHTML = '';
  $('analyze-btn').disabled = true;
  $('clear-btn').hidden = true;
  $('toggle-fire').hidden = true;
  $('toggle-risk').hidden = true;
  $('conditions').hidden = true;
  $('conditions').innerHTML = '';
  $('draw-hint').textContent = DEFAULT_HINT;
});

// ---- overlay toggles ----
$('toggle-fire').addEventListener('click', () => {
  fireVisible = !fireVisible;
  map.toggleFire(fireVisible);
  $('toggle-fire').textContent = fireVisible ? 'Hide fire perimeters' : 'Show fire perimeters';
});
$('toggle-risk').addEventListener('click', () => {
  riskVisible = !riskVisible;
  map.toggleRisk(riskVisible);
  $('toggle-risk').textContent = riskVisible ? 'Hide spread risk' : 'Show spread risk';
});

// ---- analyze ----
function readUi() {
  return {
    goalMode: $('goal-mode').value,
    maxRange: +$('range').value,
    eyeHeight: +$('eye').value,
    useWind: $('use-wind').checked,
    weights: {
      spread: +$('w-spread').value,
      los: +$('w-los').value,
      fuel: +$('w-fuel').value,
      ground: +$('w-ground').value,
      slope: +$('w-slope').value,
    },
  };
}

// Fetch live wind on the main thread (Open-Meteo is CORS-open and keyless, no
// proxy). Returns {speedMph,dirDeg,gustMph} or null on any failure. Never
// throws - a wind hiccup must not block the whole run.
async function fetchWind(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
      `&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=mph`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = await res.json();
    const c = j && j.current;
    if (!c) return null;
    const speedMph = Number(c.wind_speed_10m);
    const dirDeg = Number(c.wind_direction_10m);
    const gustMph = Number(c.wind_gusts_10m);
    if (!Number.isFinite(speedMph) || !Number.isFinite(dirDeg)) return null;
    return { speedMph, dirDeg, gustMph: Number.isFinite(gustMph) ? gustMph : null };
  } catch (e) {
    return null;
  }
}

async function runAnalysis(box) {
  if (!box || running) return;
  running = true;
  $('analyze-btn').disabled = true;
  $('progress').hidden = false;
  setProgress(0.02, 'Starting...');
  // reflect the area in a shareable URL
  const u = new URL(location.href);
  u.searchParams.set('bbox', [box.west, box.south, box.east, box.north].map((v) => v.toFixed(5)).join(','));
  history.replaceState(null, '', u);

  const ui = readUi();
  // fetch wind on the main thread before posting to the worker
  let wind = null;
  if (ui.useWind) {
    setProgress(0.04, 'Fetching live wind...');
    const lat = (box.north + box.south) / 2;
    const lon = (box.east + box.west) / 2;
    wind = await fetchWind(lat, lon);
  }
  getWorker().postMessage({ bbox: box, ui, wind });
}

$('analyze-btn').addEventListener('click', () => runAnalysis(map.getBox()));

function setProgress(pct, label) {
  $('progress-fill').style.width = `${Math.round(pct * 100)}%`;
  $('progress-label').textContent = label || '';
}

function onWorkerMessage(e) {
  const msg = e.data;
  if (msg.type === 'progress') {
    setProgress(msg.pct, msg.label);
  } else if (msg.type === 'result') {
    running = false;
    $('analyze-btn').disabled = false;
    setTimeout(() => { $('progress').hidden = true; }, 400);
    lastResult = msg.result;
    map.showRisk(lastResult);
    map.showFire(lastResult);
    fireVisible = true; riskVisible = true;
    map.toggleFire(true);
    map.toggleRisk(true);
    $('toggle-fire').hidden = false;
    $('toggle-fire').textContent = 'Hide fire perimeters';
    $('toggle-risk').hidden = false;
    $('toggle-risk').textContent = 'Hide spread risk';
    renderConditions(lastResult);
    map.addMarkers(lastResult.spots, selectSpot);
    panelCtl = renderResults($('results'), lastResult.spots, {
      onSelect: selectSpot,
      onView3d: open3d,
    });
    if (lastResult.spots && lastResult.spots.length) selectSpot(1);
  } else if (msg.type === 'error') {
    running = false;
    $('analyze-btn').disabled = false;
    $('progress').hidden = true;
    $('draw-hint').textContent = `Analysis failed: ${msg.message}. Try again or a different area.`;
  }
}

function selectSpot(rank) {
  if (!lastResult) return;
  const spot = lastResult.spots.find((s) => s.rank === rank);
  if (!spot) return;
  selectedRank = rank;
  panelCtl?.select(rank);
  map.showFootprint(lastResult, spot);
  map.flyToSpot(spot);
}

// ---- live conditions strip ----
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function compassLabel(deg) {
  const i = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return COMPASS[i];
}

function renderConditions(result) {
  const el = $('conditions');
  if (!el) return;
  const rows = [];

  // ---- wind ----
  const wind = result && result.wind;
  if (wind && Number.isFinite(wind.speedMph) && Number.isFinite(wind.dirDeg)) {
    const fromLabel = compassLabel(wind.dirDeg);
    const toBearing = (wind.dirDeg + 180) % 360;
    const gust = Number.isFinite(wind.gustMph) ? `, gusts ${Math.round(wind.gustMph)}` : '';
    const svg = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">` +
      `<path d="M12 2 L20 20 L12 15 L4 20 Z"/></svg>`;
    const arrow = `<span class="wind-arrow" style="transform:rotate(${toBearing.toFixed(0)}deg)" aria-hidden="true">${svg}</span>`;
    rows.push(
      `<div class="cond-row">${arrow}<span>Wind <strong>${Math.round(wind.speedMph)} mph</strong> ` +
      `from ${fromLabel} (${Math.round(wind.dirDeg)} deg)${gust}</span></div>`
    );
  } else if (wind === null) {
    rows.push(`<div class="cond-row"><span>Wind: off</span></div>`);
  } else {
    rows.push(`<div class="cond-row"><span>Wind unavailable</span></div>`);
  }

  // ---- fire ----
  const fire = result && result.fire;
  let fireTxt = 'No active fire in view';
  let near = false;
  if (fire) {
    const km = fire.nearestKm;
    if (Number.isFinite(km)) {
      near = km < 5;
      fireTxt = `Nearest active fire <strong>${km.toFixed(1)} km</strong>`;
    }
    const nPerim = (fire.perimeters && fire.perimeters.features) ? fire.perimeters.features.length : 0;
    const nHot = Array.isArray(fire.hotspots) ? fire.hotspots.length : 0;
    const counts = [];
    if (nPerim) counts.push(`${nPerim} perimeter${nPerim === 1 ? '' : 's'}`);
    if (nHot) counts.push(`${nHot} hotspot${nHot === 1 ? '' : 's'}`);
    if (counts.length) fireTxt += ` (${counts.join(', ')})`;
  }
  rows.push(`<div class="cond-row${near ? ' fire-near' : ''}"><span>${fireTxt}</span></div>`);

  el.innerHTML = rows.join('');
  el.hidden = false;
}

// ---- 3D viewer ----
let view3dMod = null;
async function open3d(rank) {
  if (!lastResult) return;
  const spot = lastResult.spots.find((s) => s.rank === rank);
  if (!spot) return;
  $('viewer').hidden = false;
  $('viewer-title').textContent = `3D view - Spot ${rank}`;
  view3dMod = view3dMod || await import('./scene/view3d.js');
  requestAnimationFrame(() => view3dMod.openViewer($('viewer-canvas'), lastResult, spot));
}
$('viewer-close').addEventListener('click', () => {
  $('viewer').hidden = true;
  view3dMod?.disposeViewer();
});

// ===================================================================
// Mode router. DEFAULT = regional. ?bbox= -> box mode (auto-run, as before).
// ===================================================================

// Pre-draw a box and run the existing analysis, switching into box mode. Used by
// the regional "Inspect this ground" action.
function inspectBox(box) {
  enterBoxMode();
  map.setBox(box, { fit: true });
  $('analyze-btn').disabled = false;
  $('clear-btn').hidden = false;
  runAnalysis(box);
}

// Enter box mode with an empty draw state (regional "Draw a custom area").
function drawCustom() {
  enterBoxMode();
  $('draw-hint').textContent = DEFAULT_HINT;
  // kick straight into drawing for convenience
  $('draw-btn').click();
}

const regional = createRegional(map);
regional.setInspectHandler(inspectBox);
regional.setDrawCustomHandler(drawCustom);

(function initFromUrl() {
  const url = new URL(location.href);
  const raw = url.searchParams.get('bbox');

  // Box-mode deep link takes precedence (preserve existing behavior).
  if (raw) {
    const p = raw.split(',').map(Number);
    if (p.length === 4 && p.every((n) => Number.isFinite(n))) {
      const box = { west: p[0], south: p[1], east: p[2], north: p[3] };
      enterBoxMode();
      let fired = false;
      const start = () => {
        if (fired) return;
        fired = true;
        map.setBox(box, { fit: true });
        $('analyze-btn').disabled = false;
        $('clear-btn').hidden = false;
        runAnalysis(box);
      };
      if (map.map.loaded() || map.map.isStyleLoaded()) {
        start();
      } else {
        map.map.once('styledata', start);
        map.map.once('load', start);
        map.map.once('idle', start);
        setTimeout(start, 2000);
      }
      return;
    }
  }

  // Default: regional Drive Board. Render static layers immediately, hydrate
  // data when fetches resolve. Reuse the proven cold-start guard so the first
  // paint happens as soon as the style is ready (or after 2 s on a cold map).
  enterRegionalMode();
  let fired = false;
  const start = () => {
    if (fired) return;
    fired = true;
    regional.start();
  };
  if (map.map.loaded() || map.map.isStyleLoaded()) {
    start();
  } else {
    map.map.once('styledata', start);
    map.map.once('load', start);
    map.map.once('idle', start);
    setTimeout(start, 2000);
  }
})();
