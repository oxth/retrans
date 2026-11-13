import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

/**
 * Per-row actions. `onKeep` is set for a workspace key removed in source: Delete is then
 * labelled "Delete key" and Keep clears the mark (so write-back writes the key again).
 */
export function RowMenu({ name, onRename, onDelete, onKeep, onCodeKey, onLink }: {
  name: string; onRename: () => void; onDelete: () => void; onKeep?: () => void;
  /** Set for a Figma string with no code key yet. */
  onCodeKey?: () => void;
  onLink?: () => void;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = pos !== null;
  const close = () => setPos(null);
  const item = "block w-full rounded px-2.5 py-1.5 text-left text-sm hover:bg-hover";

  // Close on a press anywhere else, Escape, scroll or resize. (Focus can't be relied on: in the
  // macOS webview clicking a button doesn't focus it, so blur never fires.)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const toggle = () => {
    if (open) return close();
    const r = button.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left });
  };
  // Opens below the button; flips above it (and shifts left) when it would run off the window.
  useLayoutEffect(() => {
    if (!pos || !menu.current || !button.current) return;
    const m = menu.current.getBoundingClientRect();
    const b = button.current.getBoundingClientRect();
    let { top, left } = pos;
    if (m.bottom > window.innerHeight - 4 && b.top - 4 - m.height >= 4) top = b.top - 4 - m.height;
    if (m.right > window.innerWidth - 4) left = Math.max(4, window.innerWidth - 4 - m.width);
    if (top !== pos.top || left !== pos.left) setPos({ top, left });
  }, [pos]);
  const run = (action: () => void) => () => {
    close();
    action();
  };

  return (
    <span className="relative inline-block">
      <button
        ref={button}
        aria-label={`Actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`rounded p-0.5 text-muted hover:bg-sunken hover:text-fg ${open ? "bg-sunken text-fg" : ""}`}
        onClick={toggle}
      >
        <Icon name="more" size={16} />
      </button>
      {/* In <body>, not in the row: each virtual row is transformed, which puts the next row on top of anything inside this one. */}
      {pos &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            className="z-50 w-max min-w-36 rounded-lg border border-line bg-surface p-1 text-fg shadow-pop"
            style={{ position: "fixed", top: pos.top, left: pos.left }}
          >
            <button role="menuitem" className={item} onClick={run(onRename)}>Rename</button>
            {onCodeKey && <button role="menuitem" className={item} onClick={run(onCodeKey)}>Set code key…</button>}
            {onLink && <button role="menuitem" className={item} onClick={run(onLink)}>Link to code key…</button>}
            {onKeep && <button role="menuitem" className={item} onClick={run(onKeep)}>Keep (will be written back to your code)</button>}
            <button role="menuitem" className={`${item} text-danger hover:bg-danger-soft`} onClick={run(onDelete)}>
              {onKeep ? "Delete key" : "Delete"}
            </button>
          </div>,
          document.body,
        )}
    </span>
  );
}
