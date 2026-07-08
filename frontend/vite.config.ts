import { existsSync, readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiTarget = process.env.VITE_API_TARGET || 'http://127.0.0.1:8000'
const port = Number(process.env.NOTIE_FRONTEND_PORT || process.env.PORT || 5173)
const pfxPath = process.env.NOTIE_HTTPS_PFX
const https =
  pfxPath && existsSync(pfxPath)
    ? {
        pfx: readFileSync(pfxPath),
        passphrase: process.env.NOTIE_HTTPS_PFX_PASSPHRASE || '',
      }
    : undefined

export default defineConfig({
  plugins: [react()],
  server: {
    https,
    port,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
})
