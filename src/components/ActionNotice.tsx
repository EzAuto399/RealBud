import { AlertCircle, X } from "lucide-react";

/** Action failures stay visible until handled. No automatic replay of a write. */
export function ActionNotice({ message, onDismiss, onRetry }: { message: string; onDismiss?: () => void; onRetry?: () => void }) {
  return <div role="alert" className="workspace-action-notice">
    <AlertCircle size={18} aria-hidden />
    <p>{message}</p>
    {onRetry && <button type="button" className="pm-control" onClick={onRetry}>Try again</button>}
    {onDismiss && <button type="button" className="pm-control" aria-label="Dismiss message" onClick={onDismiss}><X size={18} aria-hidden /></button>}
  </div>;
}
