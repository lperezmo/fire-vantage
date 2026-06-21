// MapLibre layers for the regional Drive Board. Strictly namespaced so nothing
// collides with the box-mode layers (fire-perim-*, risk, fp, draw-*):
//   route-lines        : colored driving corridors
//   town-markers       : DOM markers for hub + destinations (managed here)
//   region-hotspots    : cheap circle layer for VIIRS hotspots
//   region-fire-fill/-line : fire perimeters (regional copy, same look as box)
//
// All draw calls go through whenStyle(map, fn) so they are safe before the
// style settles (cold start). Verdict colors match the panel chips.

import maplibregl from 'maplibre-gl';
import { VERDICT } from './proximity.js';

export const VERDICT_COLOR = {
  [VERDICT.AVOID]: '#ef4444',
  [VERDICT.CAUTION]: '#f5a623',
  [VERDICT.CLEAR]: '#22c55e',
  [VERDICT.UNKNOWN]: '#f5a623',
};

// Run fn once the style is ready (addSource/addLayer throw otherwise). Mirrors
// the proven cold-start poll in ui/map.js.
export function whenStyle(map, fn) {
  if (map.isStyleLoaded()) { fn(); return; }
  let done = false;
  const tryRun = () => {
    if (done) return;
    if (map.isStyleLoaded()) { done = true; fn(); }
  };
  map.on('styledata', tryRun);
  map.on('load', tryRun);
  let ticks = 0;
  const poll = setInterval(() => {
    ticks++;
    tryRun();
    if (done || ticks > 900) clearInterval(poll);
  }, 100);
}

const ROUTE_SOURCE = 'route-src';
const ROUTE_CASE = 'route-lines-case';
const ROUTE_LINE = 'route-lines';
const HOTSPOT_SOURCE = 'region-hotspot-src';
const HOTSPOT_LAYER = 'region-hotspots';
const FIRE_SOURCE = 'region-fire-src';
const FIRE_FILL = 'region-fire-fill';
const FIRE_LINE = 'region-fire-line';

export function createRegionalLayers(map) {
  const townMarkers = [];
  let firePopup = null;

  function routeFC(routeResults) {
    return {
      type: 'FeatureCollection',
      features: routeResults.map((r) => ({
        type: 'Feature',
        properties: { id: r.town.id, color: VERDICT_COLOR[r.verdict] || VERDICT_COLOR.caution },
        geometry: { type: 'LineString', coordinates: r.town.route },
      })),
    };
  }

  // ---- route corridors ----
  function setRoutes(routeResults) {
    whenStyle(map, () => {
      const data = routeFC(routeResults);
      if (map.getSource(ROUTE_SOURCE)) {
        map.getSource(ROUTE_SOURCE).setData(data);
      } else {
        map.addSource(ROUTE_SOURCE, { type: 'geojson', data });
        map.addLayer({
          id: ROUTE_CASE, type: 'line', source: ROUTE_SOURCE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#0b0805', 'line-width': 7, 'line-opacity': 0.6 },
        });
        map.addLayer({
          id: ROUTE_LINE, type: 'line', source: ROUTE_SOURCE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-width': 4 },
        });
      }
    });
  }

  function highlightRoute(townId) {
    whenStyle(map, () => {
      if (!map.getLayer(ROUTE_LINE)) return;
      map.setPaintProperty(ROUTE_LINE, 'line-width',
        townId ? ['case', ['==', ['get', 'id'], townId], 7, 3] : 4);
      map.setPaintProperty(ROUTE_LINE, 'line-opacity',
        townId ? ['case', ['==', ['get', 'id'], townId], 1, 0.45] : 1);
    });
  }

  // ---- town + hub markers ----
  // Each marker is a dot plus a NAME label beside it. The label is a DOM element
  // (not a MapLibre symbol layer) so we stay keyless with no glyph server, and it
  // gets a dark halo so it reads on the bright satellite basemap. The verdict
  // color lives on the dot only; the label text is neutral so it never clashes.
  function dotWithLabel(name, dotClass, title) {
    const wrap = document.createElement('div');
    wrap.className = 'town-mk-wrap';
    const dot = document.createElement('div');
    dot.className = dotClass;
    if (title) dot.title = title;
    const label = document.createElement('span');
    label.className = 'town-label';
    label.textContent = name;
    wrap.appendChild(dot);
    wrap.appendChild(label);
    return { wrap, dot };
  }

  function setTownMarkers(hub, routeResults, onSelect) {
    clearTownMarkers();
    // hub (distinct), labeled "Pendleton"
    const hubParts = dotWithLabel(hub.name, 'hub-mk', `${hub.name} (you are here)`);
    hubParts.wrap.classList.add('is-hub');
    townMarkers.push(new maplibregl.Marker({ element: hubParts.wrap, anchor: 'center' })
      .setLngLat([hub.lon, hub.lat]).addTo(map));

    for (const r of routeResults) {
      const parts = dotWithLabel(r.town.name, `town-mk verdict-${r.verdict}`, `${r.town.name} - ${r.verdict.toUpperCase()}`);
      parts.wrap.style.cursor = 'pointer';
      parts.wrap.addEventListener('click', (ev) => { ev.stopPropagation(); onSelect(r.town.id); });
      townMarkers.push(new maplibregl.Marker({ element: parts.wrap, anchor: 'center' })
        .setLngLat([r.town.lon, r.town.lat]).addTo(map));
    }
  }

  function clearTownMarkers() {
    townMarkers.forEach((m) => m.remove());
    townMarkers.length = 0;
  }

  // ---- VIIRS hotspots (cheap circle layer, not DOM markers) ----
  function setHotspots(hotspots) {
    whenStyle(map, () => {
      const feats = (hotspots || [])
        .filter((h) => Number.isFinite(h.lon) && Number.isFinite(h.lat))
        .map((h) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [h.lon, h.lat] } }));
      const data = { type: 'FeatureCollection', features: feats };
      if (map.getSource(HOTSPOT_SOURCE)) {
        map.getSource(HOTSPOT_SOURCE).setData(data);
      } else {
        map.addSource(HOTSPOT_SOURCE, { type: 'geojson', data });
        map.addLayer({
          id: HOTSPOT_LAYER, type: 'circle', source: HOTSPOT_SOURCE,
          paint: {
            'circle-radius': 4,
            'circle-color': '#ffdd33',
            'circle-stroke-color': '#ff6b00',
            'circle-stroke-width': 1.2,
            'circle-opacity': 0.85,
          },
        });
      }
    });
  }

  // ---- fire perimeters (regional copy; same red look as box mode) ----
  function setFirePerimeters(perimFC) {
    whenStyle(map, () => {
      const data = (perimFC && Array.isArray(perimFC.features))
        ? perimFC : { type: 'FeatureCollection', features: [] };
      if (map.getSource(FIRE_SOURCE)) {
        map.getSource(FIRE_SOURCE).setData(data);
      } else {
        map.addSource(FIRE_SOURCE, { type: 'geojson', data });
        map.addLayer({
          id: FIRE_FILL, type: 'fill', source: FIRE_SOURCE,
          paint: { 'fill-color': '#ff3b30', 'fill-opacity': 0.12 },
        });
        map.addLayer({
          id: FIRE_LINE, type: 'line', source: FIRE_SOURCE,
          paint: { 'line-color': '#ff3b30', 'line-width': 2 },
        });
        map.on('click', FIRE_FILL, onPerimClick);
        map.on('mouseenter', FIRE_FILL, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', FIRE_FILL, () => { map.getCanvas().style.cursor = ''; });
      }
    });
  }

  function onPerimClick(e) {
    const f = e.features && e.features[0];
    if (!f) return;
    const p = f.properties || {};
    const name = p.poly_IncidentName || p.attr_IncidentName || 'Wildfire';
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

  // ---- fit to all towns ----
  function fitToTowns(hub, towns) {
    whenStyle(map, () => {
      let minX = hub.lon, maxX = hub.lon, minY = hub.lat, maxY = hub.lat;
      for (const t of towns) {
        minX = Math.min(minX, t.lon); maxX = Math.max(maxX, t.lon);
        minY = Math.min(minY, t.lat); maxY = Math.max(maxY, t.lat);
      }
      map.fitBounds([[minX, minY], [maxX, maxY]], { padding: { top: 60, bottom: 60, left: 60, right: 60 }, duration: 0, maxZoom: 9 });
    });
  }

  function destroy() {
    clearTownMarkers();
    if (firePopup) { firePopup.remove(); firePopup = null; }
    map.off('click', FIRE_FILL, onPerimClick);
    for (const id of [ROUTE_LINE, ROUTE_CASE, HOTSPOT_LAYER, FIRE_FILL, FIRE_LINE]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of [ROUTE_SOURCE, HOTSPOT_SOURCE, FIRE_SOURCE]) {
      if (map.getSource(id)) map.removeSource(id);
    }
  }

  return { setRoutes, highlightRoute, setTownMarkers, clearTownMarkers, setHotspots, setFirePerimeters, fitToTowns, destroy };
}

const escapeHtml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
