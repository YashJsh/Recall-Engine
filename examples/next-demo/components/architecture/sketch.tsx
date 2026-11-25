"use client";

import { useEffect, useRef } from "react";
import rough from "roughjs";
import type { Options } from "roughjs/bin/core";

/** Declarative hand-drawn shapes. Coordinates are in the diagram's viewBox units. */
export type Shape =
  | { kind: "box"; x: number; y: number; w: number; h: number; tone?: Tone; radius?: number }
  | { kind: "circle"; x: number; y: number; d: number; tone?: Tone }
  | { kind: "line"; from: [number, number]; to: [number, number]; tone?: Tone; dashed?: boolean }
  | { kind: "arrow"; from: [number, number]; to: [number, number]; tone?: Tone; dashed?: boolean; bend?: number }
  | {
    kind: "text";
    x: number;
    y: number;
    text: string;
    size?: number;
    tone?: Tone;
    anchor?: "start" | "middle" | "end";
    font?: "hand" | "mono";
  };

/** muted = background structure, ink = normal, accent = highlighted, fill = highlighted with hatch fill. */
export type Tone = "muted" | "ink" | "accent" | "fill";

const STROKE: Record<Tone, string> = {
  muted: "#d4d4d4",
  ink: "#404040",
  accent: "#0a0a0a",
  fill: "#0a0a0a",
};

function options(tone: Tone, seed: number, extra: Options = {}): Options {
  return {
    seed,
    stroke: STROKE[tone],
    strokeWidth: tone === "accent" || tone === "fill" ? 1.8 : 1.2,
    roughness: 1.4,
    bowing: 1.2,
    ...(tone === "fill" ? { fill: "#fde68a", fillStyle: "hachure", hachureGap: 6, fillWeight: 1.1 } : {}),
    ...extra,
  };
}

/** Renders shapes with roughjs so diagrams look sketched on a whiteboard. A fixed seed keeps each line's wobble stable between renders. */
export function Sketch({
  width,
  height,
  shapes,
  label,
  className,
}: {
  width: number;
  height: number;
  shapes: Shape[];
  label: string;
  className?: string;
}) {
  const layer = useRef<SVGGElement>(null);

  useEffect(() => {
    const group = layer.current;
    const svg = group?.ownerSVGElement;
    if (!group || !svg) return;
    const rc = rough.svg(svg);
    group.replaceChildren();

    shapes.forEach((shape, index) => {
      const seed = index + 7;
      const tone = shape.tone ?? "ink";
      if (shape.kind === "box") {
        const r = shape.radius ?? 10;
        const { x, y, w, h } = shape;
        const path = `M${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x + r},${y + h} Q${x},${y + h} ${x},${y + h - r} L${x},${y + r} Q${x},${y} ${x + r},${y} Z`;
        group.appendChild(rc.path(path, options(tone, seed)));
      } else if (shape.kind === "circle") {
        group.appendChild(rc.circle(shape.x, shape.y, shape.d, options(tone, seed)));
      } else if (shape.kind === "line") {
        group.appendChild(rc.line(...shape.from, ...shape.to, options(tone, seed, shape.dashed ? { strokeLineDash: [6, 6] } : {})));
      } else if (shape.kind === "arrow") {
        const [x1, y1] = shape.from;
        const [x2, y2] = shape.to;
        const bend = shape.bend ?? 0;
        const mx = (x1 + x2) / 2 - (y2 - y1) * bend;
        const my = (y1 + y2) / 2 + (x2 - x1) * bend;
        const opts = options(tone, seed, shape.dashed ? { strokeLineDash: [6, 6] } : {});
        group.appendChild(rc.path(`M${x1},${y1} Q${mx},${my} ${x2},${y2}`, opts));
        const angle = Math.atan2(y2 - my, x2 - mx);
        const head = 10;
        for (const side of [-1, 1]) {
          const a = angle + Math.PI - side * 0.45;
          group.appendChild(rc.line(x2, y2, x2 + head * Math.cos(a), y2 + head * Math.sin(a), { ...opts, strokeLineDash: undefined }));
        }
      }
    });
  }, [shapes]);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className={className ?? "h-auto w-full"}>
      <g ref={layer} />
      {shapes.map((shape, index) => shape.kind === "text" && (
        <text
          key={index}
          x={shape.x}
          y={shape.y}
          textAnchor={shape.anchor ?? "middle"}
          dominantBaseline="middle"
          fill={STROKE[shape.tone ?? "ink"] === STROKE.muted ? "#a3a3a3" : STROKE[shape.tone ?? "ink"]}
          style={{
            fontFamily: shape.font === "mono" ? "var(--font-mono)" : "var(--font-hand)",
            fontSize: shape.size ?? (shape.font === "mono" ? 12 : 22),
          }}
        >
          {shape.text}
        </text>
      ))}
    </svg>
  );
}
