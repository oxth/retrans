import { useEffect, useRef, useState } from "react";
import type { KeyId } from "../core/model";
import { SuggestionBox, type SuggestionState } from "./Suggestion";

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
  /** An unmount-time flush failed (e.g. read-only file): the editor is gone, so the host must show the message. */
  onFlushError?: (message: string) => void;
  suggestion?: SuggestionState | null;
  /** Writes the machine suggestion; may throw like onCommit. */
  onAcceptSuggestion?: (text: string) => void;
}

export function CellEditor({ id, locale, initial, complex, onCommit, onCancel, onNextMissing, onMarkReviewed, onRefocus, onFlushError, suggestion, onAcceptSuggestion }: CellEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string | null>(null);
  const draft = useRef(initial);
  // Once the user has typed, their text wins: the suggestion is hidden and can't be accepted.
  const [edited, setEdited] = useState(false);
  const done = useRef(false); // committed or cancelled: nothing left to flush
  const composing = useRef(false);
  const latest = useRef({ onCommit, complex, initial, onFlushError });
  latest.current = { onCommit, complex, initial, onFlushError };

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
      } catch (e) {
        l.onFlushError?.(e instanceof Error ? e.message : String(e));
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

  const canAccept = () =>
    !done.current && suggestion?.status === "ready" && !!onAcceptSuggestion && (ref.current?.value ?? draft.current) === initial;

  const accept = () => {
    if (!canAccept() || suggestion?.status !== "ready" || !onAcceptSuggestion) return;
    try {
      onAcceptSuggestion(suggestion.text);
      done.current = true;
      onRefocus?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
        className={`block w-full resize-none rounded-md border border-brand bg-surface px-1.5 py-1 text-sm text-fg outline-none ring-2 ring-brand-line focus-visible:outline-none ${complex ? "font-mono text-xs" : ""}`}
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
          setEdited(draft.current !== initial);
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
            // Cmd/Ctrl+Enter accepts a ready suggestion over untouched text; otherwise it's Enter.
            if ((e.metaKey || e.ctrlKey) && canAccept()) accept();
            else if (tryCommit()) onRefocus?.();
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
      {suggestion && !edited && <SuggestionBox state={suggestion} onAccept={accept} />}
      {error && (
        <div role="alert" className="mt-0.5 text-xs text-danger">
          {error}
        </div>
      )}
      <div data-testid="editor-keys" className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
        <span><Kbd>Enter</Kbd> Save</span>
        {onMarkReviewed && <span><Kbd>⌘⇧R</Kbd> Save & mark reviewed</span>}
        <span><Kbd>Tab</Kbd> Next missing</span>
        <span><Kbd>Esc</Kbd> Cancel</span>
      </div>
    </div>
  );
}

const Kbd = ({ children }: { children: string }) => (
  <kbd className="rounded border border-line-strong bg-panel px-1 font-sans text-[10px] text-fg-2">{children}</kbd>
);
