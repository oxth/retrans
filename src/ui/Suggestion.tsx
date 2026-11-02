import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { isTranslated, type KeyId } from "../core/model";
import type { ProjectSession } from "../core/session";
import { sourceText } from "../mt/source";
import { nextReqId, translateText } from "../mt/translate";
import { activeModel, useMt } from "./mt-store";

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
  const model = useMt(useShallow((s) => activeModel(s)));
  const engine = useMt((s) => s.engine);
  const [result, setResult] = useState<{ key: string; state: SuggestionState } | null>(null);

  const eligible = active && locale !== session.data.baseLocale && !isTranslated(session.value(id, locale));
  const source = eligible && model ? sourceText(session, id) : null;
  const key = model && source !== null ? `${model.path}|${locale}|${id}|${source}` : null;
  const cached = key ? cache.get(key) : undefined;
  const path = model?.path;
  const template = model?.template;
  const format = session.data.format;
  const base = session.data.baseLocale;

  useEffect(() => {
    if (!key || source === null || !path || !template || cache.has(key)) return;
    const reqId = nextReqId();
    let stale = false;
    translateText(engine, { path, template }, format, base, locale, source, reqId).then((r) => {
      if (stale || r.ok === false && r.reason === "cancelled") return;
      if (r.ok) {
        remember(key, r.text);
        setResult({ key, state: { status: "ready", text: r.text } });
      } else if (r.reason === "unsafe") setResult({ key, state: { status: "unsafe" } });
      else setResult({ key, state: { status: "error", message: r.message } });
    });
    return () => {
      stale = true;
      void engine.cancel(reqId)?.catch?.(() => {});
    };
  }, [key, source, path, template, engine, format, base, locale]);

  if (!key) return null;
  if (cached !== undefined) return { status: "ready", text: cached };
  return result && result.key === key ? result.state : { status: "loading" };
}

export function SuggestionBox({ state, onAccept }: { state: SuggestionState; onAccept: () => void }) {
  return (
    <div data-testid="suggestion" className="mt-1 flex items-center gap-2 text-xs text-gray-600">
      {state.status === "loading" && <span>Translating…</span>}
      {state.status === "ready" && (
        <>
          <span className="min-w-0 whitespace-pre-wrap break-words">Suggestion: {state.text}</span>
          <button
            type="button"
            className="shrink-0 rounded border border-indigo-300 px-1.5 py-0.5 text-indigo-700 hover:bg-indigo-50"
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
          <span className="shrink-0 text-gray-400">⌘/Ctrl+Enter</span>
        </>
      )}
      {state.status === "unsafe" && <span>Couldn't translate safely</span>}
      {state.status === "error" && <span className="text-red-600">{state.message}</span>}
    </div>
  );
}
