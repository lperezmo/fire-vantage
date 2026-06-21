// Analysis worker: build the parcel, fetch the live wildfire layer, run the
// fire-vantage scoring, and ship the results (with transferable buffers) back to
// the main thread. Keeps all the heavy lifting off the UI thread. Wind is fetched
// on the main thread (Open-Meteo is CORS-open) and passed in via e.data.wind.

import { buildParcel } from '../data/build.js';
import { fetchFireData } from '../data/fires.js';
import { analyze } from './score.js';

self.onmessage = async (e) => {
  const { bbox, ui, wind } = e.data;
  const post = (pct, label) => self.postMessage({ type: 'progress', pct, label });

  try {
    const parcel = await buildParcel(bbox, (pct, label) => post(pct, label));

    post(0.93, 'Checking active fires...');
    const fire = await fetchFireData(bbox, (pct, label) =>
      post(0.93 + 0.03 * (pct || 0), label || 'Checking active fires...')
    );

    post(0.97, 'Scoring spots...');
    const result = analyze(parcel, ui, fire, wind || null);
    post(1, 'Done');

    // collect transferables
    const transfer = [
      result.heights.buffer,
      result.fuel.buffer,
      result.risk.buffer,
    ];
    for (const s of result.spots) transfer.push(s.footprint.buffer);
    result.texBitmap = parcel.texBitmap || null;
    result.texW = parcel.texW;
    result.texH = parcel.texH;
    if (parcel.texBitmap) transfer.push(parcel.texBitmap);

    self.postMessage({ type: 'result', result }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
