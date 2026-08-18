import { defineConfig } from 'vite';

const SERVER_PORT = process.env.SERVER_PORT ? Number(process.env.SERVER_PORT) : 8787;

export default defineConfig({
  // es2022 for top-level await (main.ts awaits the block texture array
  // before first render) — fine for this project's target hardware (modern
  // evergreen browsers on school Chromebooks), not legacy-browser support.
  build: {
    target: 'es2022',
  },
  server: {
    proxy: {
      '/ws': {
        target: `ws://localhost:${SERVER_PORT}`,
        ws: true,
      },
    },
  },
});
