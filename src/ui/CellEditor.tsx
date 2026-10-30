import { useEffect, useRef, useState } from "react";
import type { KeyId } from "../core/model";

export interface CellEditorProps {
  id: KeyId;
  locale: string;
  initial: string;
  /** Raw JSON editor for complex (Paraglide variant) values: only commits valid JSON arrays. */
  complex?: boolean;
  /** Commit the text. May throw (e.g. read-only file); the error is shown inline and the editor stays open. */
  onCommit: (text: string) => void;
  onCancel: () => void;
  onNextMissing: () => void;
  onMarkReviewed?: () => void;
  /** Called after a successful Enter/Esc/Tab-without-next close, so the host can return focus to the cell. */
  onRefocus?: () => void;
}

export function CellEditor({ id, locale, initial, complex, onCommit, onCancel, onNextMissing, onMarkReviewed, onRefocus }: CellEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string | null>(null);
  const draft = useRef(initial);
  const done = useRef(false); // committed or cancelled: nothing left to flush
  const composing = useRef(false);
  const latest = useRef({ onCommit, complex, initial });
  latest.current = { onCommit, complex, initial };

  // Flush unsaved text if the editor disappears (cell switch, virtualizer unmount, filter change).
  useEffect(
    () => () => {
      const l = latest.current;
      if (done.current || draft.current === l.initial) return;
      if (l.complex) {
        try {
          if (!Array.isArray(JSON.parse(draft.current))) return;
        } catch {
          return;
        }
      }
      try {
        l.onCommit(draft.current);
      } catch {
        /* editor is gone; nowhere to show the error */
      }
    },
    [],
  );

  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    grow();
  }, []);

  /** Returns true when the commit succeeded. */
  const tryCommit = (): boolean => {
    const text = ref.current?.value ?? draft.current;
    if (complex) {
      let ok = false;
      try {
        ok = Array.isArray(JSON.parse(text));
      } catch {
        ok = false;
      }
      if (!ok) {
        setError("Must be valid JSON array");
        return false;
      }
    }
    try {
      onCommit(text);
      done.current = true;
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  return (
    <div className="w-full">
      <textarea
        ref={ref}
        rows={1}
        defaultValue={initial}
        aria-label={`Edit ${locale} translation for ${id}`}
        aria-invalid={error ? true : undefined}
        spellCheck={false}
        className={`block w-full resize-none rounded border border-indigo-400 bg-white px-1.5 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-300 ${complex ? "font-mono text-xs" : ""}`}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onBlur={() => {
          if (!done.current) tryCommit();
        }}
        onInput={(e) => {
          draft.current = e.currentTarget.value;
          grow();
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
          if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "r") {
            e.preventDefault();
            if (tryCommit()) {
              try {
                onMarkReviewed?.();
              } catch (err) {
                /* editor stays closed; review is best-effort */
                void err;
              }
            }
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (tryCommit()) onRefocus?.();
          } else if (e.key === "Escape") {
            e.preventDefault();
            done.current = true;
            onRefocus?.();
            onCancel();
          } else if (e.key === "Tab") {
            e.preventDefault();
            if (tryCommit()) {
              if (e.shiftKey) {
                onRefocus?.();
                onCancel();
              } else onNextMissing();
            }
          }
        }}
      />
      {error && (
        <div role="alert" className="mt-0.5 text-xs text-red-600">
          {error}
        </div>
      )}
    </div>
  );
}
