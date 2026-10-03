import { Component } from "react";
import type { ReactNode } from "react";

/** Rendering failures stay local; retry remounts only the failed subtree. */
export default class RenderBoundary extends Component<{ children: ReactNode; label?: string; resetKey?: unknown; tile?: boolean }, { failed: boolean; retry: number }> {
  state = { failed: false, retry: 0 };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() {
    // Do not leak authored data, credentials or stack traces into operator UI.
    console.error("SparkStudio rendering failed. Retry this view or reload the application.");
  }
  componentDidUpdate(previous: Readonly<{ resetKey?: unknown }>) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }
  render() {
    if (this.state.failed) return <section className={`render-recovery${this.props.tile ? " render-recovery-tile" : ""}`} role="alert">
      <strong>{this.props.label ?? "Application"} unavailable</strong>
      <p>This view could not be displayed. Other controls can continue to operate.</p>
      <button type="button" onClick={() => this.setState(state => ({ failed: false, retry: state.retry + 1 }))}>Retry view</button>
      {!this.props.tile && <button type="button" onClick={() => window.location.reload()}>Reload application</button>}
    </section>;
    return <div key={this.state.retry} className="render-boundary-contents">{this.props.children}</div>;
  }
}
