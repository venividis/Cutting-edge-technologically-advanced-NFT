import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  base:'./',
  build:{rollupOptions:{input:{sanctuary:resolve('index.html'),console:resolve('console.html')}}}
});
