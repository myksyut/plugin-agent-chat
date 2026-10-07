import {
  ChatBubble,
  EditPencil,
  Puzzle,
  Search,
  SidebarCollapse,
  SidebarExpand,
  Sparks,
  Xmark,
} from "iconoir-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ChatGPTState, ConversationInfo, Outcome } from "../../shared/protocol";
import type { Panel } from "../use-workspace";
import { Button } from "./Button";
import { GlideMenu } from "./GlideMenu";

const SIDEBAR_MOTION = {
  expandedWidth: 224,
  collapsedWidth: 52,
  duration: 280,
  copyDuration: 180,
  copyOffset: 8,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
};

const CHAT_SEARCH_MOTION = {
  duration: 180,
  closedWidth: 28,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
};

function GlideGroup({ children }: { children: ReactNode }) {
  return (
    <GlideMenu
      rowSelector="[data-row]"
      highlightClassName="sidebar-glide-highlight rounded-[7px] bg-hover-2"
      className="group/glide flex flex-col gap-px"
    >
      {children}
    </GlideMenu>
  );
}

function RailButton({
  icon,
  label,
  active = false,
  count,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  count?: string;
  onClick: () => void;
}) {
  return (
    <button
      data-row
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`sidebar-row relative z-10 mx-2 flex h-8 items-center rounded-[8px] px-2 text-left
        transition-[width,background-color,color,transform] duration-150 active:scale-[0.98]
        ${active ? "bg-hover-2 group-hover/glide:bg-transparent" : ""}`}
    >
      <span className={`flex size-5 shrink-0 items-center justify-center ${active ? "text-ink" : "text-ink-2"}`}>
        {icon}
      </span>
      <span
        className={`sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium ${active ? "text-ink" : "text-ink-2"}`}
      >
        {label}
      </span>
      {count && (
        <span className="sidebar-copy mr-2 shrink-0 text-[12px] font-medium tabular-nums text-ink-3">{count}</span>
      )}
    </button>
  );
}

function ChatGPTLine({ email, onDisconnect }: { email: string | null; onDisconnect(): Promise<Outcome<null>> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = `ChatGPT · ${email ?? "connected"}`;

  return (
    <div className="flex flex-col gap-1.5 px-2">
      <div className="flex h-7 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-3" title={label}>
          {label}
        </span>
        {confirming ? (
          <span className="flex shrink-0 items-center gap-1">
            <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button
              size="xs"
              variant="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                const result = await onDisconnect();
                setBusy(false);
                setConfirming(false);
                if (!result.ok) setError(result.error);
              }}
            >
              Disconnect
            </Button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="shrink-0 rounded-full px-1.5 text-[12px] font-medium text-ink-3 transition-colors duration-100 hover:text-red"
          >
            Disconnect
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="rounded-control bg-red-tint px-2 py-1 text-[12px] text-red [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
    </div>
  );
}

export function Sidebar({
  conversations,
  active,
  panel,
  pluginCount,
  email,
  chatgpt,
  onNew,
  onPick,
  onPanel,
  onDisconnect,
}: {
  conversations: readonly ConversationInfo[];
  active: string;
  panel: Panel;
  pluginCount: number;
  email: string | null;
  chatgpt: ChatGPTState;
  onNew(): void;
  onPick(id: string): void;
  onPanel(panel: Panel): void;
  onDisconnect(): Promise<Outcome<null>>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const needle = query.trim().toLowerCase();
  const recents = conversations
    .map((c) => ({ id: c.id, label: c.title || "New chat" }))
    .filter((c) => c.label.toLowerCase().includes(needle));

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
  };

  return (
    <aside
      data-sidebar-collapsed={collapsed}
      aria-label="Navigation"
      className="relative flex h-full shrink-0 overflow-hidden transition-[width]"
      style={
        {
          width: collapsed ? SIDEBAR_MOTION.collapsedWidth : SIDEBAR_MOTION.expandedWidth,
          transitionDuration: `${SIDEBAR_MOTION.duration}ms`,
          transitionTimingFunction: SIDEBAR_MOTION.easing,
          "--sidebar-copy-duration": `${SIDEBAR_MOTION.copyDuration}ms`,
          "--sidebar-copy-offset": `${SIDEBAR_MOTION.copyOffset}px`,
          "--sidebar-easing": SIDEBAR_MOTION.easing,
        } as CSSProperties
      }
    >
      <div className="flex min-h-0 w-[224px] shrink-0 flex-col">
        <div className="relative mb-2.5 h-10 shrink-0">
          <div className="sidebar-workspace-control absolute left-2 top-1 flex h-8 w-[164px] items-center px-2">
            <span className="sidebar-logo flex size-5 shrink-0 items-center justify-center text-ink">
              <Sparks width={18} height={18} />
            </span>
            <span className="sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium text-ink-2">
              Plugin Agent
            </span>
          </div>
          <button
            type="button"
            aria-label="Collapse sidebar"
            aria-hidden={collapsed}
            tabIndex={collapsed ? -1 : 0}
            onClick={() => {
              setCollapsed(true);
              closeSearch();
            }}
            className="sidebar-collapse-control absolute right-2 top-1 flex size-8 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-ink"
          >
            <SidebarCollapse width={18} height={18} />
          </button>
          <button
            type="button"
            aria-label="Expand sidebar"
            aria-hidden={!collapsed}
            tabIndex={collapsed ? 0 : -1}
            onClick={() => setCollapsed(false)}
            className="sidebar-expand-control absolute left-2 top-0.5 flex size-9 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-ink"
          >
            <SidebarExpand width={18} height={18} />
          </button>
        </div>

        <GlideGroup>
          <RailButton icon={<EditPencil width={18} height={18} />} label="New chat" onClick={onNew} />
          <RailButton
            icon={<ChatBubble width={18} height={18} />}
            label="Chat"
            active={panel === "chat"}
            onClick={() => onPanel("chat")}
          />
          <RailButton
            icon={<Puzzle width={18} height={18} />}
            label="Plugins"
            count={pluginCount > 0 ? String(pluginCount) : undefined}
            active={panel === "plugins"}
            onClick={() => onPanel("plugins")}
          />
        </GlideGroup>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          <div className="sidebar-copy relative mx-2 mb-1 h-8">
            <div
              aria-hidden={searchOpen}
              className={`absolute inset-0 flex items-center gap-1.5 px-2 text-[12.5px] font-medium text-ink-3 transition-[opacity,transform] ${searchOpen ? "pointer-events-none -translate-x-1 opacity-0" : "translate-x-0 opacity-100"}`}
              style={{
                transitionDuration: `${CHAT_SEARCH_MOTION.duration}ms`,
                transitionTimingFunction: CHAT_SEARCH_MOTION.easing,
              }}
            >
              <span>Chats</span>
            </div>
            <button
              type="button"
              aria-label="Search chats"
              aria-expanded={searchOpen}
              onClick={() => setSearchOpen(true)}
              className={`absolute right-0 top-0 z-10 flex size-8 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color,transform] hover:bg-hover-2 hover:text-ink active:scale-[0.96] ${searchOpen ? "pointer-events-none opacity-0" : "opacity-100"}`}
              style={{ transitionDuration: `${CHAT_SEARCH_MOTION.duration}ms` }}
            >
              <Search width={16} height={16} />
            </button>
            <div
              className={`absolute right-0 top-0 z-20 flex h-8 items-center overflow-hidden rounded-[8px] bg-field text-ink-3 shadow-hairline transition-[width,opacity] focus-within:text-ink-2 ${searchOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
              style={{
                width: searchOpen ? "100%" : CHAT_SEARCH_MOTION.closedWidth,
                transitionDuration: `${CHAT_SEARCH_MOTION.duration}ms`,
                transitionTimingFunction: CHAT_SEARCH_MOTION.easing,
              }}
            >
              <span className="ml-2 flex shrink-0 items-center justify-center">
                <Search width={15} height={15} />
              </span>
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") closeSearch();
                }}
                placeholder="Search chats"
                aria-label="Search chat history"
                className="ml-1.5 min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-ink-3"
              />
              <button
                type="button"
                aria-label="Close chat search"
                onClick={closeSearch}
                className="flex size-8 shrink-0 items-center justify-center rounded-[8px] text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-ink active:scale-[0.96]"
              >
                <Xmark width={16} height={16} />
              </button>
            </div>
          </div>

          <GlideGroup>
            {recents.map((item) => {
              const isActive = panel === "chat" && item.id === active;
              return (
                <button
                  key={item.id}
                  data-row
                  type="button"
                  title={item.label}
                  onClick={() => onPick(item.id)}
                  className={`sidebar-row relative z-10 mx-2 flex h-8 items-center rounded-[8px] px-2 text-left transition-[width,background-color,color,transform] duration-150 active:scale-[0.98] ${
                    isActive ? "bg-hover-2 group-hover/glide:bg-transparent" : ""
                  }`}
                >
                  <span
                    className={`sidebar-copy min-w-0 flex-1 truncate text-[14px] font-medium ${isActive ? "text-ink" : "text-ink-2"}`}
                  >
                    {item.label}
                  </span>
                </button>
              );
            })}
            {query && recents.length === 0 && (
              <div className="sidebar-copy mx-2 px-2 py-2 text-[12.5px] text-ink-3">No chats found</div>
            )}
          </GlideGroup>
        </div>

        {(email || chatgpt.state === "connected") && (
          <div className="sidebar-copy mx-2 mt-3 mb-3 flex w-[208px] flex-col gap-1 border-t border-line pt-3">
            {chatgpt.state === "connected" && <ChatGPTLine email={chatgpt.email} onDisconnect={onDisconnect} />}
            {email && (
              <span className="block truncate px-2 text-[12.5px] text-ink-3" title={email}>
                {email}
              </span>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
