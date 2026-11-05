import { useEffect, useRef, type ReactNode } from "react";

/**
 * Modal: backdrop + labelled dialog. Escape closes via onClose. On open it takes focus (unless a
 * field inside already did, e.g. autoFocus) so Escape works straight away; on close focus goes
 * back to where it was.
 */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose?: () => void; children: ReactNode; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    if (panel.current && !panel.current.contains(document.activeElement)) panel.current.focus();
    return () => {
      if (before?.isConnected && !document.querySelector('[role="dialog"]')) before.focus();
    };
  }, []);
  return (
    <div
      role="dialog"
      aria-label={title}
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-center justify-center bg-scrim p-4"
      onKeyDown={(e) => {
        if (e.key === "Escape" && onClose) onClose();
      }}
    >
      <div
        ref={panel}
        tabIndex={-1}
        className={`max-h-[90vh] w-full overflow-auto rounded-xl border border-line bg-surface p-6 text-fg shadow-pop outline-none ${wide ? "max-w-[40rem]" : "max-w-md"}`}
      >
        <h2 className="mb-4 text-base font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

const btn = "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50";
/** The one main action of a dialog or page. */
export const btnPrimary = `${btn} bg-brand text-on-brand hover:bg-brand-hover`;
/** A visible, bordered action that isn't the main one. */
export const btnSecondary = `${btn} border border-line-strong bg-surface text-fg hover:bg-hover`;
/** Low-emphasis actions: Cancel, Close, Later. */
export const btnGhost = `${btn} text-fg-2 hover:bg-hover`;
/** Confirms something that deletes. */
export const btnDanger = `${btn} bg-danger-solid text-white hover:opacity-90`;
export const inputCls =
  "w-full rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg hover:border-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-line";
/** Small uppercase label above a group of controls. */
export const sectionLabel = "text-xs font-semibold uppercase tracking-wide text-muted";
