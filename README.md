# Fire Vantage

Wildfire situational awareness and driving decisions for eastern Oregon. The app
opens to a **Drive Board** centered on Pendleton: a map plus a worst-first list of
nearby destination towns, each with a one-glance CLEAR / CAUTION / AVOID verdict
for driving there, based on active fire near the route and real ODOT road
incidents. From any corridor you can drop into the original **Inspect this ground**
tool: draw a box on the map and the app pulls real elevation, satellite imagery,
and a vegetation fuel layer for that ground, overlays live interagency fire
perimeters and recent satellite hotspots, reads the current wind, and runs a
client-side analysis (a spread-risk model over the area and a line-of-sight pass
that ranks safe staging spots, fire-watch lookouts, or the highest-risk cells,
each explained in plain English, with a 3D view of the terrain).

## Drive Board (default view)

On load you see, leaving Pendleton:

- A headline verdict bar (for example "2 of 7 routes affected"), red, amber, or
  green.
- A worst-first list of destination towns (Walla Walla, Hermiston, La Grande,
  Baker City, Umatilla, Milton-Freewater), each a colored chip plus the deciding
  reason plus the real nearest-fire distance.
- Tap a row to expand a corridor card: drive distance and time, the deciding
  hazard, wind, and two buttons. "Open in Maps" deep-links Google Maps directions
  for the leg; "Inspect this ground" pre-draws a box around the worst stretch and
  runs the full terrain analysis.

How a verdict is decided (each route is sampled along its baked driving polyline):

- AVOID: a sample inside a fire perimeter, or fire within about 2 km of the route,
  or an ODOT closure or wildfire incident within about 2 km.
- CAUTION: fire within about 8 km (5 mi) of the route, or a non-closure ODOT
  incident within about 2 km.
- CLEAR: nearest fire beyond about 8 km and no incidents on the route.

Honesty rules: verdicts are phrased as "fire near route" and show the actual
incident text; the app never claims a road is open. If live data fails to load a
route shows CAUTION, never a false CLEAR. A permanent caveat reads: incidents are
ODOT-reported on Oregon state highways, confirm on TripCheck, and Washington roads
are not included yet. The Walla Walla leg crosses into Washington and uses
Oregon-side ODOT plus fire proximity only, with an inline note.

Data sources for the Drive Board (all keyless): NIFC/WFIGS fire perimeters and
VIIRS hotspots through the `/api/fires` proxy on a wide regional bbox; ODOT
Traffic Incidents fetched directly in the browser (CORS-open); NWS active alerts
for a Red Flag Warning or Fire Weather Watch banner; Open-Meteo wind. Driving
routes are baked from the OSRM demo server once at build time and committed, so
there is no runtime dependency on that server (a missing route falls back to a
straight line).

The regional path runs entirely on the main thread with plain GeoJSON and
arithmetic; the heavy terrain and viewshed pipeline only spins up when you inspect
a specific area.

[![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![Three.js](https://img.shields.io/badge/Three.js-r170-000000?logo=three.js&logoColor=white)](https://threejs.org)
[![MapLibre GL](https://img.shields.io/badge/MapLibre_GL-4-396CB2?logo=maplibre&logoColor=white)](https://maplibre.org)

No API keys. Everything runs on free, keyless public data:

- Elevation: Mapzen/AWS Terrain Tiles (Terrarium-encoded PNG, NASA/USGS derived).
- Imagery and fuel: Esri World Imagery, classified into a canopy/fuel density layer.
- Fire perimeters: NIFC/WFIGS Interagency Perimeters (Current), the authoritative
  national feed of active and recent wildfire perimeters.
- Active fire: NIFC satellite (VIIRS) thermal hotspots, a roughly seven-day rolling
  set of heat detections.
- Wind: Open-Meteo current wind speed, direction, and gusts.
- Tiles and fire layers are fetched on demand through small serverless proxies
  (the NIFC services are keyless but not CORS-open); wind is fetched directly.

## How it works

1. You draw the ground. Search to a location, then drag a rectangle over the area
   you want to assess (soft cap about 60 sq km).
2. The app builds the parcel. A Web Worker fetches elevation and imagery tiles,
   decodes a metric heightmap, and classifies a vegetation fuel density mask
   (slope-suppressed so bare cliffs do not read as fuel).
3. It pulls live fire data. Current interagency perimeters and recent VIIRS
   hotspots in and around the area come through the serverless proxy; the nearest
   active fire distance is computed for the area.
4. It reads the wind. Current wind speed and direction at the area center come from
   Open-Meteo and feed both the display and the spread model.
5. It models spread risk. For every cell the app blends three transparent factors:

   | Factor | What raises risk |
   | --- | --- |
   | Fuel | Denser canopy/vegetation carries fire faster |
   | Slope | Fire spreads faster uphill, so upslope cells are riskier |
   | Wind | Cells downwind of higher fuel and of active fire are riskier |

   Cells on or next to an active perimeter or hotspot are treated as maximum risk,
   and the risk decays with distance from active fire.

6. It ranks spots. Depending on your goal it casts line-of-sight from a grid of
   candidate positions (eye at ground plus your chosen height, terrain plus tall
   fuel as the occluder) and blends the factors below:

   - Safest staging spots: low local risk, far from the spread path, open and level
     low-fuel ground, with a clear line of sight to the approaching fire.
   - Best fire-watch lookouts: maximize the visible area of fire-prone ground.
   - Highest-risk cells: surface the most dangerous ground directly.

   Each result gets a 55 to 99 rating, a plain-English reason, the visible
   fire-prone acreage, and the distance to the nearest active fire.

7. You explore. Toggle the spread-risk heatmap and the fire overlay, open any spot
   in a 3D terrain view with the risk tint, its line-of-sight footprint, and a wind
   arrow, and export the ranked spots as GPX or KML.

Deep links: the Drive Board accepts `?city=pendleton` (the default hub) and
`?to=<town id>` to preselect a corridor (for example `?to=lagrande`). Any inspect
area works through the shareable box link, for example
`?bbox=-118.6,45.2,-118.0,45.6`, which opens straight into the terrain analysis as
before.

### Basemap

A small toggle at the top-right of the map switches the basemap between
**Satellite** (Esri World Imagery, the default) and **Street** (Esri World
Topographic, which carries street and topo detail you can zoom into). Both are
keyless Esri raster tiles. On the satellite basemap a keyless Esri reference
overlay adds place and road labels so it is not label-less. The choice is saved
to `localStorage`. Switching only swaps the basemap source tiles, so the fire,
route, town, and draw-box overlays are untouched and the draw-a-box analysis
keeps working on either basemap.

### Place-name labels

Each destination town and the Pendleton hub carry a name label beside their
marker, with a dark halo so they stay readable on the bright satellite imagery.
The verdict color stays on the dot; the label text is neutral so the two never
clash.

### Washington road alerts (WSDOT)

The Walla Walla leg crosses into Washington, where ODOT data does not apply.
When a free WSDOT access code is configured (see the env var below) the app pulls
**WSDOT HighwayAlerts** for the Walla Walla / US-12 corridor through the
`/api/wa-alerts` serverless proxy and folds them into that leg's verdict exactly
like ODOT incidents: a closure or wildfire forces AVOID, any other alert is
CAUTION. The proxy is env-gated and graceful: with no key set it returns
`{ "configured": false, "alerts": [] }` (HTTP 200, never 500) and the app keeps
its honest "Washington roads are not included yet" note; if WSDOT is down it
degrades to the same note rather than crashing. The access code never reaches the
browser; it is read server-side from the env var.

#### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `WSDOT_ACCESS_CODE` | No | Free WSDOT Traveler Information API access code. When set, the `/api/wa-alerts` proxy pulls Washington HighwayAlerts for the Walla Walla corridor and the Walla Walla leg reflects WSDOT closures. When unset, the app degrades gracefully to the honest "Washington roads not included yet" note. Set it in the Vercel project environment (and in a local `.env`, copied from `.env.example`, for dev). Request a free code at https://wsdot.wa.gov/traffic/api/ |

## Run locally

```sh
npm install
npm run dev      # http://localhost:5173, serverless proxies mirrored as dev middleware
npm run build    # production build into dist/
npm run preview  # serve the production build
```

Node 18 or newer. The `/api/tiles`, `/api/fires`, and `/api/wa-alerts` routes run
as Vercel serverless functions in production and as Vite dev middleware locally,
so the app behaves identically in both. To exercise the Washington alerts path in
dev, copy `.env.example` to `.env` and set `WSDOT_ACCESS_CODE`; without it the WA
leg shows the honest "not included yet" note.

## Data and limits

Fire perimeters and hotspots reflect the public NIFC feeds and can lag real
conditions; perimeters are mapped periodically and hotspots are satellite passes,
not a continuous watch. The spread model is a transparent terrain, fuel, and wind
heuristic for situational awareness, not a calibrated fire-behavior forecast. Fuel
is inferred from imagery, not a ground survey.

This tool is for awareness and planning only. It is not a fire forecast, an
evacuation order, or a substitute for official guidance. In a real fire, follow
InciWeb, local authorities, and emergency services.
