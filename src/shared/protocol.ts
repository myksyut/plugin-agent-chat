// Contract between the UserAgent Durable Object and the browser.
// No pi-durable, pi-ai, MCP or Agents SDK type may appear here.

export type SessionId = string;
export const ROOT_SESSION_ID: SessionId = "1";

export type Turn =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | {
      readonly kind: "assistant";
      /** Entry id once committed; `live:<n>` while streaming. */
      readonly id: string;
      readonly parts: readonly Part[];
      readonly live: boolean;
      /** AssistantMessage.errorMessage when the model stopped with an error or abort. */
      readonly error?: string;
    }
  | { readonly kind: "notice"; readonly id: string; readonly text: string };

export type Part =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "tool"; readonly call: ToolCallView };

export type ToolStatus = "preparing" | "running" | "done" | "error";

export type ToolCallView = {
  readonly id: string;
  /** Display name of the owning plugin; null for built-in tools such as activate_skill. */
  readonly plugin: string | null;
  /** Original (un-namespaced) tool name. */
  readonly tool: string;
  /** Compact JSON of the arguments, at most 2 KB. */
  readonly args: string;
  readonly status: ToolStatus;
  /** Live output or result text, bounded tail of at most 4 KB. */
  readonly output: string;
};

export type RunStatus =
  | { readonly phase: "idle" }
  | { readonly phase: "running"; readonly since: number }
  | { readonly phase: "retrying"; readonly at: number; readonly error: string };

export type ChatView = {
  readonly session: SessionId;
  readonly turns: readonly Turn[];
  readonly run: RunStatus;
  /** Inputs waiting in pi's inbox behind the current run. */
  readonly queued: number;
};

/**
 * The only custom server-to-client frame: replace `turns[from..]` with `turns`.
 * `from === 0` is a full view (open, reconnect, reset, overflow snapshot).
 */
export type ChatFrame = {
  readonly t: "chat.tail";
  readonly session: SessionId;
  readonly from: number;
  readonly turns: readonly Turn[];
  readonly run: RunStatus;
  readonly queued: number;
};

export function isChatFrame(message: unknown): message is ChatFrame {
  if (typeof message !== "object" || message === null) return false;
  const m = message as Record<string, unknown>;
  return (
    m.t === "chat.tail" &&
    typeof m.session === "string" &&
    typeof m.from === "number" &&
    Array.isArray(m.turns) &&
    typeof m.run === "object" &&
    typeof m.queued === "number"
  );
}

/**
 * Pure, idempotent client reducer. Returns "resync" when the frame cannot be applied
 * to the current view; the caller then re-opens the conversation to get a full frame.
 */
export function applyFrame(view: ChatView | null, frame: ChatFrame): ChatView | "resync" {
  if (frame.from === 0) {
    return { session: frame.session, turns: frame.turns, run: frame.run, queued: frame.queued };
  }
  if (view === null || view.session !== frame.session) return view ?? "resync";
  if (frame.from > view.turns.length) return "resync";
  return {
    session: view.session,
    turns: [...view.turns.slice(0, frame.from), ...frame.turns],
    run: frame.run,
    queued: frame.queued,
  };
}

export type SendInput = {
  readonly session: SessionId;
  readonly text: string;
  /** Client-generated idempotency key passed to pi as the operationId. */
  readonly operationId: string;
};

export type McpConnection =
  | { readonly state: "connecting" }
  | { readonly state: "ready" }
  | { readonly state: "authenticating"; readonly authUrl: string | null }
  | { readonly state: "failed"; readonly error: string };

export type SkillOrigin =
  | { readonly type: "pasted" }
  | { readonly type: "url"; readonly url: string; readonly fetchedAt: number };

/** Browser-safe projection. Never carries header values, tokens, or URL query strings. */
export type PluginView =
  | {
      readonly kind: "mcp";
      readonly id: string;
      readonly name: string;
      readonly enabled: boolean;
      /** origin + pathname only */
      readonly url: string;
      readonly headerNames: readonly string[];
      readonly connection: McpConnection;
      /** From the cached catalog; may be stale while not ready. */
      readonly tools: readonly { readonly name: string; readonly description: string }[];
    }
  | {
      readonly kind: "skill";
      readonly id: string;
      readonly name: string;
      readonly description: string;
      readonly enabled: boolean;
      readonly origin: SkillOrigin;
      /** metadata.disable-model-invocation === true */
      readonly hiddenFromModel: boolean;
    };

export type PluginDraft =
  | {
      readonly kind: "mcp";
      readonly name: string;
      readonly url: string;
      readonly headers: readonly { readonly name: string; readonly value: string }[];
    }
  | { readonly kind: "skill"; readonly markdown: string }
  | { readonly kind: "skill-url"; readonly url: string };

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** `authorize` is set when the MCP server needs OAuth; the UI renders it as a link. */
export type Added = { readonly id: string; readonly authorize: string | null };

export type ConversationInfo = {
  readonly id: SessionId;
  /** "" until the first send */
  readonly title: string;
  readonly updatedAt: number;
};

/** Agent state: written only by the server, broadcast by the SDK. */
export type AppState = {
  readonly plugins: readonly PluginView[];
  readonly conversations: readonly ConversationInfo[];
  readonly model: string;
};

export type Me = { readonly agentName: string; readonly email: string | null };
