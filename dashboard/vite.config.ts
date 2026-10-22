import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server on :18320; /api and /v1 (health) go to the daemon on :18310 (mock data while it isn't running).
export default defineConfig({
  plugins: [react()],
  server: { port: 18320, proxy: { '/api': 'http://127.0.0.1:18310', '/v1': 'http://127.0.0.1:18310' } },
  build: { outDir: 'dist' },
})
