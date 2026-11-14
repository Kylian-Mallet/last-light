import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5178 },
  preview: { port: 4178 },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
