import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
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
