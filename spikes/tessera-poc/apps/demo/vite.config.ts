import { defineConfig } from 'vite';

// Vite 8.3.6 (Rolldown and Oxc). JSX uses the automatic runtime. Workspace packages export their TypeScript source, so
// Vite compiles them with the app; plugin entries are dynamic imports and become separate chunks (lazy loading).
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  build: { outDir: 'dist', sourcemap: true, target: 'es2023', chunkSizeWarningLimit: 1500 },
  server: { port: 5173, strictPort: false },
});
