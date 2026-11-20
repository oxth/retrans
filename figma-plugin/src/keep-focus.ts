/**
 * Redraws the plugin window without losing a note the designer is typing: the window is rebuilt
 * from HTML on every state message, which would otherwise drop the text and the caret.
 */
export function renderKeepingNote(root: HTMLElement, html: string): void {
  const active = root.ownerDocument.activeElement;
  const typing = active instanceof HTMLInputElement && active.hasAttribute("data-note") && root.contains(active) ? active : null;
  const key = typing?.closest<HTMLElement>("[data-key]")?.dataset.key;
  const kept = typing && key !== undefined ? { key, value: typing.value, start: typing.selectionStart, end: typing.selectionEnd } : null;
  root.innerHTML = html;
  if (!kept) return;
  const input = [...root.querySelectorAll<HTMLElement>("[data-key]")]
    .find((el) => el.dataset.key === kept.key)
    ?.querySelector<HTMLInputElement>("[data-note]");
  if (!input) return;
  input.value = kept.value;
  input.focus();
  if (kept.start !== null && kept.end !== null) input.setSelectionRange(kept.start, kept.end);
}
