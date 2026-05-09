import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'SingDeck',
        short_name: 'SingDeck',
        description: 'A single-controller sing-box dashboard.',
        theme_color: '#080b0d',
        background_color: '#080b0d',
        display: 'standalone',
        start_url: './',
        icons: [
          {
            src: './pwa-icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          },
          {
            src: './pwa-icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable'
          },
          {
            src: './pwa-icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}']
      }
    })
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined;
          }

          if (id.includes('/echarts/') || id.includes('/zrender/')) {
            return 'vendor-echarts';
          }

          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('/scheduler/') ||
            id.includes('/zustand/') ||
            id.includes('/use-sync-external-store/')
          ) {
            return 'vendor-react';
          }

          if (id.includes('/lucide-react/')) {
            return 'vendor-icons';
          }

          return 'vendor';
        }
      }
    }
  },
  test: {
    environment: 'jsdom',
    setupFiles: './vitest.setup.ts',
    globals: true
  }
});
