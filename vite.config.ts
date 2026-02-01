import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Esto permite que Vite cargue variables que empiezan con REACT_APP_
  // para mantener compatibilidad con tu código actual.
  envPrefix: 'REACT_APP_',
  server: {
    port: 3000,
    proxy: {
      '/api/anthropic': {
        target: 'https://api.anthropic.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/anthropic/, ''),
        secure: false
      }
    }
  }
});