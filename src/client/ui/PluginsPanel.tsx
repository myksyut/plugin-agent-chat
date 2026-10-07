import { Check, NavArrowDown, Plus, Refresh, Trash, Xmark } from "iconoir-react";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Added, Outcome, PluginDraft, PluginView } from "../../shared/protocol";
import type { WorkspaceActions } from "../use-workspace";
import { Button } from "./Button";
import { ValuePill, type Tone } from "./atoms";
import { cn } from "./cn";

type Notice =
  | { readonly kind: "error"; readonly text: string }
  | { readonly kind: "info"; readonly text: string }
  | { readonly kind: "authorize"; readonly url: string };

function AuthorizeLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener"
      className="inline-flex h-6 items-center rounded-full bg-accent-tint px-2.5 text-[12px] font-medium text-accent-ink hover:underline"
    >
      Authorize
    </a>
  );
}

function NoticeLine({ notice }: { notice: Notice }) {
  switch (notice.kind) {
    case "error":
      return (
        <p role="alert" className="rounded-control bg-red-tint px-2.5 py-1.5 text-[12px] text-red [overflow-wrap:anywhere]">
          {notice.text}
        </p>
      );
    case "info":
      return <p className="text-[12px] text-green">{notice.text}</p>;
    case "authorize":
      return (
        <p className="flex items-center gap-2 text-[12px] text-ink-2">
          This server needs authorization. <AuthorizeLink url={notice.url} />
        </p>
      );
  }
}

function addedNotice(added: Added, done: string): Notice {
  return added.authorizeUrl ? { kind: "authorize", url: added.authorizeUrl } : { kind: "info", text: done };
}

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange(next: boolean): void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[18px] w-8 shrink-0 rounded-full transition-colors duration-150",
        checked ? "bg-green" : "bg-line-strong",
      )}
    >
      <span
        className="absolute top-[2px] left-[2px] size-[14px] rounded-full bg-white shadow-btn transition-transform duration-150"
        style={{ transform: checked ? "translateX(14px)" : "translateX(0)" }}
      />
    </button>
  );
}

type RowStatus = { readonly tone: Tone; readonly label: string; readonly badge: "spinner" | "check" | "alert" | "dot" };

function rowStatus(plugin: PluginView): RowStatus {
  if (plugin.kind === "skill") return { tone: "neutral", label: "Skill", badge: "check" };
  switch (plugin.connection.state) {
    case "connecting":
      return { tone: "neutral", label: "Connecting", badge: "spinner" };
    case "ready":
      return { tone: "green", label: "Connected", badge: "check" };
    case "authenticating":
      return { tone: "accent", label: "Needs auth", badge: "dot" };
    case "failed":
      return { tone: "red", label: "Failed", badge: "alert" };
  }
}

function Badge({ badge }: { badge: RowStatus["badge"] }) {
  const base = "flex size-5.5 shrink-0 items-center justify-center rounded-full text-white";
  switch (badge) {
    case "spinner":
      return (
        <span
          className="size-4 shrink-0 rounded-full border-2 border-line-strong border-t-ink-2"
          style={{ animation: "spin 700ms linear infinite" }}
        />
      );
    case "check":
      return (
        <span className={`${base} bg-green`} style={{ animation: "pop-in 300ms cubic-bezier(0.23,1,0.32,1) both" }}>
          <Check width={13} height={13} strokeWidth={3.5} />
        </span>
      );
    case "alert":
      return (
        <span className={`${base} bg-red`} style={{ animation: "pop-in 300ms cubic-bezier(0.23,1,0.32,1) both" }}>
          <Xmark width={12} height={12} strokeWidth={3.5} />
        </span>
      );
    case "dot":
      return <span className={`${base} bg-accent text-[11px] font-semibold`}>!</span>;
  }
}

function PluginDetail({ plugin }: { plugin: PluginView }) {
  if (plugin.kind === "skill") {
    return (
      <div className="flex flex-col gap-1.5 text-[12px] text-ink-2">
        <span>{plugin.description}</span>
        <span className="text-ink-3">
          {plugin.origin.type === "pasted"
            ? "Pasted SKILL.md"
            : `From ${plugin.origin.url} · fetched ${new Date(plugin.origin.fetchedAt).toLocaleString()}`}
        </span>
        {plugin.hiddenFromModel && <span className="text-ink-3">Hidden from the model; invoke it with /{plugin.name}.</span>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[11.5px] break-all text-ink-3">{plugin.displayUrl}</span>
      {plugin.headerNames.length > 0 && (
        <span className="text-[12px] text-ink-3">Headers: {plugin.headerNames.join(", ")} (values hidden)</span>
      )}
      {plugin.connection.state === "failed" && (
        <span className="text-[12px] text-red [overflow-wrap:anywhere]">{plugin.connection.error}</span>
      )}
      {plugin.tools.map((tool) => (
        <div key={tool.name} className="flex items-baseline justify-between gap-3">
          <span className="shrink-0 font-mono text-[11.5px] text-ink">{tool.name}</span>
          <span className="min-w-0 truncate text-[12px] text-ink-3">{tool.description}</span>
        </div>
      ))}
      {plugin.tools.length === 0 && <span className="text-[12px] text-ink-3">No tools reported yet.</span>}
    </div>
  );
}

function PluginRow({ plugin, index, actions }: { plugin: PluginView; index: number; actions: WorkspaceActions }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const status = rowStatus(plugin);
  const pending = plugin.kind === "mcp" && plugin.connection.state === "authenticating" ? plugin.connection.authUrl : null;
  const authorize = notice?.kind === "authorize" ? notice.url : pending;

  const act = async <T,>(call: () => Promise<Outcome<T>>, onOk: (value: T) => Notice | null = () => null) => {
    setBusy(true);
    setNotice(null);
    const result = await call();
    setBusy(false);
    setNotice(result.ok ? onOk(result.value) : { kind: "error", text: result.error });
  };

  return (
    <div
      className={cn("overflow-hidden bg-surface shadow-card transition-[border-radius,opacity] duration-300 hover:bg-inset", !plugin.enabled && "opacity-70")}
      style={{ borderRadius: open ? 14 : 22, animation: `fade-up 450ms cubic-bezier(0.23,1,0.32,1) ${index * 80}ms both` }}
    >
      <div className="flex h-11 w-full items-center gap-2 pr-2.5 pl-2.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <span className="flex size-6 shrink-0 items-center justify-center">
            <Badge badge={status.badge} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{plugin.name}</span>
          <span className="text-[12.5px] text-ink-2 tabular-nums">
            {plugin.kind === "mcp" ? `${plugin.tools.length} tools` : plugin.origin.type === "url" ? "from URL" : "pasted"}
          </span>
          <ValuePill tone={status.tone}>{status.label}</ValuePill>
          <NavArrowDown
            width={15}
            height={15}
            strokeWidth={2.2}
            className="shrink-0 text-ink-3 transition-transform duration-300"
            style={{ transform: open ? "rotate(180deg)" : "rotate(0)" }}
          />
        </button>
        <Switch
          checked={plugin.enabled}
          label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
          onChange={(next) => void act(() => actions.setPluginEnabled(plugin.id, next))}
        />
        <button
          type="button"
          aria-label={`Refresh ${plugin.name}`}
          disabled={busy}
          onClick={() => void act(() => actions.refreshPlugin(plugin.id), (added) => (added.authorizeUrl ? addedNotice(added, "") : null))}
          className="primitive-icon-button text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink disabled:opacity-50"
        >
          <Refresh width={15} height={15} style={busy ? { animation: "spin 1.1s linear infinite" } : undefined} />
        </button>
        {confirming ? (
          <span className="flex items-center gap-1">
            <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button
              size="xs"
              variant="primary"
              disabled={busy}
              onClick={() => void act(() => actions.removePlugin(plugin.id))}
            >
              Remove
            </Button>
          </span>
        ) : (
          <button
            type="button"
            aria-label={`Remove ${plugin.name}`}
            onClick={() => setConfirming(true)}
            className="primitive-icon-button text-ink-3 transition-colors duration-100 hover:bg-red-tint hover:text-red"
          >
            <Trash width={15} height={15} />
          </button>
        )}
      </div>

      {(authorize || (notice && notice.kind !== "authorize")) && (
        <div className="flex flex-col gap-1.5 px-2.5 pb-2.5">
          {authorize && <NoticeLine notice={{ kind: "authorize", url: authorize }} />}
          {notice && notice.kind !== "authorize" && <NoticeLine notice={notice} />}
        </div>
      )}

      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0, transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" }}
      >
        <div className="overflow-hidden">
          <div className="mb-2.5 grid grid-cols-[24px_minmax(0,1fr)] gap-2.5 px-2.5">
            <span aria-hidden className="mx-auto h-full w-px bg-line" />
            <PluginDetail plugin={plugin} />
          </div>
        </div>
      </div>
    </div>
  );
}

const fieldClass =
  "h-8 w-full min-w-0 rounded-control bg-field px-2.5 text-[13px] text-ink shadow-hairline outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_1px_var(--line-strong)]";

type HeaderRow = { readonly key: number; readonly name: string; readonly value: string };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-ink-2">{label}</span>
      {children}
    </label>
  );
}

function McpForm({ submit }: { submit(draft: PluginDraft): Promise<boolean> }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<readonly HeaderRow[]>([]);
  const nextKey = useRef(0);

  const patch = (key: number, change: Partial<HeaderRow>) =>
    setHeaders((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (event: FormEvent) => {
        event.preventDefault();
        const ok = await submit({
          kind: "mcp",
          name: name.trim(),
          url: url.trim(),
          headers: headers.filter((h) => h.name.trim() !== "").map((h) => ({ name: h.name.trim(), value: h.value })),
        });
        if (ok) {
          setName("");
          setUrl("");
          setHeaders([]);
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <Field label="Name">
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="github" className={fieldClass} />
        </Field>
        <Field label="Server URL">
          <input
            required
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/mcp"
            className={fieldClass}
          />
        </Field>
      </div>
      {headers.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-medium text-ink-2">Headers (values are write-only)</span>
          {headers.map((row) => (
            <div key={row.key} className="flex items-center gap-2">
              <input
                value={row.name}
                onChange={(e) => patch(row.key, { name: e.target.value })}
                placeholder="Authorization"
                aria-label="Header name"
                className={fieldClass}
              />
              <input
                type="password"
                autoComplete="off"
                value={row.value}
                onChange={(e) => patch(row.key, { value: e.target.value })}
                placeholder="Bearer …"
                aria-label="Header value"
                className={fieldClass}
              />
              <button
                type="button"
                aria-label="Remove header"
                onClick={() => setHeaders((rows) => rows.filter((r) => r.key !== row.key))}
                className="primitive-icon-button shrink-0 text-ink-3 hover:bg-hover-2 hover:text-ink"
              >
                <Xmark width={14} height={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setHeaders((rows) => [...rows, { key: nextKey.current++, name: "", value: "" }])}
        >
          <Plus width={13} height={13} /> Header
        </Button>
        <Button type="submit" size="sm" variant="primary">
          Add MCP server
        </Button>
      </div>
    </form>
  );
}

function SkillPasteForm({ submit }: { submit(draft: PluginDraft): Promise<boolean> }) {
  const [markdown, setMarkdown] = useState("");
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (event: FormEvent) => {
        event.preventDefault();
        if (await submit({ kind: "skill", markdown })) setMarkdown("");
      }}
    >
      <Field label="SKILL.md">
        <textarea
          required
          rows={8}
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
          placeholder={"---\nname: my-skill\ndescription: When to use it\n---\n\nInstructions…"}
          className="min-h-32 w-full resize-y rounded-control bg-field p-2.5 font-mono text-[12px] leading-[1.6] text-ink shadow-hairline outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_1px_var(--line-strong)]"
        />
      </Field>
      <div>
        <Button type="submit" size="sm" variant="primary">
          Add skill
        </Button>
      </div>
    </form>
  );
}

function SkillUrlForm({ submit }: { submit(draft: PluginDraft): Promise<boolean> }) {
  const [url, setUrl] = useState("");
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (event: FormEvent) => {
        event.preventDefault();
        if (await submit({ kind: "skill-url", url: url.trim() })) setUrl("");
      }}
    >
      <Field label="SKILL.md URL (https)">
        <input
          required
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo/blob/main/SKILL.md"
          className={fieldClass}
        />
      </Field>
      <div>
        <Button type="submit" size="sm" variant="primary">
          Add skill from URL
        </Button>
      </div>
    </form>
  );
}

const TABS = [
  { key: "mcp", label: "MCP server" },
  { key: "skill", label: "Skill (paste)" },
  { key: "skill-url", label: "Skill (URL)" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function AddPlugin({ actions }: { actions: WorkspaceActions }) {
  const [tab, setTab] = useState<TabKey>("mcp");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (draft: PluginDraft): Promise<boolean> => {
    setPending(true);
    setNotice(null);
    const result = await actions.addPlugin(draft);
    setPending(false);
    setNotice(result.ok ? addedNotice(result.value, "Added.") : { kind: "error", text: result.error });
    return result.ok;
  };

  return (
    <section className="overflow-hidden rounded-card bg-surface shadow-card" aria-busy={pending}>
      <div className="flex shrink-0 items-center border-b border-line p-1.5">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={tab === item.key}
            onClick={() => {
              setTab(item.key);
              setNotice(null);
            }}
            className={`rounded-[6px] px-2 py-[3px] text-[13px] text-ink transition-[background-color,opacity] duration-100 ${tab === item.key ? "bg-field" : "opacity-50 hover:opacity-75"}`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-3 p-3">
        <fieldset disabled={pending} className="contents">
          {tab === "mcp" && <McpForm submit={submit} />}
          {tab === "skill" && <SkillPasteForm submit={submit} />}
          {tab === "skill-url" && <SkillUrlForm submit={submit} />}
        </fieldset>
        {notice && <NoticeLine notice={notice} />}
      </div>
    </section>
  );
}

export function PluginsPanel({ plugins, actions }: { plugins: readonly PluginView[]; actions: WorkspaceActions }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6">
        <header>
          <h1 className="text-[16px] font-semibold text-ink">Plugins</h1>
          <p className="text-[13px] text-ink-2">MCP servers give the agent tools; skills give it instructions.</p>
        </header>

        <div className="flex flex-col gap-2">
          {plugins.map((plugin, i) => (
            <PluginRow key={plugin.id} plugin={plugin} index={i} actions={actions} />
          ))}
          {plugins.length === 0 && <p className="py-4 text-center text-[13px] text-ink-3">No plugins yet.</p>}
          <p className="text-[12px] text-ink-3">Changes apply to upcoming agent steps.</p>
        </div>

        <AddPlugin actions={actions} />
      </div>
    </div>
  );
}
