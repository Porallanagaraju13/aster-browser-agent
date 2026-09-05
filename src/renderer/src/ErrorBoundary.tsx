import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  failed: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Aster renderer failed', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <main className="fatal-screen" role="alert">
        <img src="./app-icon.png" alt="" />
        <h1>Aster needs to restart</h1>
        <p>The interface encountered an unexpected error. Your browser profile and run artifacts remain on disk.</p>
        <button type="button" onClick={() => window.location.reload()}>Reload application</button>
      </main>
    )
  }
}
