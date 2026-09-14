// Loaded before Aster's main module. Test harnesses later install narrow loopback mocks.
// Never fall back to a real provider, even if startup unexpectedly attempts inference.
globalThis.__asterTestNativeFetch = globalThis.fetch.bind(globalThis)
globalThis.__asterStartupBlockedNetwork = 0
globalThis.fetch = async () => {
  globalThis.__asterStartupBlockedNetwork++
  throw new Error('Desktop test blocked network before its local provider stub was installed')
}
