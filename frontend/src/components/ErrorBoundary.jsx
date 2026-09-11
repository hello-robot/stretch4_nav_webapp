import { Component } from 'react';

export default class ErrorBoundary extends Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('[stretch4-nav-webapp] UI error contained by ErrorBoundary:', error, info?.componentStack);
    this.props.onError?.(
      `Something went wrong rendering this view (${error?.message || 'unknown error'}). ` +
        'Check the browser console for details.'
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="error-boundary-fallback">
            <p>This view hit an unexpected error and stopped updating.</p>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              Reload page
            </button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
