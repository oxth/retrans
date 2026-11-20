import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab inside the dialog `root` (its role="dialog" element): past the last control it wraps
 * to the first, and Shift+Tab back. Only for the innermost dialog: one opened from another (a
 * prompt over Settings) keeps Tab to itself.
 */
export function trapTab(e: KeyboardEvent, root: HTMLElement): void {
  if (e.key !== "Tab" || e.defaultPrevented || (e.target as Element).closest('[role="dialog"]') !== root) return;
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.closest('[role="dialog"]') === root);
  const i = items.indexOf(document.activeElement as HTMLElement);
  // In between, the browser moves focus as usual (a radio group stays one stop).
  if (items.length && i !== -1 && (e.shiftKey ? i > 0 : i < items.length - 1)) return;
  e.preventDefault();
  items[e.shiftKey ? items.length - 1 : 0]?.focus();
}

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
        trapTab(e, e.currentTarget);
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
export const btnSecondary = `${btn} border border-field-line bg-surface text-fg hover:bg-hover`;
/** Low-emphasis actions: Cancel, Close, Later. */
export const btnGhost = `${btn} text-fg-2 hover:bg-hover`;
/** Confirms something that deletes. */
export const btnDanger = `${btn} bg-danger-solid text-white hover:opacity-90`;
export const inputCls =
  "w-full rounded-md border border-field-line bg-surface px-3 py-1.5 text-sm text-fg hover:border-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand";
/** Small uppercase label above a group of controls. */
export const sectionLabel = "text-xs font-semibold uppercase tracking-wide text-muted";
