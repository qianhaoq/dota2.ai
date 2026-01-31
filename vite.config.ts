import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  // Simple polyfill to allow process.env.API_KEY to work in the browser build
  // Note: For production security, consider fetching the key from a backend endpoint instead.
  define: {
    'process.env': process.env
  }
});