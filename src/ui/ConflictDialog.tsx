import type { MessageValue } from "../core/model";
import { parseKeyId } from "../core/model";
import { useState } from "react";
import { btnGhost, btnPrimary, Dialog, inputCls, btnSecondary } from "./Dialog";
import { type UiConflict, useApp } from "./store";
import { languageWithCode } from "./locales";

function show(v: MessageValue | undefined): string {
  if (!v) return "(empty)";
  return v.kind === "text" ? v.text : JSON.stringify(v.raw);
}

const LABELS: Record<string, { mine: string; theirs: string }> = {
  figma: { mine: "Version from code", theirs: "Version from Figma" },
  source: { mine: "Your version", theirs: "Version in the source files" },
  disk: { mine: "Your version", theirs: "Version on disk" },
};

/** "Version from Figma" -> "version from Figma": only the first letter, so names keep their capitals. */
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Lists every unresolved conflict; open whenever the store has any. */
export function ConflictDialog() {
  const conflicts = useApp((s) => s.conflicts);
  const resolve = useApp((s) => s.resolveConflict);
  const resolveWith = useApp((s) => s.resolveConflictWith);
  const resolveAll = useApp((s) => s.resolveAllConflicts);
  if (!conflicts.length) return null;
  return (
    <Dialog title="Resolve conflicts" wide>
      <p className="mb-3 text-sm text-muted">
        These values were changed in two places. Choose which to keep, or edit a final version.
      </p>
      <ul className="space-y-3">
        {conflicts.map((c) => (
          <ConflictItem key={`${c.origin ?? "disk"}\0${c.id}\0${c.locale}`} c={c} resolve={resolve} resolveWith={resolveWith} />
        ))}
      </ul>
      <div className="mt-5 flex justify-end gap-2">
        <button className={btnGhost} onClick={() => resolveAll("theirs")}>Keep every right-hand version</button>
        <button className={btnPrimary} onClick={() => resolveAll("mine")}>Keep every left-hand version</button>
      </div>
    </Dialog>
  );
}

function ConflictItem({ c, resolve, resolveWith }: {
  c: UiConflict;
  resolve: (c: UiConflict, pick: "mine" | "theirs") => void;
  resolveWith: (c: UiConflict, text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const { ns, key } = parseKeyId(c.id);
  const label = LABELS[c.origin ?? "disk"];
  return (
    <li className="rounded-md border border-line p-3 text-sm">
      <div className="mb-2 font-mono text-xs text-muted">
        {ns ? `${ns} · ` : ""}{key} · {languageWithCode(c.locale)}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-xs font-semibold text-muted">{label.mine}</div>
          <div className="whitespace-pre-wrap break-words">{show(c.mine)}</div>
          <button className={`${btnSecondary} mt-1`} aria-label={`Keep ${lower(label.mine)}`} onClick={() => resolve(c, "mine")}>Keep this</button>
        </div>
        <div>
          <div className="text-xs font-semibold text-muted">{label.theirs}</div>
          <div className="whitespace-pre-wrap break-words">{show(c.theirs)}</div>
          <button className={`${btnSecondary} mt-1`} aria-label={`Keep ${lower(label.theirs)}`} onClick={() => resolve(c, "theirs")}>Keep this</button>
        </div>
      </div>
      {c.base && (
        <div className="mt-2 border-t border-line pt-2">
          <div className="text-xs font-semibold text-muted">Original</div>
          <div className="whitespace-pre-wrap break-words text-muted">{show(c.base)}</div>
        </div>
      )}
      {draft === null ? (
        <button className={`${btnGhost} mt-2`} onClick={() => setDraft(c.theirs?.kind === "text" ? c.theirs.text : c.mine?.kind === "text" ? c.mine.text : "")}>
          Edit…
        </button>
      ) : (
        <div className="mt-2 space-y-1">
          <textarea aria-label="Final version" className={inputCls} rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setDraft(null)}>Cancel</button>
            <button className={btnPrimary} onClick={() => resolveWith(c, draft)}>Use this</button>
          </div>
        </div>
      )}
    </li>
  );
}
