// Results panel: ranked staging-spot cards with a spread-risk legend, plus
// GPX and KML waypoint export for the spots.

export function renderResults(container, spots, { onSelect, onView3d }) {
  container.innerHTML = '';
  if (!spots || !spots.length) {
    container.innerHTML = '<p class="empty">No spots found - try a larger or more varied area.</p>';
    return { select: () => {} };
  }

  const legend = document.createElement('div');
  legend.className = 'legend risk';
  legend.innerHTML = '<span>low risk</span><div class="ramp"></div><span>high risk</span>';
  container.appendChild(legend);

  const cards = [];
  spots.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="rank">
        <span class="badge">${s.rank}</span>
        <strong>Spot ${s.rank}</strong>
      </div>
      <div class="score">${scoreLine(s)}</div>
      <p class="why">${escapeHtml(s.why)}.</p>
      <div class="coords">${s.lat.toFixed(5)}, ${s.lon.toFixed(5)} - ${s.elevation} m</div>
      <button class="view3d">View in 3D</button>`;
    card.addEventListener('click', () => onSelect(s.rank));
    card.querySelector('.view3d').addEventListener('click', (e) => { e.stopPropagation(); onView3d(s.rank); });
    container.appendChild(card);
    cards.push(card);
  });

  const exportRow = document.createElement('div');
  exportRow.className = 'export-row';
  exportRow.style.marginTop = '8px';
  exportRow.style.display = 'flex';
  exportRow.style.gap = '6px';

  const gpxBtn = document.createElement('button');
  gpxBtn.className = 'ghost';
  gpxBtn.style.flex = '1';
  gpxBtn.textContent = 'Export GPX';
  gpxBtn.addEventListener('click', () => downloadGpx(spots));

  const kmlBtn = document.createElement('button');
  kmlBtn.className = 'ghost';
  kmlBtn.style.flex = '1';
  kmlBtn.textContent = 'Export KML';
  kmlBtn.addEventListener('click', () => downloadKml(spots));

  exportRow.appendChild(gpxBtn);
  exportRow.appendChild(kmlBtn);
  container.appendChild(exportRow);

  function select(rank) {
    cards.forEach((c, i) => c.classList.toggle('sel', spots[i].rank === rank));
  }
  return { select };
}

const fireDist = (s) =>
  (Number.isFinite(s.nearestFireKm) ? `${s.nearestFireKm.toFixed(1)} km from fire` : 'no active fire nearby');

function scoreLine(s) {
  const acres = Math.round(s.visibleFireAcres || 0).toLocaleString();
  return `score ${s.rating} - sees ~${acres} ac fuel - ${fireDist(s)}`;
}

const spotDesc = (s) =>
  `Rank ${s.rank} - score ${s.rating} - sees ~${Math.round(s.visibleFireAcres || 0)} acres fuel - ${fireDist(s)}. ${s.why}.`;

function downloadGpx(spots) {
  const pts = spots.map((s) =>
    `  <wpt lat="${s.lat.toFixed(6)}" lon="${s.lon.toFixed(6)}">
    <ele>${s.elevation}</ele>
    <name>Spot ${s.rank} (score ${s.rating})</name>
    <desc>${escapeXml(spotDesc(s))}</desc>
  </wpt>`).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Fire Vantage" xmlns="http://www.topografix.com/GPX/1/1">
${pts}
</gpx>`;
  download(gpx, 'application/gpx+xml', 'fire-vantage-spots.gpx');
}

function downloadKml(spots) {
  const placemarks = spots.map((s) =>
    `    <Placemark>
      <name>Spot ${s.rank} (score ${s.rating})</name>
      <description>${escapeXml(spotDesc(s))}</description>
      <Point><coordinates>${s.lon.toFixed(6)},${s.lat.toFixed(6)},${s.elevation}</coordinates></Point>
    </Placemark>`).join('\n');
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Fire Vantage</name>
${placemarks}
  </Document>
</kml>`;
  download(kml, 'application/vnd.google-earth.kml+xml', 'fire-vantage-spots.kml');
}

function download(text, mime, filename) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

const escapeXml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const escapeHtml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
