import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'

export default defineConfig({
  plugins: [react(), {
    name: 'bundled-dependency-notices',
    async generateBundle() {
      const lock = JSON.parse(await readFile(resolve(__dirname, 'package-lock.json'), 'utf8'))
      const notices = ['Aster Chrome Extension — bundled dependency notices\n\nThe following notices cover production dependencies, including dependencies that may be tree-shaken out of the final bundle. Test/build tools are not shipped.\n']
      for (const [path, metadata] of Object.entries(lock.packages) as [string, { dev?: boolean }][]) {
        if (!path.startsWith('node_modules/') || metadata.dev) continue
        const directory = resolve(__dirname, path)
        const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
        notices.push(`\n============================================================\n${pkg.name} ${pkg.version}\nLicense: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license || pkg.licenses || 'See source distribution')}\n`)
        const files = (await readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(name))
        for (const file of files) {
          try { notices.push(`\n${file}\n${await readFile(resolve(directory, file), 'utf8')}\n`) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EISDIR') throw error }
        }
        if (!files.length) notices.push(`Source: https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}\n`)
      }
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source: notices.join('') })
    }
  }],
  base: './',
  build: {
    target: 'chrome120',
    sourcemap: false,
    rollupOptions: {
      input: { panel: resolve(__dirname, 'panel.html'), background: resolve(__dirname, 'src/background.ts') },
      output: { entryFileNames: '[name].js', chunkFileNames: 'assets/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' }
    }
  }
})
