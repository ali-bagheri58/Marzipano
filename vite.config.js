import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html')
      }
    }
  },
  server: {
    host: '0.0.0.0',
    watch: {
      ignored: ['**/pic/**']
    }
  },
  preview: {
    host: '0.0.0.0'
  }
});
