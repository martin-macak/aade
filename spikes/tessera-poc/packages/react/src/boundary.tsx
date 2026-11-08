import { Component, Fragment, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import { reportError } from '@tessera/base';
import type { ViewContext } from '@tessera/contracts';

export interface ErrorFallbackProps {
  readonly error: unknown;
  readonly reload: () => void;
}
export type ErrorFallback = (props: ErrorFallbackProps) => ReactNode;

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function DefaultErrorFallback({ error, reload }: ErrorFallbackProps): ReactElement {
  return (
    <div role="alert" className="tessera-error">
      <strong>This view failed to render.</strong>
      <pre>{messageOf(error)}</pre>
      <button type="button" onClick={reload}>
        Reload view
      </button>
    </div>
  );
}

interface BoundaryProps {
  readonly context: ViewContext;
  readonly fallback: ErrorFallback;
  readonly children: ReactNode;
}
interface BoundaryState {
  readonly error: { readonly value: unknown } | undefined;
  readonly attempt: number;
}

/**
 * One error boundary per placement (contracts.md 18.2 rule 3). A render error shows the fallback and is reported with
 * source 'view' and the plugin that owns the view type. The other placements keep working: the boundary is the only
 * thing that stops the error. The placement stays attached; "Reload view" renders it again.
 */
export class PlacementBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: undefined, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: { value: error } };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    this.props.context.reportError(error);
  }

  readonly reload: () => void = () => {
    this.setState((s) => ({ error: undefined, attempt: s.attempt + 1 }));
  };

  override render(): ReactNode {
    const { error, attempt } = this.state;
    if (error) return this.props.fallback({ error: error.value, reload: this.reload });
    return <div key={attempt} className="tessera-view">{this.props.children}</div>;
  }
}

interface ChromeBoundaryProps {
  /** Names the part in the report and in the fallback: 'statusBar', 'menu', 'quickInput', 'workspaceHeader'. */
  readonly name: string;
  readonly children: ReactNode;
}

/**
 * An error boundary for the window chrome (status bar, menus, quick input, workspace headers). Plugin data flows into these parts
 * (a `when` clause, a title, a text observable), so a throw in one part must not blank the window: the part shows a small notice with a
 * retry, the error is reported once, and everything else keeps rendering.
 */
export class ChromeBoundary extends Component<ChromeBoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: undefined, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: { value: error } };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    reportError(error, { source: 'view', target: `chrome:${this.props.name}` });
  }

  readonly retry: () => void = () => {
    this.setState((s) => ({ error: undefined, attempt: s.attempt + 1 }));
  };

  override render(): ReactNode {
    const { error, attempt } = this.state;
    if (error) {
      return (
        <span role="alert" className="tessera-chrome-error" data-chrome-error={this.props.name}>
          {this.props.name} unavailable{' '}
          <button type="button" onClick={this.retry}>
            Retry
          </button>
        </span>
      );
    }
    return <Fragment key={attempt}>{this.props.children}</Fragment>;
  }
}
