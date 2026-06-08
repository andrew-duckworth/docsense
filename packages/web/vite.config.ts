/*
 * WHAT THIS FILE DOES
 * Configures the Vite dev server for the React frontend. The only non-default
 * setting is the proxy block, which forwards /upload, /query, and /health
 * requests to the Express API running on port 3001.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * Vite is the build tool and dev server. In development, React runs on
 * localhost:5173 and the API runs on localhost:3001. Without the proxy,
 * every fetch() call from the browser would hit a CORS error because the
 * two origins differ. The proxy makes requests appear same-origin to the
 * browser by forwarding them at the server level.
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * A reverse proxy is the same pattern used in production (nginx, AWS ALB)
 * to route /api/* traffic to a backend service. Vite's proxy is just a
 * dev-time version of that same idea.
 *
 * INTERVIEW TALKING POINT
 * "In dev, Vite proxies API calls so there are no CORS issues. In production
 * you'd replace this with an nginx location block or a cloud load balancer
 * rule — the frontend code doesn't change at all."
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/upload': { target: 'http://localhost:3001', changeOrigin: true },
      '/query':  { target: 'http://localhost:3001', changeOrigin: true },
      '/health': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
});
