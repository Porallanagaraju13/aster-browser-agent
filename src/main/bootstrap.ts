import { app } from 'electron'
import { configurePackagedRuntime } from './packaged-runtime'

configurePackagedRuntime(app.isPackaged, process.resourcesPath)

// Do not make this a static import. AgentRunner imports Playwright, whose registry
// must see the bundled runtime path above on its very first evaluation.
void import('./index').catch((error: unknown) => {
  console.error('Aster could not start:', error)
  app.exit(1)
})
