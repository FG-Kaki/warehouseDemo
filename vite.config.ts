import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // The local API server (server/, docs/API.md). 127.0.0.1 matches the server's bind address.
      '/api': {
        target: 'http://127.0.0.1:8787',
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
