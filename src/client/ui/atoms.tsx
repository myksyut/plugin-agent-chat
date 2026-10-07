import type { ReactNode } from "react";

/** Monogram mark — a colored disc with an initial or short glyph. */
export function Monogram({
  children,
  color = "#e08a3c",
  className = "",
}: {
  children: ReactNode;
  color?: string;
  className?: string;
}) {
  return (
    <span
      className={`flex size-4 shrink-0 items-center justify-center rounded-full
        text-[9px] font-semibold leading-none text-white ${className}`}
      style={{ background: color }}
    >
      {children}
    </span>
  );
}

/** Inline entity reference — a monogram + name in a soft field pill. Marks a plugin inside running text. */
export function EntityChip({ name, color, className = "" }: { name: string; color?: string; className?: string }) {
  return (
    <span
      className={`mx-0.5 inline-flex items-center gap-1 rounded-full bg-field
        py-px pl-[3px] pr-1.5 align-middle shadow-hairline ${className}`}
    >
      <Monogram color={color}>{name.charAt(0).toUpperCase()}</Monogram>
      <span className="text-[12px] font-medium text-ink">{name}</span>
    </span>
  );
}

/** Shimmering label — signals the agent is processing. */
export function Shimmer({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-block bg-clip-text text-transparent ${className}`}
      style={{
        backgroundImage: "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
        backgroundSize: "200% 100%",
        animation: "shimmer-text 1.8s linear infinite",
      }}
    >
      {children}
    </span>
  );
}

export type Tone = "neutral" | "green" | "orange" | "red" | "accent";

const TONES: Record<Tone, { cls: string; ring: string }> = {
  neutral: { cls: "bg-field text-ink-2", ring: "var(--shadow-hairline)" },
  green: { cls: "bg-green-tint text-green", ring: "0 0 0 1px color-mix(in oklch, var(--green) 28%, transparent)" },
  orange: { cls: "bg-orange-tint text-orange", ring: "0 0 0 1px color-mix(in oklch, var(--orange) 28%, transparent)" },
  red: { cls: "bg-red-tint text-red", ring: "0 0 0 1px color-mix(in oklch, var(--red) 28%, transparent)" },
  accent: { cls: "bg-accent-tint text-accent-ink", ring: "0 0 0 1px color-mix(in oklch, var(--accent) 28%, transparent)" },
};

/** Inline value badge — a plain value (a state, a count) set off in prose. */
export function ValuePill({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  const t = TONES[tone];
  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-0 align-middle text-[12px] font-medium ${t.cls} ${className}`}
      style={{ boxShadow: t.ring }}
    >
      {children}
    </span>
  );
}
