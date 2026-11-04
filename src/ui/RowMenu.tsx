import { useState } from "react";

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
  const [open, setOpen] = useState(false);
  const item = "block w-full px-3 py-1 text-left text-sm hover:bg-gray-100";
  return (
    <span className="relative inline-block">
      <button
        aria-label={`Actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded px-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
        onClick={() => setOpen((o) => !o)}
        onBlur={(e) => {
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) setOpen(false);
        }}
      >
        ⋯
      </button>
      {open && (
        <div role="menu" className="absolute left-0 z-30 mt-1 w-max min-w-28 rounded-md border border-gray-200 bg-white py-1 shadow-lg">
          <button role="menuitem" className={item} onClick={() => { setOpen(false); onRename(); }}>Rename</button>
          {onCodeKey && <button role="menuitem" className={item} onClick={() => { setOpen(false); onCodeKey(); }}>Set code key…</button>}
          {onLink && <button role="menuitem" className={item} onClick={() => { setOpen(false); onLink(); }}>Link to code key…</button>}
          {onKeep && <button role="menuitem" className={item} onClick={() => { setOpen(false); onKeep(); }}>Keep (will be written back to your code)</button>}
          <button role="menuitem" className={`${item} text-red-600`} onClick={() => { setOpen(false); onDelete(); }}>
            {onKeep ? "Delete key" : "Delete"}
          </button>
        </div>
      )}
    </span>
  );
}
