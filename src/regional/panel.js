// Drive Board panel: a headline verdict bar, a worst-first list of destination
// rows (chip + reason + distance), and an expandable corridor card per row.
// Renders into #drive-board (desktop sidebar) which doubles as a mobile bottom
// sheet (see style.css). All copy follows the honesty rules: never "road open",
// always show the deciding hazard text and the real nearest-fire distance.

import { VERDICT } from './proximity.js';

const VERDICT_LABEL = {
  [VERDICT.AVOID]: 'AVOID',
  [VERDICT.CAUTION]: 'CAUTION',
  [VERDICT.CLEAR]: 'CLEAR',
  [VERDICT.UNKNOWN]: 'CHECK',
};

const RANK = { avoid: 0, caution: 1, clear: 2, unknown: 1.5 };

const CAVEAT_BASE =
  'Incidents are ODOT-reported on Oregon state highways; confirm on TripCheck.';
const CAVEAT_NO_WA = ' Washington roads are not included yet.';
const CAVEAT_WA = ' Washington roads use WSDOT HighwayAlerts; confirm on the WSDOT travel map.';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

// km -> miles, rounded
const mi = (km) => Math.round(km * 0.621371);

// Build a Google Maps directions deep link for a leg.
function mapsUrl(hub, town) {
  return `https://www.google.com/maps/dir/?api=1&origin=${hub.lat},${hub.lon}&destination=${town.lat},${town.lon}&travelmode=driving`;
}

// container: the #drive-board element
// state: { hub, results: [{town, verdict, nearestFireKm, reason, hazard, incidentHits}], dataDegraded, alert }
// handlers: { onSelect(townId), onInspect(townId), onMaps(townId) }
export function renderDriveBoard(container, state, handlers) {
  const { hub, results, dataDegraded, alert } = state;
  container.innerHTML = '';

  // ---- mobile drag handle + pinned summary ----
  const handle = document.createElement('div');
  handle.className = 'sheet-handle';
  handle.innerHTML = '<span class="grip"></span>';
  container.appendChild(handle);

  // ---- header ----
  const header = document.createElement('div');
  header.className = 'db-header';
  header.innerHTML =
    `<h1>Fire&nbsp;Vantage</h1>` +
    `<p class="db-sub">Drive Board - leaving <strong>${esc(hub.name)}</strong></p>`;
  container.appendChild(header);

  // ---- red flag / fire-weather banner ----
  if (alert && alert.active) {
    const b = document.createElement('div');
    b.className = 'db-banner';
    b.innerHTML = `<strong>${esc(alert.event)}</strong> ${esc(alert.headline || '')}`;
    container.appendChild(b);
  }

  // ---- headline verdict bar ----
  const affected = results.filter((r) => r.verdict === VERDICT.AVOID || r.verdict === VERDICT.CAUTION).length;
  const anyAvoid = results.some((r) => r.verdict === VERDICT.AVOID);
  const barClass = affected === 0 ? 'clear' : (anyAvoid ? 'avoid' : 'caution');
  const bar = document.createElement('div');
  bar.className = `db-bar ${barClass}`;
  let barText;
  if (dataDegraded) {
    barText = `Couldn't load all live data - treat routes as CAUTION`;
  } else if (affected === 0) {
    barText = `No fire or incidents reported on ${results.length} routes`;
  } else {
    barText = `${affected} of ${results.length} routes affected`;
  }
  bar.textContent = barText;
  container.appendChild(bar);

  // pinned one-line summary for the collapsed mobile sheet
  const pin = document.createElement('div');
  pin.className = `db-pin ${barClass}`;
  pin.textContent = barText;
  container.appendChild(pin);

  // ---- worst-first rows ----
  const sorted = [...results].sort((a, b) => {
    const dr = RANK[a.verdict] - RANK[b.verdict];
    if (dr !== 0) return dr;
    return (a.nearestFireKm ?? Infinity) - (b.nearestFireKm ?? Infinity);
  });

  const list = document.createElement('div');
  list.className = 'db-list';
  const rowEls = {};

  for (const r of sorted) {
    const row = document.createElement('div');
    row.className = `db-row verdict-${r.verdict}`;
    row.dataset.town = r.town.id;

    const fireTxt = Number.isFinite(r.nearestFireKm)
      ? `nearest fire ${r.nearestFireKm.toFixed(1)} km`
      : 'no active fire near route';

    row.innerHTML =
      `<div class="db-row-head">` +
        `<span class="chip ${r.verdict}">${VERDICT_LABEL[r.verdict]}</span>` +
        `<span class="db-town">${esc(r.town.name)}</span>` +
        `<span class="db-dist">${Math.round(r.town.distKm)} km / ${r.town.durMin} min</span>` +
      `</div>` +
      `<div class="db-reason">${esc(r.reason)}</div>` +
      `<div class="db-fire">${fireTxt}</div>` +
      `<div class="db-card" hidden></div>`;

    const head = row.querySelector('.db-row-head');
    head.addEventListener('click', () => {
      const willOpen = row.querySelector('.db-card').hidden;
      // collapse others
      Object.values(rowEls).forEach((el) => {
        el.classList.remove('open');
        el.querySelector('.db-card').hidden = true;
      });
      if (willOpen) {
        row.classList.add('open');
        buildCard(row.querySelector('.db-card'), r, hub, handlers);
        row.querySelector('.db-card').hidden = false;
      }
      handlers.onSelect(r.town.id);
    });

    list.appendChild(row);
    rowEls[r.town.id] = row;
  }
  container.appendChild(list);

  // ---- custom-area entry (Tier 3 drill-down) ----
  const drawEntry = document.createElement('button');
  drawEntry.className = 'db-draw-entry';
  drawEntry.textContent = 'Draw a custom area to inspect';
  drawEntry.addEventListener('click', () => handlers.onDrawCustom());
  container.appendChild(drawEntry);

  // ---- caveat ----
  // Drop the "Washington not included" line only when WSDOT is configured and a
  // WA leg actually carried WSDOT alerts; otherwise keep the honest note.
  const waActive = results.some((r) => r.waCovered);
  const cav = document.createElement('p');
  cav.className = 'db-caveat';
  cav.textContent = CAVEAT_BASE + (waActive ? CAVEAT_WA : CAVEAT_NO_WA);
  container.appendChild(cav);

  // ---- footer attribution ----
  const foot = document.createElement('p');
  foot.className = 'db-attr';
  foot.innerHTML =
    'Fire: NIFC/WFIGS perimeters &amp; VIIRS hotspots. Roads: ODOT Traffic Incidents (Oregon). ' +
    'Weather alerts: NWS. Routes: baked from OSRM. For awareness only, not an evacuation order.';
  container.appendChild(foot);

  function select(townId) {
    Object.entries(rowEls).forEach(([id, el]) => el.classList.toggle('sel', id === townId));
  }
  // open the worst row's card by default to surface the deciding hazard
  return { select, sortedFirst: sorted[0] ? sorted[0].town.id : null };
}

function buildCard(cardEl, r, hub, handlers) {
  const town = r.town;
  const bits = [];
  bits.push(`<div class="card-line"><span>Drive</span><strong>${Math.round(town.distKm)} km / ${town.durMin} min</strong></div>`);

  // deciding hazard
  let hazTxt = r.reason;
  bits.push(`<div class="card-haz">${esc(hazTxt)}</div>`);

  // nearest fire distance always shown
  if (Number.isFinite(r.nearestFireKm)) {
    bits.push(`<div class="card-line"><span>Nearest fire</span><strong>${r.nearestFireKm.toFixed(1)} km (~${mi(r.nearestFireKm)} mi)</strong></div>`);
  } else {
    bits.push(`<div class="card-line"><span>Nearest fire</span><strong>none near route</strong></div>`);
  }

  // wind (if available on the result)
  if (r.wind && Number.isFinite(r.wind.speedMph)) {
    const from = compass(r.wind.dirDeg);
    bits.push(`<div class="card-line"><span>Wind</span><strong>${Math.round(r.wind.speedMph)} mph from ${from}</strong></div>`);
  }

  // incident list (if any). When WA alerts are also present we prefix a source
  // label so the two states are distinguishable; otherwise keep the bare list.
  const hasWa = r.waHits && r.waHits.length;
  if (r.incidentHits && r.incidentHits.length) {
    const items = r.incidentHits.slice(0, 3).map((i) =>
      `<li>${esc(i.beginMarker || i.route || 'state highway')}: ${esc(i.comments || i.subType || i.category || 'incident')}</li>`).join('');
    if (hasWa) bits.push(`<div class="card-src">Oregon (ODOT)</div>`);
    bits.push(`<ul class="card-incidents">${items}</ul>`);
  }

  // Washington (WSDOT) alerts: shown just like ODOT incidents when present.
  if (hasWa) {
    const items = r.waHits.slice(0, 3).map((a) => {
      const where = a.road ? (a.milePost != null ? `${a.road} MP ${a.milePost}` : a.road) : 'WA highway';
      return `<li>${esc(where)}: ${esc(a.headline || a.category || 'alert')}</li>`;
    }).join('');
    bits.push(`<div class="card-src">Washington (WSDOT)</div>`);
    bits.push(`<ul class="card-incidents">${items}</ul>`);
  }

  // WA honesty note: keep it for WA legs UNLESS WSDOT data is configured and
  // this leg actually surfaced WA alerts (then the alerts above stand in).
  if (town.crossesWA && !r.waCovered) {
    bits.push(`<div class="card-note">This leg enters Washington. ODOT covers Oregon highways only - Washington road data is not included yet.</div>`);
  }

  // actions
  bits.push(`<div class="card-actions">` +
    `<button class="card-inspect">Inspect this ground</button>` +
    `<a class="card-maps" href="${mapsUrl(hub, town)}" target="_blank" rel="noopener">Open in Maps</a>` +
  `</div>`);

  cardEl.innerHTML = bits.join('');
  cardEl.querySelector('.card-inspect').addEventListener('click', (e) => { e.stopPropagation(); handlers.onInspect(town.id); });
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function compass(deg) {
  if (!Number.isFinite(deg)) return '?';
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

// ---- bottom-sheet snap behaviour for mobile (peek / expanded / collapsed) ----
// Returns a controller; safe to call on desktop (it just no-ops the drag).
export function setupBottomSheet(container) {
  const snaps = ['collapsed', 'peek', 'expanded'];
  let idx = 1; // default peek
  function apply() {
    container.classList.remove('snap-collapsed', 'snap-peek', 'snap-expanded');
    container.classList.add(`snap-${snaps[idx]}`);
  }
  apply();

  const handle = () => container.querySelector('.sheet-handle');
  let startY = null, startIdx = idx;

  function onDown(e) {
    const h = handle();
    if (!h || !h.contains(e.target)) return;
    startY = e.touches ? e.touches[0].clientY : e.clientY;
    startIdx = idx;
  }
  function onMove(e) {
    if (startY == null) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const dy = y - startY;
    if (Math.abs(dy) < 40) return;
    if (dy < 0 && idx < snaps.length - 1) { idx++; startY = y; apply(); }
    else if (dy > 0 && idx > 0) { idx--; startY = y; apply(); }
  }
  function onUp() { startY = null; }

  container.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  // tap the handle to toggle peek <-> expanded
  container.addEventListener('click', (e) => {
    const h = handle();
    if (h && h.contains(e.target)) {
      idx = (idx === snaps.length - 1) ? 1 : snaps.length - 1;
      apply();
    }
  });

  return {
    expand() { idx = 2; apply(); },
    peek() { idx = 1; apply(); },
    collapse() { idx = 0; apply(); },
  };
}
