// MapLibre map: satellite basemap, geocode search, rectangle drawing, and the
// result overlays (spread-risk heatmap + selected-spot escape LOS footprint +
// live fire perimeters + hotspot markers + staging pins).

import maplibregl from 'maplibre-gl';

const SAT_STYLE = {
  version: 8,
  sources: {
    sat: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      maxzoom: 19,
    },
  },
  layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
};

const corners = (b) => [[b.west, b.north], [b.east, b.north], [b.east, b.south], [b.west, b.south]];

export function setupMap(onBox) {
  const map = new maplibregl.Map({
    container: 'map',
    style: SAT_STYLE,
    center: [-118.3, 45.4],
    zoom: 9,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'bottom-right');

  let drawing = false;
  let startLngLat = null;
  let box = null;
  const markers = [];
  const hotspotMarkers = [];
  let fireLegendEl = null;
  let firePopup = null;

  const riskCanvas = document.createElement('canvas');
  const fpCanvas = document.createElement('canvas');

  map.on('load', () => {
    map.addSource('draw', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw', paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.12 } });
    map.addLayer({ id: 'draw-line', type: 'line', source: 'draw', paint: { 'line-color': '#38bdf8', 'line-width': 2, 'line-dasharray': [2, 1] } });
  });

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }
  function rectFeature(b) {
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...corners(b), corners(b)[0]]] } }],
    };
  }
  const norm = (a, b) => ({
    west: Math.min(a.lng, b.lng), east: Math.max(a.lng, b.lng),
    south: Math.min(a.lat, b.lat), north: Math.max(a.lat, b.lat),
  });

  // ---- rectangle drawing (Pointer Events: works for mouse AND touch) ----
  const canvasEl = map.getCanvas();
  let startPt = null;        // {x, y} pixel of the first corner
  let drawPointerId = null;

  function beginDraw() {
    drawing = true;
    canvasEl.style.cursor = 'crosshair';
    canvasEl.style.touchAction = 'none'; // stop the page panning/zooming under the finger
    map.dragPan.disable();
    map.touchZoomRotate.disable();
    map.dragRotate.disable();
    map.doubleClickZoom.disable();
  }
  function cancelDraw() {
    drawing = false;
    canvasEl.style.cursor = '';
    canvasEl.style.touchAction = '';
    startPt = null;
    drawPointerId = null;
    map.dragPan.enable();
    map.touchZoomRotate.enable();
    map.dragRotate.enable();
    map.doubleClickZoom.enable();
  }

  const eventLngLat = (e) => {
    const r = canvasEl.getBoundingClientRect();
    return map.unproject([e.clientX - r.left, e.clientY - r.top]);
  };

  canvasEl.addEventListener('pointerdown', (e) => {
    if (!drawing) return;
    e.preventDefault();
    drawPointerId = e.pointerId;
    startPt = { x: e.clientX, y: e.clientY };
    startLngLat = eventLngLat(e);
    try { canvasEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });

  canvasEl.addEventListener('pointermove', (e) => {
    if (!drawing || !startLngLat || e.pointerId !== drawPointerId) return;
    e.preventDefault();
    map.getSource('draw')?.setData(rectFeature(norm(startLngLat, eventLngLat(e))));
  });

  function finishDraw(e) {
    if (!drawing || !startLngLat) return;
    const moved = startPt ? Math.hypot(e.clientX - startPt.x, e.clientY - startPt.y) : 0;
    // a tap (no real drag) shouldn't create a degenerate box - keep drawing
    if (moved < 12) {
      startLngLat = null;
      map.getSource('draw')?.setData(emptyFC());
      return;
    }
    box = norm(startLngLat, eventLngLat(e));
    cancelDraw();
    map.getSource('draw')?.setData(rectFeature(box));
    onBox(box);
  }
  canvasEl.addEventListener('pointerup', finishDraw);
  canvasEl.addEventListener('pointercancel', () => { startLngLat = null; drawPointerId = null; });

  // ---- overlays ----
  // Run fn once the style is ready (addSource throws otherwise).
  // On a cold browser MapLibre can take 60+ seconds to report isStyleLoaded()=true
  // even though tiles are already visible.  The isLoaded flag is set once we
  // discover the style is truly ready (to avoid redundant retries); until then
  // we poll every 100 ms so the overlays appear as soon as possible.
  let styleReady = false;
  map.on('load', () => { styleReady = true; });
  function whenStyle(fn) {
    if (styleReady || map.isStyleLoaded()) { fn(); return; }
    let done = false;
    const tryRun = () => {
      if (done) return;
      if (styleReady || map.isStyleLoaded()) {
        done = true;
        styleReady = true;
        fn();
      }
    };
    map.on('styledata', tryRun);
    map.on('load', tryRun);
    // Polling fallback: if the map is visually rendering but events haven't fired,
    // try every 100 ms (gives up after 90 s with clearInterval).
    let ticks = 0;
    const poll = setInterval(() => {
      ticks++;
      tryRun();
      if (done || ticks > 900) clearInterval(poll);
    }, 100);
  }

  // keep the draw box outline above every overlay we add
  function raiseBox() {
    if (map.getLayer('draw-line')) map.moveLayer('draw-line');
  }

  function ensureOverlay(id, canvas, b) {
    if (map.getSource(id)) {
      map.getSource(id).setCoordinates(corners(b));
      map.triggerRepaint();
    } else {
      map.addSource(id, { type: 'canvas', canvas, coordinates: corners(b), animate: false });
      map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': id === 'risk' ? 0.6 : 0.6, 'raster-resampling': 'linear' } });
    }
  }

  // ---- spread-risk heatmap (green low -> amber -> red high) ----
  function showRisk(result) { whenStyle(() => drawRisk(result)); }
  function drawRisk(result) {
    const { cgW, cgH, risk } = result;
    if (!risk || !cgW || !cgH) return;
    riskCanvas.width = cgW; riskCanvas.height = cgH;
    const ctx = riskCanvas.getContext('2d');
    const img = ctx.createImageData(cgW, cgH);
    for (let i = 0; i < risk.length; i++) {
      const [r, g, b] = ramp(risk[i]);
      const a = 40 + risk[i] * 180;
      img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    ensureOverlay('risk', riskCanvas, result.bbox);
    raiseBox();
  }

  // ---- selected-spot escape line-of-sight footprint (cyan) ----
  function showFootprint(result, spot) { whenStyle(() => drawFootprint(result, spot)); }
  function drawFootprint(result, spot) {
    const { gridW, gridH } = result;
    if (!spot || !spot.footprint || !gridW || !gridH) return;
    fpCanvas.width = gridW; fpCanvas.height = gridH;
    const ctx = fpCanvas.getContext('2d');
    const img = ctx.createImageData(gridW, gridH);
    const fp = spot.footprint;
    for (let i = 0; i < fp.length; i++) {
      // cyan LOS coverage tint
      if (fp[i]) { img.data[i * 4] = 56; img.data[i * 4 + 1] = 189; img.data[i * 4 + 2] = 248; img.data[i * 4 + 3] = 150; }
    }
    ctx.putImageData(img, 0, 0);
    ensureOverlay('fp', fpCanvas, result.bbox);
    raiseBox();
  }

  // ---- live fire perimeters + hotspots ----
  function showFire(result) { whenStyle(() => drawFire(result)); }
  function drawFire(result) {
    removeFire();
    const fire = result && result.fire;
    if (!fire || !fire.ok) return;

    // perimeters: GeoJSON polygons, faint red fill + red outline.
    // fire.perimeters is a FeatureCollection; extract the features array.
    const perimFC = fire.perimeters && Array.isArray(fire.perimeters.features)
      ? fire.perimeters
      : { type: 'FeatureCollection', features: [] };
    const perims = perimFC.features;
    if (perims.length) {
      map.addSource('fire-perim', { type: 'geojson', data: perimFC });
      map.addLayer({
        id: 'fire-perim-fill', type: 'fill', source: 'fire-perim',
        paint: { 'fill-color': '#ff3b30', 'fill-opacity': 0.12 },
      });
      map.addLayer({
        id: 'fire-perim-line', type: 'line', source: 'fire-perim',
        paint: { 'line-color': '#ff3b30', 'line-width': 2 },
      });

      // click a perimeter -> popup "Name - N acres - C% contained"
      map.on('click', 'fire-perim-fill', onPerimClick);
      map.on('mouseenter', 'fire-perim-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'fire-perim-fill', () => { map.getCanvas().style.cursor = ''; });
    }

    // hotspots: glowing markers, capped for perf
    addHotspotMarkers(fire.hotspots);

    ensureFireLegend();
    raiseBox();
  }

  function onPerimClick(e) {
    const f = e.features && e.features[0];
    if (!f) return;
    const p = f.properties || {};
    const name = p.poly_IncidentName || p.IncidentName || 'Wildfire';
    const acresRaw = p.attr_IncidentSize ?? p.poly_GISAcres;
    const acres = Number.isFinite(+acresRaw) ? Math.round(+acresRaw).toLocaleString() : null;
    const contRaw = p.attr_PercentContained;
    const cont = Number.isFinite(+contRaw) ? Math.round(+contRaw) : null;
    const bits = [escapeHtml(name)];
    if (acres !== null) bits.push(`${acres} acres`);
    if (cont !== null) bits.push(`${cont}% contained`);
    if (firePopup) firePopup.remove();
    firePopup = new maplibregl.Popup({ closeButton: true, offset: 8 })
      .setLngLat(e.lngLat)
      .setHTML(`<div style="font:12px system-ui,sans-serif;color:#1c1411">${bits.join(' - ')}</div>`)
      .addTo(map);
  }

  function addHotspotMarkers(hotspots) {
    clearHotspotMarkers();
    let list = Array.isArray(hotspots) ? hotspots : [];
    const CAP = 400;
    if (list.length > CAP) {
      // even sampling down to the cap
      const step = list.length / CAP;
      const sampled = [];
      for (let i = 0; i < CAP; i++) sampled.push(list[Math.floor(i * step)]);
      list = sampled;
    }
    for (const h of list) {
      if (!h || !Number.isFinite(h.lon) || !Number.isFinite(h.lat)) continue;
      const el = document.createElement('div');
      el.className = 'hotspot-mk';
      // newer detections (low ageHours) glow brighter
      if (Number.isFinite(h.ageHours)) {
        el.style.opacity = String(Math.max(0.45, 1 - h.ageHours / 48));
      }
      if (Number.isFinite(h.confidence)) el.title = `hotspot - confidence ${h.confidence}`;
      const m = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([h.lon, h.lat]).addTo(map);
      hotspotMarkers.push(m);
    }
  }

  function ensureFireLegend() {
    if (fireLegendEl) { fireLegendEl.style.display = ''; return; }
    const el = document.createElement('div');
    el.className = 'map-legend';
    el.innerHTML = `
      <span class="ml-title">Live fire</span>
      <span class="ml-item"><i class="ml-perim"></i>fire perimeter</span>
      <span class="ml-item"><i class="ml-hot"></i>active hotspot</span>`;
    map.getContainer().appendChild(el);
    fireLegendEl = el;
  }

  function setFireVisibility(visible) {
    const vis = visible ? 'visible' : 'none';
    for (const id of ['fire-perim-fill', 'fire-perim-line']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
    hotspotMarkers.forEach((m) => { m.getElement().style.display = visible ? '' : 'none'; });
    if (fireLegendEl) fireLegendEl.style.display = visible ? '' : 'none';
  }

  // robust whether called before or after showFire
  function toggleFire(visible) { whenStyle(() => setFireVisibility(visible)); }

  function setRiskVisibility(visible) {
    const vis = visible ? 'visible' : 'none';
    if (map.getLayer('risk')) map.setLayoutProperty('risk', 'visibility', vis);
  }
  function toggleRisk(visible) { whenStyle(() => setRiskVisibility(visible)); }

  function clearHotspotMarkers() { hotspotMarkers.forEach((m) => m.remove()); hotspotMarkers.length = 0; }
  function removeFire() {
    map.off('click', 'fire-perim-fill', onPerimClick);
    for (const id of ['fire-perim-fill', 'fire-perim-line']) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource('fire-perim')) map.removeSource('fire-perim');
    clearHotspotMarkers();
    if (firePopup) { firePopup.remove(); firePopup = null; }
    if (fireLegendEl) { fireLegendEl.remove(); fireLegendEl = null; }
  }

  function clearMarkers() { markers.forEach((m) => m.remove()); markers.length = 0; }

  // staging pins, numbered by rank, click -> onSelect(rank)
  function addMarkers(spots, onSelect) {
    clearMarkers();
    spots.forEach((s) => {
      const el = document.createElement('div');
      el.className = 'staging-mk';
      const inner = document.createElement('span');
      inner.textContent = s.rank; inner.style.transform = 'rotate(45deg)';
      el.appendChild(inner);
      el.addEventListener('click', (ev) => { ev.stopPropagation(); onSelect(s.rank); });
      const m = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([s.lon, s.lat]).addTo(map);
      markers.push(m);
    });
  }

  function clearAll() {
    box = null;
    clearMarkers();
    map.getSource('draw')?.setData(emptyFC());
    for (const id of ['risk', 'fp']) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
    removeFire();
  }

  async function geocode(q) {
    const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) { const lat = +m[1], lon = +m[2]; map.flyTo({ center: [lon, lat], zoom: 14 }); return true; }
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, {
        headers: { 'Accept-Language': 'en' },
      });
      const data = await r.json();
      if (!data.length) return false;
      const { lat, lon, boundingbox } = data[0];
      if (boundingbox) {
        map.fitBounds([[+boundingbox[2], +boundingbox[0]], [+boundingbox[3], +boundingbox[1]]], { maxZoom: 14, padding: 40 });
      } else {
        map.flyTo({ center: [+lon, +lat], zoom: 14 });
      }
      return true;
    } catch { return false; }
  }

  function setBox(b, { fit = true } = {}) {
    box = b;
    const apply = () => map.getSource('draw')?.setData(rectFeature(b));
    if (map.isStyleLoaded()) apply(); else map.once('load', apply);
    if (fit) map.fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 60, duration: 0 });
  }

  return {
    map, beginDraw, cancelDraw, geocode, setBox,
    showRisk, showFootprint, showFire, toggleFire, toggleRisk, addMarkers, clearAll,
    getBox: () => box,
    flyToSpot: (s) => map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 14.5) }),
  };
}

// risk 0..1 -> green(low) .. amber .. red(high)
function ramp(t) {
  t = Math.max(0, Math.min(1, t));
  if (t < 0.5) { const u = t / 0.5; return [31 + u * 206, 111 + u * 55, 58 + u * 13]; }  // green -> amber
  const u = (t - 0.5) / 0.5;
  return [237 + u * 2, 166 - u * 98, 71 - u * 23];                                       // amber -> red
}

const escapeHtml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
