import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  // REMOVED: define: { 'process.env': process.env } 
  // SECURITY: Do not inject process.env into client code to protect API_KEY
});