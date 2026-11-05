import { useEffect, useState } from "react";
import { isTranslated, type KeyId } from "../core/model";
import type { ProjectSession } from "../core/session";
import { sourceText } from "../mt/source";
import { activeModel, activeTranslator, useMt } from "./mt-store";
import { instructionsFor } from "./instructions";

export type SuggestionState =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "unsafe" }
  | { status: "error"; message: string };

const MAX_CACHE = 500;
const cache = new Map<string, string>();

function remember(key: string, text: string) {
  cache.delete(key);
  cache.set(key, text);
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
}

/** Test hook: forget every cached suggestion. */
export function clearSuggestionCache() {
  cache.clear();
}

/** Machine suggestion for an untranslated target cell, or null when none applies. */
export function useSuggestion(session: ProjectSession, id: KeyId, locale: string, active: boolean): SuggestionState | null {
  const mt = useMt();
  const override = session.state.project.mtProvider;
  const format = session.data.format;
  const translator = activeTranslator(mt, format, override);
  // What identifies the translator, so a cached suggestion is reused only for the same one.
  const model = activeModel(mt);
  const p = override ?? mt.settings.provider ?? "local";
  const who = p === "local" ? `local|${model?.path}` : p === "acp" ? `acp|${mt.settings.acp?.command} ${mt.settings.acp?.args.join(" ")}` : `${p}|${JSON.stringify(mt.settings.cloud[p as "openai"])}`;
  const [result, setResult] = useState<{ key: string; state: SuggestionState } | null>(null);

  const eligible = active && locale !== session.data.baseLocale && !isTranslated(session.value(id, locale));
  const source = eligible && translator ? sourceText(session, id) : null;
  const key = translator && source !== null ? `${who}|${locale}|${id}|${source}` : null;
  const cached = key ? cache.get(key) : undefined;

  useEffect(() => {
    if (!key || source === null || !translator || cache.has(key)) return;
    const ac = new AbortController();
    void translator
      .translate([{ id, locale, source }], { session, instructions: instructionsFor(session) }, (_job, r) => {
        if (ac.signal.aborted || (r.ok === false && r.reason === "cancelled")) return;
        if (r.ok) {
          remember(key, r.text);
          setResult({ key, state: { status: "ready", text: r.text } });
        } else if (r.reason === "unsafe") setResult({ key, state: { status: "unsafe" } });
        else setResult({ key, state: { status: "error", message: r.message } });
      }, ac.signal)
      .catch((e) => !ac.signal.aborted && setResult({ key, state: { status: "error", message: e instanceof Error ? e.message : String(e) } }));
    return () => ac.abort();
    // The translator is rebuilt every render; `key` already captures which one it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!key) return null;
  if (cached !== undefined) return { status: "ready", text: cached };
  return result && result.key === key ? result.state : { status: "loading" };
}

export function SuggestionBox({ state, onAccept }: { state: SuggestionState; onAccept: () => void }) {
  return (
    <div data-testid="suggestion" className="mt-1.5 flex items-center gap-2 rounded-md bg-brand-soft px-2 py-1 text-xs text-fg-2">
      {state.status === "loading" && (
        <span className="flex items-center gap-1.5 text-muted">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-brand-line border-t-brand" aria-hidden="true" />
          Translating…
        </span>
      )}
      {state.status === "ready" && (
        <>
          <span className="min-w-0 whitespace-pre-wrap break-words">Suggestion: {state.text}</span>
          <button
            type="button"
            className="shrink-0 rounded-md bg-brand px-2 py-0.5 font-medium text-on-brand hover:bg-brand-hover"
            onMouseDown={(e) => {
              e.preventDefault();
              onAccept();
            }}
            onClick={(e) => {
              // Keyboard activation only: a mouse click already accepted on mousedown.
              if (e.detail === 0) onAccept();
            }}
          >
            Accept
          </button>
          <kbd className="shrink-0 rounded border border-brand-line px-1 font-sans text-[11px] text-muted">⌘/Ctrl+Enter</kbd>
        </>
      )}
      {state.status === "unsafe" && <span>Couldn't translate safely</span>}
      {state.status === "error" && <span className="text-danger">{state.message}</span>}
    </div>
  );
}
