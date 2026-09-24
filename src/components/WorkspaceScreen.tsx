import { Component, Suspense, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { AskWorkspaceSheet } from './AskWorkspaceSheet';

function ScreenFallback({ label, children, onClose }: { label: string; children: ReactNode; onClose?: () => void }) {
  return onClose ? <AskWorkspaceSheet title={label} origin="your workspace" onClose={onClose}>{children}</AskWorkspaceSheet> : children;
}

function ScreenLoading({ label, onClose }: { label: string; onClose?: () => void }) {
  return <ScreenFallback label={`Opening ${label}`} onClose={onClose}><div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-paper p-6" role="status" aria-live="polite">
    <Loader2 size={20} className="animate-spin" aria-hidden="true" />
    <p>Opening {label}…</p>
  </div></ScreenFallback>;
}
class ScreenBoundary extends Component<{ label: string; children: ReactNode; onClose?: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <ScreenFallback label={`Could not open ${this.props.label}`} onClose={this.props.onClose}><div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-paper p-6" role="alert">
      <h1 className="text-xl font-semibold">Could not open {this.props.label}</h1>
      <p className="max-w-md text-center text-ink-secondary">Your saved records remain on this computer. Reload RealBud to try again, or choose another workspace screen.</p>
      <button className="pm-control" onClick={() => window.location.reload()}>Reload RealBud</button>
    </div></ScreenFallback>;
    return this.props.children;
  }
}
/** Keep navigation available while a screen loads or its local asset fails.
 * The containing route key resets failures when another screen is chosen. */
export function WorkspaceScreen({ label, children, onClose }: { label: string; children: ReactNode; onClose?: () => void }) {
  return <ScreenBoundary label={label} onClose={onClose}><Suspense fallback={<ScreenLoading label={label} onClose={onClose} />}>{children}</Suspense></ScreenBoundary>;
}
