import { ArrowUp, Square } from "iconoir-react";
import { ACCENTS, accentChain, createShader, playSweep } from "glimm";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PluginView, RunStatus } from "../../shared/protocol";

/* The built-in palette reads blue/purple; build a true full-spectrum rainbow. */
const RAINBOW = accentChain([
  ACCENTS.red,
  ACCENTS.orange,
  ACCENTS.yellow,
  ACCENTS.green,
  ACCENTS.cyan,
  ACCENTS.blue,
  ACCENTS.purple,
]);

type Menu =
  | { readonly kind: "slash"; readonly query: string; readonly start: number }
  | { readonly kind: "at"; readonly query: string; readonly start: number };

type MenuRow =
  | { readonly key: string; readonly type: "skill"; readonly name: string; readonly desc: string }
  | { readonly key: string; readonly type: "plugin"; readonly plugin: PluginView };

/* the last @word or /word being typed, if any */
function parseToken(draft: string): Menu | null {
  const match = /(^|\s)([@/])([\w-]*)$/.exec(draft);
  if (!match) return null;
  return {
    kind: match[2] === "@" ? "at" : "slash",
    query: match[3].toLowerCase(),
    start: match.index + match[1].length,
  };
}

function authUrl(plugin: PluginView): string | null {
  return plugin.kind === "mcp" && plugin.connection.state === "authenticating" ? plugin.connection.authUrl : null;
}

function pluginHint(plugin: PluginView): string {
  if (plugin.kind === "skill") return plugin.enabled ? "Skill · on" : "Skill · off";
  const state = plugin.connection.state;
  if (state === "ready") return `${plugin.tools.length} tools`;
  return state === "authenticating" ? "Needs authorization" : state;
}

export function Composer({
  skills,
  plugins,
  run,
  onSend,
  onStop,
  onTogglePlugin,
}: {
  skills: readonly { name: string; description: string }[];
  plugins: readonly PluginView[];
  run: RunStatus | undefined;
  onSend(text: string): void;
  onStop(): void;
  onTogglePlugin(id: string, enabled: boolean): void;
}) {
  const [draft, setDraft] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [rowBox, setRowBox] = useState<{ top: number; height: number } | null>(null);
  const [engaged, setEngaged] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rowRefs = useRef<(HTMLElement | null)[]>([]);
  const glimmRef = useRef<HTMLCanvasElement>(null);
  const shaderRef = useRef<ReturnType<typeof createShader> | null>(null);
  const sweepingRef = useRef(false);

  const busy = run !== undefined && run.phase !== "idle";
  const token = dismissed ? null : parseToken(draft);

  const rows: MenuRow[] =
    token?.kind === "slash"
      ? skills
          .filter((s) => s.name.toLowerCase().startsWith(token.query))
          .map((s) => ({ key: `skill:${s.name}`, type: "skill", name: s.name, desc: s.description }))
      : token?.kind === "at"
        ? plugins
            .filter((p) => p.name.toLowerCase().includes(token.query))
            .map((p) => ({ key: `plugin:${p.id}`, type: "plugin", plugin: p }))
        : [];

  useEffect(() => {
    setActive(0);
    setEngaged(false);
  }, [token?.kind, token?.query]);

  /* a single highlight glides to the active row instead of each row toggling its own background */
  useLayoutEffect(() => {
    const target = rowRefs.current[active];
    if (target) setRowBox({ top: target.offsetTop, height: target.offsetHeight });
  }, [token?.kind, token?.query, active, rows.length]);

  /* createShader seeds its hue from Math.random(); pin it so the sweep colour is stable. */
  const makeShader = () => {
    const canvas = glimmRef.current;
    if (!canvas) return null;
    const random = Math.random;
    Math.random = () => 0;
    try {
      return createShader({ canvas, palette: RAINBOW, direction: "ltr", bandTight: 10, swellAmount: 0.85 });
    } finally {
      Math.random = random;
    }
  };

  useEffect(() => {
    shaderRef.current = makeShader();
    return () => {
      shaderRef.current?.destroy();
      shaderRef.current = null;
    };
  }, []);

  const sweep = () => {
    if (sweepingRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    shaderRef.current?.destroy();
    const shader = makeShader();
    shaderRef.current = shader;
    if (!shader) return;
    sweepingRef.current = true;
    playSweep(shader, {
      palette: RAINBOW,
      direction: "ltr",
      sweepMs: 570,
      outroMs: 80,
      peakAlpha: 1.3,
      bandTight: 10,
      brightness: 1.4,
      swellAmount: 1,
      waveSpeed: 1.8,
      easing: "easeOutExpo",
    }).done.finally(() => {
      sweepingRef.current = false;
    });
  };

  /* grow with content up to a compact maximum */
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const maxHeight = 160;
    input.style.height = "0px";
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 40), maxHeight)}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [draft]);

  const pick = (row: MenuRow) => {
    if (!token) return;
    const head = draft.slice(0, token.start);
    if (row.type === "skill") {
      setDraft(`${head}Use the ${row.name} skill: `);
    } else {
      setDraft(`${head}@${row.plugin.name} `);
    }
    setDismissed(false);
    inputRef.current?.focus();
  };

  const canSend = draft.trim().length > 0 && !busy;
  const send = () => {
    if (!canSend) return;
    sweep();
    onSend(draft.trim());
    setDraft("");
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      <div className="relative">
        {token && (
          <div
            onMouseLeave={() => setEngaged(false)}
            className="absolute inset-x-0 bottom-full z-10 mb-2 max-h-72 overflow-y-auto rounded-[10px] bg-surface p-1 shadow-raised"
            style={{ animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom center" }}
          >
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-1 rounded-[6px] bg-hover"
              style={{
                top: rowBox?.top ?? 0,
                height: rowBox?.height ?? 0,
                opacity: rowBox && engaged && rows.length > 0 ? 1 : 0,
                transition:
                  "top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease",
              }}
            />
            {rows.map((row, i) => {
              const link = row.type === "plugin" ? authUrl(row.plugin) : null;
              return (
                <div
                  key={row.key}
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  onMouseEnter={() => {
                    setActive(i);
                    setEngaged(true);
                  }}
                  className="relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[6px] px-2"
                >
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pick(row)}
                    className="flex h-full min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    <span className="shrink-0 text-[12.5px] font-medium text-ink">
                      {row.type === "skill" ? `/${row.name}` : `@${row.plugin.name}`}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
                      {row.type === "skill" ? row.desc : pluginHint(row.plugin)}
                    </span>
                  </button>
                  {row.type === "plugin" &&
                    (link ? (
                      <a
                        href={link}
                        target="_blank"
                        rel="noopener"
                        className="shrink-0 text-[12px] font-medium text-accent-ink hover:underline"
                      >
                        Authorize
                      </a>
                    ) : (
                      <button
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => onTogglePlugin(row.plugin.id, !row.plugin.enabled)}
                        className={`shrink-0 text-[12px] font-medium transition-colors duration-100 ${
                          row.plugin.enabled ? "text-green" : "text-accent-ink hover:underline"
                        }`}
                      >
                        {row.plugin.enabled ? "Enabled" : "Enable"}
                      </button>
                    ))}
                </div>
              );
            })}
            {rows.length === 0 && (
              <div className="flex h-9 items-center px-2 text-[12px] text-ink-3">
                {token.kind === "slash" ? "No enabled skills match" : "No plugins match"}
              </div>
            )}
            <div className="mt-1 border-t border-line px-2 pt-1.5 pb-1 text-[11px] text-ink-3">
              {token.kind === "slash" ? "Insert a skill prompt" : "Toggle plugins for upcoming steps"}
            </div>
          </div>
        )}

        <div className="relative isolate flex flex-col gap-2.5 overflow-hidden rounded-[22px] border border-line bg-surface p-3.5 shadow-card transition-[border-color] duration-150 focus-within:border-line-strong">
          <canvas
            ref={glimmRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 h-full w-full"
            style={{ borderRadius: "inherit" }}
          />
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setDismissed(false);
              }}
              onKeyDown={(event) => {
                if (token && rows.length > 0) {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setEngaged(true);
                    setActive((current) => (current + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
                    return;
                  }
                  if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                    event.preventDefault();
                    pick(rows[active]);
                    return;
                  }
                }
                if (event.key === "Escape") {
                  setDismissed(true);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
              placeholder="Message the agent. / for skills, @ for plugins"
              aria-label="Prompt"
              className="min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-[14px] leading-5 text-ink outline-none [overflow-wrap:anywhere] placeholder:text-ink-3"
            />
            {busy ? (
              <button
                type="button"
                aria-label="Stop"
                onClick={onStop}
                className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-ink text-surface transition-[background-color,color,transform] duration-200 active:scale-[0.94]"
              >
                <Square width={12} height={12} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Send"
                disabled={!canSend}
                onClick={send}
                className="flex size-7 shrink-0 items-center justify-center rounded-[8px] transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94]"
                style={{
                  background: canSend ? "var(--ink)" : "var(--line-strong)",
                  color: canSend ? "var(--surface)" : "var(--ink-2)",
                }}
              >
                <ArrowUp width={16} height={16} strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
