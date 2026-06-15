import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const base = '/Test/'

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'EdilGestionale',
        short_name: 'EdilGest',
        description: 'Gestionale completo per impresa edile',
        theme_color: '#f97316',
        background_color: '#1f2937',
        display: 'standalone',
        orientation: 'portrait-primary',
        scope: base,
        start_url: base,
        lang: 'it',
        categories: ['business', 'productivity'],
        icons: [
          { src: `${base}icons/icon-72.png`, sizes: '72x72', type: 'image/png', purpose: 'any' },
          { src: `${base}icons/icon-96.png`, sizes: '96x96', type: 'image/png', purpose: 'any' },
          { src: `${base}icons/icon-128.png`, sizes: '128x128', type: 'image/png', purpose: 'any' },
          { src: `${base}icons/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: `${base}icons/icon-384.png`, sizes: '384x384', type: 'image/png', purpose: 'any' },
          { src: `${base}icons/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
        screenshots: [
          { src: `${base}icons/screenshot-mobile.png`, sizes: '390x844', type: 'image/png', form_factor: 'narrow', label: 'Dashboard EdilGestionale' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
      },
      devOptions: { enabled: false },
    }),
  ],
})
