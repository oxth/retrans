import { useState } from "react";
import type { ProjectSession } from "../core/session";

export function LoadErrors({ session }: { session: ProjectSession }) {
  const [open, setOpen] = useState(false);
  const n = session.errors.length;
  if (!n) return null;
  return (
    <div data-testid="load-errors" className="bg-amber-50 px-4 py-2 text-sm text-amber-900">
      <div className="flex items-center justify-between gap-3">
        <span>
          {n} {n === 1 ? "file couldn't be read and is" : "files couldn't be read and are"} read-only
        </span>
        <button className="underline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide details" : "Details"}
        </button>
      </div>
      {open && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {session.errors.map((e) => (
            <li key={e.relPath}>
              <span className="font-mono">{e.relPath}</span> — {e.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
