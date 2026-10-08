import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

const api = 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react(), tailwind()],
  server: { proxy: { '/api': api, '/.well-known': api } },
})
