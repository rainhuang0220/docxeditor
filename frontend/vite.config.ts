import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
    },
    headers: {
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "style-src-attr 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self' ipc: http://ipc.localhost http://localhost:5173 http://127.0.0.1:5173 ws://localhost:5173 ws://127.0.0.1:5173",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-src 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor-tiptap', test: /node_modules\/@tiptap|prosemirror/ },
            { name: 'vendor-react', test: /node_modules\/(react|react-dom|scheduler)/ },
          ],
        },
      },
    },
  },
})
