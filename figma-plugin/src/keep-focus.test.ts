import { describe, expect, it } from "vitest";
import { renderKeepingNote, typedNotes } from "./keep-focus";

const rowHtml = (key: string, note: string) =>
  `<div data-key="${key}"><input type="text" data-note value="${note}" aria-label="Note for ${key}"></div>`;

describe("renderKeepingNote", () => {
  it("keeps what the designer is typing, and the caret, across a redraw", () => {
    const root = document.createElement("div");
    document.body.append(root);
    root.innerHTML = rowHtml("a", "") + rowHtml("b", "");
    const input = root.querySelector<HTMLInputElement>('[data-key="b"] [data-note]')!;
    input.focus();
    input.value = "wraps to 2 li";
    input.setSelectionRange(5, 5);

    renderKeepingNote(root, rowHtml("a", "") + rowHtml("b", ""));

    const again = root.querySelector<HTMLInputElement>('[data-key="b"] [data-note]')!;
    expect(again).not.toBe(input);
    expect(again.value).toBe("wraps to 2 li");
    expect(document.activeElement).toBe(again);
    expect(again.selectionStart).toBe(5);
    root.remove();
  });
  it("keeps focus on a Fits / Too long button and on an id'd control across a redraw", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const html = (pressed: string) =>
      `<select id="locale"><option>th</option></select>` +
      `<div data-key="a"><button data-verdict="fits" aria-pressed="${pressed === "fits"}">Fits</button>` +
      `<button data-verdict="too-long" aria-pressed="${pressed === "too-long"}">Too long</button></div>`;
    root.innerHTML = html("");
    root.querySelector<HTMLButtonElement>('[data-verdict="too-long"]')!.focus();
    renderKeepingNote(root, html("too-long"));
    expect(document.activeElement).toBe(root.querySelector('[data-key="a"] [data-verdict="too-long"]'));
    expect(document.activeElement).toHaveAttribute("aria-pressed", "true");
    root.querySelector<HTMLSelectElement>("#locale")!.focus();
    renderKeepingNote(root, html("too-long"));
    expect(document.activeElement).toBe(root.querySelector("#locale"));
    root.remove();
  });

  it("reads the notes as typed", () => {
    const root = document.createElement("div");
    root.innerHTML = rowHtml("a", "") + rowHtml("b", "");
    root.querySelector<HTMLInputElement>('[data-key="b"] [data-note]')!.value = "wraps";
    expect(typedNotes(root)).toEqual(new Map([["a", ""], ["b", "wraps"]]));
  });

  it("just redraws when no note has focus", () => {
    const root = document.createElement("div");
    root.innerHTML = rowHtml("a", "");
    renderKeepingNote(root, rowHtml("a", "saved"));
    expect(root.querySelector<HTMLInputElement>("[data-note]")!.value).toBe("saved");
  });
});
