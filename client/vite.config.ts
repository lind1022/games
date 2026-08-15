import { defineConfig } from 'vite';

const SERVER_PORT = process.env.SERVER_PORT ? Number(process.env.SERVER_PORT) : 8787;

export default defineConfig({
  server: {
    proxy: {
      '/ws': {
        target: `ws://localhost:${SERVER_PORT}`,
        ws: true,
      },
    },
  },
});
