import { useApp } from "./store";

/** A focused text field keeps its own undo history: app undo never reaches into it. */
export function isTextField(el: Element | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);
}

/** Undo for the menu (whose shortcut the webview never sees): the field's own undo, else the app's. */
export function runUndo(): void {
  if (isTextField(document.activeElement)) document.execCommand("undo");
  else useApp.getState().undo();
}

export function runRedo(): void {
  if (isTextField(document.activeElement)) document.execCommand("redo");
  else useApp.getState().redo();
}

/** Find: focuses the Search box of the open project. */
export function runFind(): void {
  const box = document.querySelector<HTMLInputElement>('input[type="search"][aria-label="Search"]');
  box?.focus();
  box?.select();
}
