import { useState } from "react";

export function RowMenu({ name, onRename, onDelete }: { name: string; onRename: () => void; onDelete: () => void }) {
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
        <div role="menu" className="absolute left-0 z-30 mt-1 w-28 rounded-md border border-gray-200 bg-white py-1 shadow-lg">
          <button role="menuitem" className={item} onClick={() => { setOpen(false); onRename(); }}>Rename</button>
          <button role="menuitem" className={`${item} text-red-600`} onClick={() => { setOpen(false); onDelete(); }}>Delete</button>
        </div>
      )}
    </span>
  );
}
