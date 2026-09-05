import type { BrowserAgentApi } from '../../shared/types'

declare global {
  interface Window {
    browserAgent: BrowserAgentApi
  }
}

export {}
