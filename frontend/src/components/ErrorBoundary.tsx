/**
 * ErrorBoundary.tsx
 *
 * Catches render-time errors in the page tree so one broken route shows a
 * readable message with a way out instead of blanking the whole app (issue
 * #28). React only exposes this through a class component:
 * `getDerivedStateFromError` / `componentDidCatch` have no hook equivalent.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The user gets a short message; the stack goes to the console so the
    // failure is still diagnosable (and reportable to an error tracker).
    console.error("Unhandled error while rendering", error, info.componentStack);
  }

  private readonly handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="error-boundary" role="alert">
          <h1>Something went wrong</h1>
          <p>This page could not be displayed. Reloading usually clears it.</p>
          <button type="button" onClick={this.handleReload}>
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
