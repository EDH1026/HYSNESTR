import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    sourcemap: false,   // never emit sourcemaps in production bundle
  },
  server: {
    host: 'localhost',  // bind dev server to loopback (esbuild CORS CVE mitigation)
  },
})
