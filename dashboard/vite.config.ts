import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server on :18320; /api goes to the daemon on :18310 (falls back to mock data while it isn't running).
export default defineConfig({
  plugins: [react()],
  server: { port: 18320, proxy: { '/api': 'http://127.0.0.1:18310' } },
  build: { outDir: 'dist' },
})
