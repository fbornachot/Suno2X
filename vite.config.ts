import { defineConfig } from 'vite';

// base relative : déployable tel quel sur GitHub Pages ou n'importe quel hébergement statique
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@mediabunny/aac-encoder'] },
});
