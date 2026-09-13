import path from 'node:path'

/** Call before importing Playwright: it caches this location during module loading. */
export function configurePackagedRuntime(
  isPackaged: boolean,
  resourcesPath: string,
  environment: NodeJS.ProcessEnv = process.env
): void {
  if (isPackaged) {
    // A portable app must never depend on the developer's or recipient's cache.
    environment.PLAYWRIGHT_BROWSERS_PATH = path.join(resourcesPath, 'playwright')
  }
}
