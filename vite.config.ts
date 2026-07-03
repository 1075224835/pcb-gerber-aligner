import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^buffer$/, replacement: resolve(projectRoot, 'node_modules/buffer/') },
      { find: /^events$/, replacement: resolve(projectRoot, 'node_modules/events/') },
      {
        find: /^process$/,
        replacement: resolve(projectRoot, 'node_modules/process/browser.js'),
      },
      {
        find: /^process\/browser\.js$/,
        replacement: resolve(projectRoot, 'node_modules/process/browser.js'),
      },
      { find: /^util$/, replacement: resolve(projectRoot, 'node_modules/util/') },
    ],
  },
  optimizeDeps: {
    include: ['buffer', 'events', 'process', 'util'],
  },
  define: {
    global: 'globalThis',
    'process.env': {},
  },
})
