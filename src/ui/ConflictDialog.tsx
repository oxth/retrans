import type { MessageValue } from "../core/model";
import { parseKeyId } from "../core/model";
import { btnGhost, btnPrimary, Dialog } from "./Dialog";
import { useApp } from "./store";

function show(v: MessageValue | undefined): string {
  if (!v) return "(empty)";
  return v.kind === "text" ? v.text : JSON.stringify(v.raw);
}

/** Lists every unresolved conflict; open whenever the store has any. */
export function ConflictDialog() {
  const conflicts = useApp((s) => s.conflicts);
  const resolve = useApp((s) => s.resolveConflict);
  const resolveAll = useApp((s) => s.resolveAllConflicts);
  if (!conflicts.length) return null;
  return (
    <Dialog title="Resolve conflicts" wide>
      <p className="mb-3 text-sm text-gray-600">
        These values were changed both here and on disk. Choose which to keep, then save again.
      </p>
      <ul className="space-y-3">
        {conflicts.map((c) => {
          const { ns, key } = parseKeyId(c.id);
          return (
            <li key={`${c.id}\0${c.locale}`} className="rounded-md border border-gray-200 p-3 text-sm">
              <div className="mb-2 font-mono text-xs text-gray-500">
                {ns ? `${ns} · ` : ""}{key} · {c.locale}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs font-semibold text-gray-500">Yours</div>
                  <div className="whitespace-pre-wrap break-words">{show(c.mine)}</div>
                  <button className={`${btnGhost} mt-1 border border-gray-300`} onClick={() => resolve(c, "mine")}>Mine</button>
                </div>
                <div>
                  <div className="text-xs font-semibold text-gray-500">On disk</div>
                  <div className="whitespace-pre-wrap break-words">{show(c.theirs)}</div>
                  <button className={`${btnGhost} mt-1 border border-gray-300`} onClick={() => resolve(c, "theirs")}>Theirs</button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mt-5 flex justify-end gap-2">
        <button className={btnGhost} onClick={() => resolveAll("theirs")}>Take all theirs</button>
        <button className={btnPrimary} onClick={() => resolveAll("mine")}>Keep all mine</button>
      </div>
    </Dialog>
  );
}
