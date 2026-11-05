import { inputCls } from "./Dialog";
import { useMemo, useState } from "react";
import { COMMON_LOCALES, localeLabel } from "./locales";

interface Props {
  label: string;
  selected: string[];
  multiple?: boolean;
  exclude?: string[];
  onChange(selected: string[]): void;
}

export function LocalePicker({ label, selected, multiple, exclude = [], onChange }: Props) {
  const [q, setQ] = useState("");
  const items = useMemo(
    () => COMMON_LOCALES.filter((c) => !exclude.includes(c)).map((code) => ({ code, name: localeLabel(code) })),
    [exclude.join(",")], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? items.filter((i) => i.code.toLowerCase().includes(needle) || i.name.toLowerCase().includes(needle))
    : items;
  const toggle = (code: string) => {
    if (!multiple) return onChange([code]);
    onChange(selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code]);
  };
  return (
    <div>
      <input
        aria-label={label}
        placeholder="Search languages"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className={inputCls}
      />
      <ul className="mt-2 max-h-56 overflow-auto rounded-md border border-line">
        {shown.map((i) => (
          <li key={i.code}>
            <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-hover">
              <input
                type={multiple ? "checkbox" : "radio"}
                name={label}
                checked={selected.includes(i.code)}
                onChange={() => toggle(i.code)}
              />
              <span className="font-mono text-xs text-muted">{i.code}</span>
              <span>{i.name}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
