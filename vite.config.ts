import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./viewer/src', import.meta.url)) },
  },
  build: {
    outDir: 'dist/viewer',
    lib: {
      entry: 'viewer/src/main.tsx',
      name: 'BridgeViewer',
      formats: ['iife'],
      fileName: () => 'viewer.js',
      cssFileName: 'viewer',
    },
    sourcemap: false,
  },
});
