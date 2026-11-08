import { defineConfig } from 'vite';

// Vite 8.3.6 (Rolldown and Oxc). JSX uses the automatic runtime.
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  build: { outDir: 'dist', target: 'es2023', chunkSizeWarningLimit: 1500 },
});
