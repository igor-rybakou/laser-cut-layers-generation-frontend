import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const BACKEND_URL = 'http://localhost:8010';

// Output lands directly in the backend repo's web/dist, which
// workbench/main.py mounts as static files at "/". Both repos are expected
// to be checked out as siblings on the same machine.
const BACKEND_WEB_DIST = resolve(__dirname, '../laser-cut-layers-generation-api/web/dist');

export default defineConfig({
  base: './',
  build: {
    outDir: BACKEND_WEB_DIST,
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
      },
    },
  },
});
