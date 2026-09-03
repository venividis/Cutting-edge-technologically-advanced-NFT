import { defineConfig } from 'vite';

// Relative asset URLs make the same build work on localhost, an IPFS directory,
// and GitHub Pages (which serves projects below /repository-name/).
export default defineConfig({
  base: './',
});
