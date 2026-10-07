import { useEffect, useState } from "react";
import type { RunStatus } from "../../shared/protocol";

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3);
  const c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

function LoaderGrid() {
  return (
    <span aria-hidden className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
      {chevron.map((delay, index) => (
        <span
          key={index}
          className="size-[4px] rounded-full bg-ink"
          style={{ opacity: 0.15, animation: `pixel-on 650ms ease-in-out ${delay}ms infinite` }}
        />
      ))}
    </span>
  );
}

function formatElapsed(ms: number) {
  const total = Math.max(0, ms) / 1000;
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

function useElapsed(startedAt: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  return formatElapsed(now - startedAt);
}

function Indicator({ label, startedAt }: { label: string; startedAt: number }) {
  const elapsed = useElapsed(startedAt);
  return (
    <div role="status" className="flex w-fit max-w-full items-center gap-2.5">
      <LoaderGrid />
      <span
        className="min-w-0 truncate bg-clip-text text-[13px] font-medium text-transparent"
        style={{
          backgroundImage: "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
          backgroundSize: "200% 100%",
          animation: "shimmer-text 1.4s linear infinite",
        }}
      >
        {label}
      </span>
      <span className="shrink-0 font-mono text-[12px] text-ink-3 tabular-nums">{elapsed}</span>
    </div>
  );
}

/** Pixel-grid loader with a shimmering label and a live timer while the agent works. */
export function RunIndicator({ run }: { run: RunStatus | undefined }) {
  if (run === undefined || run.phase === "idle") return null;
  return run.phase === "running" ? (
    <Indicator label="Working" startedAt={run.since} />
  ) : (
    <Indicator label={`Retrying: ${run.error}`} startedAt={run.at} />
  );
}
