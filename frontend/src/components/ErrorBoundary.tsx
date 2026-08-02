import type { ReactNode } from 'react'
import { Component } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-screen bg-[var(--color-surface-secondary)]">
          <div className="text-center p-8">
            <h2 className="text-lg font-semibold text-[var(--color-text-primary)] mb-2">Something went wrong</h2>
            <p className="text-sm text-[var(--color-text-tertiary)] mb-4">{this.state.error?.message}</p>
            <button
              onClick={() => window.location.reload()}
              className="btn btn-primary"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
