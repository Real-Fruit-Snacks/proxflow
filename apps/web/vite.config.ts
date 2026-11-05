import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // A fixed port of its own: 5173 is Vite's default and often taken by other projects. strictPort makes a
    // clash fail loudly instead of silently moving ProxFlow to another URL.
    port: Number(process.env.WEB_PORT ?? 5180),
    strictPort: true,
    proxy: {
      '/api': { target: `http://localhost:${process.env.PORT ?? 3001}`, changeOrigin: true },
    },
  },
});
