import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: 'src/main/index.js',
        external: ['ssh2', 'cpu-features', 'bcrypt-pbkdf', 'mysql2', 'pg', 'redis']
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: 'src/preload/index.js'
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()]
  }
})
