import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// iter10 m1 fix — the displayed version used to be a second copy of the number
// in src/App.jsx, kept in step by a comment saying "keep in sync with
// package.json". It drifted: the panel still said 0.8.3 after two releases had
// shipped. There is now exactly one source of truth, read at build time.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    proxy: { '/api': 'http://localhost:4000' }, // dev only
  },
});
