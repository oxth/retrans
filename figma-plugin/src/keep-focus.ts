/**
 * Redraws the plugin window without losing the designer's place: the window is rebuilt from HTML on
 * every state message, which would otherwise drop keyboard focus to the top (after Fits, Too long,
 * Show or a dropdown) and the text and caret of a note being typed.
 */
export function renderKeepingNote(root: HTMLElement, html: string): void {
  const active = root.ownerDocument.activeElement;
  const where = active instanceof HTMLElement && root.contains(active) ? locate(active) : null;
  const typing = active instanceof HTMLInputElement && active.hasAttribute("data-note") ? active : null;
  const caret = typing ? { value: typing.value, start: typing.selectionStart, end: typing.selectionEnd } : null;
  root.innerHTML = html;
  const again = where && find(root, where);
  if (!again) return;
  again.focus();
  if (caret && again instanceof HTMLInputElement) {
    again.value = caret.value;
    if (caret.start !== null && caret.end !== null) again.setSelectionRange(caret.start, caret.end);
  }
}

/** A focused control, as something that survives a redraw: its id, or its row's key and which control it is. */
type Place = { id: string } | { key: string; control: string };

function locate(el: HTMLElement): Place | null {
  if (el.id) return { id: el.id };
  const key = el.closest<HTMLElement>("[data-key]")?.dataset.key;
  if (key === undefined) return null;
  if (el.dataset.verdict) return { key, control: `[data-verdict="${el.dataset.verdict}"]` };
  if (el.hasAttribute("data-focus")) return { key, control: "[data-focus]" };
  if (el.hasAttribute("data-note")) return { key, control: "[data-note]" };
  return null;
}

function find(root: HTMLElement, p: Place): HTMLElement | null {
  if ("id" in p) return root.ownerDocument.getElementById(p.id);
  const row = [...root.querySelectorAll<HTMLElement>("[data-key]")].find((el) => el.dataset.key === p.key);
  return row?.querySelector<HTMLElement>(p.control) ?? null;
}

/** The notes as typed in the window right now, by row key (a note is committed on change, a round trip later). */
export function typedNotes(root: HTMLElement): Map<string, string> {
  const notes = new Map<string, string>();
  for (const input of root.querySelectorAll<HTMLInputElement>("[data-key] [data-note]")) {
    const key = input.closest<HTMLElement>("[data-key]")!.dataset.key!;
    notes.set(key, input.value);
  }
  return notes;
}
