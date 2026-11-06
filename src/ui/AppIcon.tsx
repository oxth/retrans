import { useId } from "react";

/**
 * The Retrans app icon, drawn like the real one (src-tauri/icons/app-icon.svg, cropped to the tile
 * as site/icon.svg): a key/value grid with one missing translation. Decorative.
 */
export function AppIcon({ size = 44, className = "" }: { size?: number; className?: string }) {
  // Unique gradient ids: the icon can be on screen twice (start screen behind Settings).
  const id = useId().replace(/:/g, "");
  const bg = `${id}-bg`;
  const ring = `${id}-ring`;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false" className={`shrink-0 ${className}`}>
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f46e5" />
          <stop offset="1" stopColor="#0d9488" />
        </linearGradient>
        <linearGradient id={ring} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="100">
          <stop offset="0" stopColor="#4f46e5" />
          <stop offset="1" stopColor="#0d9488" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="22.5" fill={`url(#${bg})`} />
      <g fill="#ffffff">
        <rect x="17.5" y="25" width="22" height="11" rx="4" opacity=".55" />
        <rect x="44.5" y="25" width="33" height="11" rx="4" />
        <rect x="17.5" y="44.5" width="22" height="11" rx="4" opacity=".55" />
        <rect x="17.5" y="64" width="22" height="11" rx="4" opacity=".55" />
        <rect x="44.5" y="64" width="33" height="11" rx="4" />
      </g>
      <rect x="46" y="46" width="30" height="8" rx="3" fill="none" stroke="#fca5a5" strokeWidth="3" strokeDasharray="9 4.5" />
      <circle cx="76.5" cy="45" r="5.5" fill="#f87171" stroke={`url(#${ring})`} strokeWidth="3" />
    </svg>
  );
}
