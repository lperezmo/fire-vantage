import { defineConfig } from 'vite';
import { proxyTile } from './api/tiles.js';
import { proxyFires } from './api/fires.js';
import { proxyWaAlerts } from './api/wa-alerts.js';

// Mirror the Vercel serverless functions during `vite dev` so the app behaves
// identically locally and in production:
//   /api/tiles     - keyless DEM + imagery tile proxy (CORS-clean pixels)
//   /api/fires     - NIFC/WFIGS current fire perimeters + active hotspots proxy
//   /api/wa-alerts - WSDOT HighwayAlerts proxy (env-gated, Walla Walla corridor)
function devApiPlugin() {
  return {
    name: 'dev-api-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith('/api/tiles')) {
          proxyTile(req.url, res).catch(() => { res.statusCode = 502; res.end('proxy error'); });
          return;
        }
        if (req.url && req.url.startsWith('/api/fires')) {
          proxyFires(req.url, res).catch(() => { res.statusCode = 502; res.end('proxy error'); });
          return;
        }
        if (req.url && req.url.startsWith('/api/wa-alerts')) {
          proxyWaAlerts(req.url, res).catch(() => { res.statusCode = 502; res.end('proxy error'); });
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [devApiPlugin()],
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
