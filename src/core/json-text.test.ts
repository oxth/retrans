import { describe, expect, it } from "vitest";
import {
  DEFAULT_STYLE,
  detectStyle,
  emptyDocument,
  parseJson,
  removeAt,
  setAt,
} from "./json-text";

describe("json-text", () => {
  it("detects tab indent, CRLF, no final newline", () => {
    const s = detectStyle('{\r\n\t"a": "1"\r\n}');
    expect(s).toEqual({ indent: "\t", eol: "\r\n", finalNewline: false });
    expect(detectStyle('{\n    "a": 1\n}\n')).toEqual({ indent: "    ", eol: "\n", finalNewline: true });
    expect(detectStyle("{}")).toEqual({ indent: DEFAULT_STYLE.indent, eol: "\n", finalNewline: false });
  });

  it("setAt on existing key changes only that line", () => {
    const text = '{\n  "a": "1",\n  "b": "2",\n  "c": "3",\n  "d": "4",\n  "e": "5"\n}\n';
    const out = setAt(text, ["c"], "changed", detectStyle(text));
    const a = text.split("\n");
    const b = out.split("\n");
    expect(b.length).toBe(a.length);
    const diff = a.filter((l, i) => l !== b[i]);
    expect(diff).toEqual(['  "c": "3",']);
    expect(b[3]).toBe('  "c": "changed",');
  });

  it("setAt appends new key at end of parent", () => {
    const out = setAt('{"a":{"x":"1"},"z":"9"}', ["a", "y"], "2", detectStyle('{"a":{"x":"1"},"z":"9"}'));
    expect(out).toBe('{"a":{"x":"1","y":"2"},"z":"9"}');
  });

  it("setAt creates missing parent objects", () => {
    const out = setAt('{\n  "a": "1"\n}\n', ["p", "q", "r"], "v", DEFAULT_STYLE);
    expect(JSON.parse(out)).toEqual({ a: "1", p: { q: { r: "v" } } });
    expect(out.endsWith("}\n")).toBe(true);
  });

  it("removeAt removes emptied parents", () => {
    const text = '{"a":{"b":"1"},"c":"2"}';
    const style = { indent: "  ", eol: "\n", finalNewline: false } as const;
    expect(removeAt(text, ["a", "b"], style)).toBe('{"c":"2"}');
    expect(JSON.parse(removeAt('{"a":{"b":{"c":"1"}}}', ["a", "b", "c"], style))).toEqual({});
    expect(removeAt(text, ["nope", "x"], style)).toBe(text);
  });

  it("writes Thai and escapes quotes", () => {
    const value = 'ยินดี "x" \\ \n🙂';
    const out = setAt("{}\n", ["k"], value, DEFAULT_STYLE);
    expect(out).toContain("ยินดี");
    expect(out).toContain("🙂");
    expect(out).toContain('\\"x\\"');
    expect(out).toContain("\\\\");
    expect(out).toContain("\\n");
    expect(out).not.toContain("\\u0e");
    expect(JSON.parse(out).k).toBe(value);
  });

  it("preserves CRLF and tab indent on insert", () => {
    const text = '{\r\n\t"a": "1"\r\n}\r\n';
    const out = setAt(text, ["b"], "2", detectStyle(text));
    expect(out).toBe('{\r\n\t"a": "1",\r\n\t"b": "2"\r\n}\r\n');
  });

  it("round-trip with no edits returns identical text", () => {
    const text = '{\n  "a": "1",\n  "b": { "c": "2" }\n}';
    expect(setAt(text, ["a"], "1", detectStyle(text))).toBe(text);
  });

  it("supports array/object values", () => {
    const out = setAt("{}\n", ["m"], ["a", { b: 1 }], DEFAULT_STYLE);
    expect(JSON.parse(out)).toEqual({ m: ["a", { b: 1 }] });
  });

  it("parseJson is strict; emptyDocument", () => {
    expect(parseJson('{"a":1}').value).toEqual({ a: 1 });
    expect(parseJson('{"a":1,}').error).toBeTruthy();
    expect(parseJson('{/*c*/"a":1}').error).toBeTruthy();
    expect(parseJson("").error).toBeTruthy();
    expect(emptyDocument(DEFAULT_STYLE)).toBe("{}\n");
    expect(emptyDocument({ indent: "  ", eol: "\r\n", finalNewline: false })).toBe("{}");
  });
});

describe("removeAt minimal diff", () => {
  const text = '{\n  "a": 1,\n  "b": { "x": 2 },\n  "c": 3\n}\n';
  const st = detectStyle(text);
  it("removes first, middle, last and only keys cleanly", () => {
    expect(removeAt(text, ["a"], st)).toBe('{\n  "b": { "x": 2 },\n  "c": 3\n}\n');
    expect(removeAt(text, ["b"], st)).toBe('{\n  "a": 1,\n  "c": 3\n}\n');
    expect(removeAt(text, ["c"], st)).toBe('{\n  "a": 1,\n  "b": { "x": 2 }\n}\n');
    expect(removeAt('{\n  "a": 1\n}\n', ["a"], st)).toBe("{}\n");
  });
});

describe("compact and trailing whitespace", () => {
  const nf = { indent: "  ", eol: "\n", finalNewline: false } as const;
  it("inserts into compact files without reformatting", () => {
    expect(setAt('{"a":"1"}', ["b"], "2", nf)).toBe('{"a":"1","b":"2"}');
    expect(setAt('{"a": "1", "c": "3"}', ["b"], "2", nf)).toBe('{"a": "1", "c": "3", "b": "2"}');
    expect(setAt("{}", ["b"], "2", nf)).toBe('{"b":"2"}');
    expect(setAt('{"a":"1"}', ["p", "q"], "2", nf)).toBe('{"a":"1","p":{"q":"2"}}');
  });
  it("preserves trailing blank lines", () => {
    const text = '{\n  "a": "1"\n}\n\n';
    expect(setAt(text, ["a"], "2", detectStyle(text))).toBe('{\n  "a": "2"\n}\n\n');
    expect(removeAt('{\n  "a": 1,\n  "b": 2\n}\n\n', ["b"], DEFAULT_STYLE)).toBe('{\n  "a": 1\n}\n\n');
  });
  it("removeAt keeps absent final newline", () => {
    expect(removeAt('{\n  "a": 1,\n  "b": 2\n}', ["b"], nf)).toBe('{\n  "a": 1\n}');
  });

  it("setAt replaces a one-line array compactly, matching separators", () => {
    const st = DEFAULT_STYLE;
    expect(setAt('{"l":["en","th"],"x":1}', ["l"], ["en", "th", "de"], { ...st, finalNewline: false })).toBe('{"l":["en","th","de"],"x":1}');
    expect(setAt('{\n  "l": ["en", "th"]\n}\n', ["l"], ["en", "th", "de"], st)).toBe(
      '{\n  "l": ["en", "th", "de"]\n}\n',
    );
  });

  it("setAt replacing a string on a pretty-printed file changes exactly one line", () => {
    const text = '{\n  "a": {\n    "b": "1",\n    "c": "2"\n  },\n  "d": "3"\n}\n';
    const out = setAt(text, ["a", "b"], "z", detectStyle(text));
    const a = text.split("\n");
    const b = out.split("\n");
    expect(b.length).toBe(a.length);
    expect(a.filter((l, i) => l !== b[i])).toEqual(['    "b": "1",']);
  });
});
