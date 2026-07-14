import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/lunghwa-media-tools/',
  plugins: [react()],
  build: {
    outDir: 'dist-pages',
  },
});
