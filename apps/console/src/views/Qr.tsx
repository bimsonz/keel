// A QR code as plain SVG. Always dark on light, whatever the theme: a camera
// reads contrast, not a palette.

import { useMemo } from "react";
import { encode } from "uqr";

export function Qr({ text, size, label }: { text: string; size: number; label: string }) {
  const { path, modules } = useMemo(() => {
    const code = encode(text, { ecc: "M", border: 2 });
    let d = "";
    code.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { path: d, modules: code.size };
  }, [text]);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${modules} ${modules}`}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-md"
    >
      <title>{label}</title>
      <rect width={modules} height={modules} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
