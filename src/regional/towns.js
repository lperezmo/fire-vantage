// Static town hub + destinations for the regional Drive Board, with BAKED
// driving routes. The routes were generated once at build time from the OSRM
// demo server (router.project-osrm.org, overview=full, geometries=geojson) and
// simplified with Ramer-Douglas-Peucker at ~250 m, then committed here. We do
// NOT call OSRM at runtime (the demo server has no SLA). Each route is an array
// of [lon, lat] vertices, hub-first.
//
// Town coordinates are hardcoded (lat, lon). The hub is Pendleton, Oregon.
// crossesWA flags a leg that enters Washington, where ODOT (Oregon) road data
// does not apply; the UI shows an honest note for those legs.

export const HUB = {
  id: 'pendleton',
  name: 'Pendleton',
  state: 'OR',
  lat: 45.6721,
  lon: -118.7886,
};

export const TOWNS = [
  {
    id: 'wallawalla',
    name: 'Walla Walla',
    state: 'WA',
    lat: 46.0646,
    lon: -118.343,
    // Route from Pendleton, baked from OSRM (overview=full, RDP-simplified ~250 m).
    // distKm / durMin are the OSRM driving estimates at bake time.
    distKm: 63.3,
    durMin: 59,
    crossesWA: true,
    route: [
      [-118.7888, 45.67204], [-118.76179, 45.67306], [-118.75077, 45.67923], [-118.73494, 45.68116],
      [-118.5881, 45.74451], [-118.56571, 45.75783], [-118.54591, 45.77874], [-118.51332, 45.80176],
      [-118.48599, 45.8059], [-118.41915, 45.83743], [-118.39958, 45.85547], [-118.38186, 45.92002],
      [-118.38765, 45.93233], [-118.38865, 46.02585], [-118.34738, 46.05007], [-118.34779, 46.06223],
      [-118.34287, 46.06465],
    ],
  },
  {
    id: 'hermiston',
    name: 'Hermiston',
    state: 'OR',
    lat: 45.8404,
    lon: -119.2895,
    // Route from Pendleton, baked from OSRM (overview=full, RDP-simplified ~250 m).
    // distKm / durMin are the OSRM driving estimates at bake time.
    distKm: 46.8,
    durMin: 34,
    crossesWA: false,
    route: [
      [-118.7888, 45.67204], [-118.80621, 45.66695], [-118.80564, 45.66425], [-118.85634, 45.67914],
      [-118.88425, 45.67665], [-119.08576, 45.7422], [-119.20082, 45.7628], [-119.20557, 45.77102],
      [-119.21739, 45.77715], [-119.21865, 45.78649], [-119.23006, 45.79818], [-119.27049, 45.82276],
      [-119.28515, 45.83336], [-119.28511, 45.84048], [-119.2895, 45.84051],
    ],
  },
  {
    id: 'lagrande',
    name: 'La Grande',
    state: 'OR',
    lat: 45.3246,
    lon: -118.0877,
    // Route from Pendleton, baked from OSRM (overview=full, RDP-simplified ~250 m).
    // distKm / durMin are the OSRM driving estimates at bake time.
    distKm: 83.8,
    durMin: 59,
    crossesWA: false,
    route: [
      [-118.7888, 45.67204], [-118.77677, 45.67381], [-118.78042, 45.67029], [-118.7777, 45.66274],
      [-118.76423, 45.66462], [-118.70816, 45.65382], [-118.65355, 45.61789], [-118.64916, 45.60352],
      [-118.63815, 45.59917], [-118.6461, 45.59508], [-118.6392, 45.58612], [-118.6415, 45.57941],
      [-118.63285, 45.58088], [-118.6284, 45.57646], [-118.60724, 45.58326], [-118.60246, 45.57907],
      [-118.59055, 45.5799], [-118.50461, 45.60001], [-118.46764, 45.58965], [-118.4581, 45.58412],
      [-118.45449, 45.57724], [-118.46466, 45.55233], [-118.46189, 45.54235], [-118.38061, 45.45695],
      [-118.37641, 45.44574], [-118.35311, 45.42414], [-118.33451, 45.39941], [-118.30027, 45.37316],
      [-118.26962, 45.36146], [-118.24014, 45.34402], [-118.22956, 45.3421], [-118.2182, 45.34833],
      [-118.20228, 45.3476], [-118.18796, 45.35469], [-118.17156, 45.35188], [-118.16474, 45.345],
      [-118.12477, 45.34593], [-118.10981, 45.3379], [-118.10505, 45.32991], [-118.08787, 45.32471],
    ],
  },
  {
    id: 'bakercity',
    name: 'Baker City',
    state: 'OR',
    lat: 44.7749,
    lon: -117.8344,
    // Route from Pendleton, baked from OSRM (overview=full, RDP-simplified ~250 m).
    // distKm / durMin are the OSRM driving estimates at bake time.
    distKm: 155.1,
    durMin: 108,
    crossesWA: false,
    route: [
      [-118.7888, 45.67204], [-118.77677, 45.67381], [-118.78042, 45.67029], [-118.7777, 45.66274],
      [-118.76423, 45.66462], [-118.70816, 45.65382], [-118.65355, 45.61789], [-118.64916, 45.60352],
      [-118.63815, 45.59917], [-118.6461, 45.59508], [-118.6392, 45.58612], [-118.6415, 45.57941],
      [-118.63285, 45.58088], [-118.6284, 45.57646], [-118.60724, 45.58326], [-118.60246, 45.57907],
      [-118.59055, 45.5799], [-118.5043, 45.60003], [-118.4606, 45.58599], [-118.45448, 45.57628],
      [-118.46443, 45.55329], [-118.46267, 45.54345], [-118.38061, 45.45695], [-118.37641, 45.44574],
      [-118.35311, 45.42414], [-118.33516, 45.40011], [-118.29862, 45.37209], [-118.26962, 45.36146],
      [-118.24161, 45.34451], [-118.22907, 45.34216], [-118.21977, 45.34796], [-118.20228, 45.3476],
      [-118.18846, 45.35472], [-118.17156, 45.35188], [-118.16521, 45.34507], [-118.12561, 45.34612],
      [-118.07832, 45.33702], [-118.03814, 45.29527], [-118.01221, 45.22987], [-118.02528, 45.21046],
      [-118.01095, 45.19617], [-117.99151, 45.18662], [-117.96517, 45.16637], [-117.96537, 45.15918],
      [-117.97225, 45.14994], [-117.94309, 45.06027], [-117.92407, 45.02122], [-117.89057, 44.98188],
      [-117.8556, 44.95348], [-117.82102, 44.91647], [-117.81148, 44.78551], [-117.81498, 44.77442],
      [-117.83443, 44.7749],
    ],
  },
  {
    id: 'umatilla',
    name: 'Umatilla',
    state: 'OR',
    lat: 45.9174,
    lon: -119.3425,
    // Route from Pendleton, baked from OSRM (overview=full, RDP-simplified ~250 m).
    // distKm / durMin are the OSRM driving estimates at bake time.
    distKm: 58.5,
    durMin: 44,
    crossesWA: false,
    route: [
      [-118.7888, 45.67204], [-118.80621, 45.66695], [-118.80564, 45.66425], [-118.85634, 45.67914],
      [-118.88425, 45.67665], [-119.08576, 45.7422], [-119.20432, 45.76415], [-119.20524, 45.77067],
      [-119.21727, 45.777], [-119.21865, 45.78649], [-119.23006, 45.79818], [-119.28515, 45.83336],
      [-119.28475, 45.85683], [-119.29013, 45.85686], [-119.30569, 45.91801], [-119.34257, 45.91739],
    ],
  },
  {
    id: 'miltonfreewater',
    name: 'Milton-Freewater',
    state: 'OR',
    lat: 45.9326,
    lon: -118.3877,
    // Route from Pendleton, baked from OSRM (overview=full, RDP-simplified ~250 m).
    // distKm / durMin are the OSRM driving estimates at bake time.
    distKm: 46.7,
    durMin: 43,
    crossesWA: false,
    route: [
      [-118.7888, 45.67204], [-118.76179, 45.67306], [-118.75077, 45.67923], [-118.73494, 45.68116],
      [-118.5881, 45.74451], [-118.56571, 45.75783], [-118.54591, 45.77874], [-118.51237, 45.80229],
      [-118.48599, 45.8059], [-118.42047, 45.83645], [-118.39958, 45.85547], [-118.38165, 45.92126],
      [-118.38762, 45.9326],
    ],
  },
];

// Runtime fallback: if a town somehow has no baked route, use a straight line
// from the hub to the town coordinates so the corridor still renders.
export function routeFor(town) {
  if (Array.isArray(town.route) && town.route.length >= 2) return town.route;
  return [[HUB.lon, HUB.lat], [town.lon, town.lat]];
}

// Regional fire query bbox (a bit wider than the towns so a fire whose body
// sits just outside still registers). [west, south, east, north].
export const REGION_BBOX = { west: -120.3, south: 44.3, east: -116.4, north: 46.4 };

// City lookup for ?city= deep-links. Only Pendleton is a valid hub today; this
// keeps the door open for future hubs without changing the router.
export const CITY_HUBS = { pendleton: HUB };
