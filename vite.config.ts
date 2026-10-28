import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        // Vendor chunks change far less often than app code, so they stay cached across deploys.
        // three.js alone is ~740 kB minified (190 kB gzip) and can't be split further; it only loads
        // with the lazy 3D view, after the HUD.
        codeSplitting: {
          groups: [
            // Groups pull in their dependencies recursively, so the libraries the HUD needs (react,
            // zustand) get their own higher-priority group; otherwise they'd land in 'r3f' and the
            // entry would statically import (and preload) three.js after all.
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler|zustand|use-sync-external-store)[\\/]/, priority: 20 },
            { name: 'three', test: /node_modules[\\/]three[\\/]/, priority: 10 },
            { name: 'r3f', test: /node_modules[\\/](@react-three|three-stdlib|troika|maath|camera-controls|meshline)/, priority: 5 },
          ],
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },
  server: {
    proxy: {
      // The local API server (server/, docs/API.md). 127.0.0.1 matches the server's bind address.
      '/api': {
        // API_PORT lets the e2e suite run its own API next to a dev one.
        target: `http://127.0.0.1:${process.env.API_PORT ?? 8787}`,
        changeOrigin: true,
        configure: (proxy) => {
          // Vite only ends a proxied response on upstream errors before headers are sent. For the
          // long-lived SSE stream that leaves the browser "connected" to a dead server, so close
          // the browser side as soon as the upstream goes away.
          proxy.on('proxyRes', (upstream, _req, res) => {
            upstream.on('close', () => {
              if (!res.writableEnded) res.destroy()
            })
          })
          proxy.on('error', (_err, _req, res) => {
            if ('headersSent' in res && res.headersSent) res.destroy()
          })
        },
      },
    },
  },
})
