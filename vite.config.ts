import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    target: 'es2018',
    outDir: 'plugin-dist',
    emptyOutDir: false,
    modulePreload: false,
    rollupOptions: {
      output: {
        format: 'iife',
        entryFileNames: 'index.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
