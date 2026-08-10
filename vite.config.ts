import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

function getBuildId(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return String(Date.now())
  }
}

const buildId = getBuildId()

export default defineConfig({
  plugins: [
    react(),
    // Emits dist/version.json with the same build id baked into __APP_BUILD__ below,
    // so a running client (e.g. a stale tab that loaded an older bundle before a
    // deploy) can detect it's outdated and force-reload — see src/lib/version.ts.
    {
      name: 'emit-version-json',
      writeBundle(options) {
        const outDir = options.dir ?? 'dist'
        writeFileSync(path.resolve(outDir, 'version.json'), JSON.stringify({ build: buildId }))
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    __APP_BUILD__: JSON.stringify(buildId),
  },
  build: {
    sourcemap: false,   // never emit sourcemaps in production bundle
  },
  server: {
    host: 'localhost',  // bind dev server to loopback (esbuild CORS CVE mitigation)
  },
})
