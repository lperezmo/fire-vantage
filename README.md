# Fire Vantage

Wildfire situational awareness and planning for the western US. Draw a box on the
map (or search a place), and the app pulls real elevation, satellite imagery, and
a vegetation fuel layer for that ground, overlays live interagency fire perimeters
and recent satellite hotspots, reads the current wind, and runs a client-side
analysis: a spread-risk model over the area and a line-of-sight pass that ranks
safe staging spots, fire-watch lookouts, or the highest-risk cells, each explained
in plain English, with a 3D view of the terrain.

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

Any area works through the shareable deep link, for example
`?bbox=-118.6,45.2,-118.0,45.6`.

## Run locally

```sh
npm install
npm run dev      # http://localhost:5173, serverless proxies mirrored as dev middleware
npm run build    # production build into dist/
npm run preview  # serve the production build
```

Node 18 or newer. The `/api/tiles` and `/api/fires` routes run as Vercel
serverless functions in production and as Vite dev middleware locally, so the app
behaves identically in both.

## Data and limits

Fire perimeters and hotspots reflect the public NIFC feeds and can lag real
conditions; perimeters are mapped periodically and hotspots are satellite passes,
not a continuous watch. The spread model is a transparent terrain, fuel, and wind
heuristic for situational awareness, not a calibrated fire-behavior forecast. Fuel
is inferred from imagery, not a ground survey.

This tool is for awareness and planning only. It is not a fire forecast, an
evacuation order, or a substitute for official guidance. In a real fire, follow
InciWeb, local authorities, and emergency services.
