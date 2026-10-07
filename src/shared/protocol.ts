export type SessionId = string;
export const ROOT_SESSION_ID: SessionId = "1";

export type Turn =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly parts: readonly Part[];
      readonly live: boolean;
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
  readonly plugin: string | null;
  readonly tool: string;
  readonly args: string;
  readonly status: ToolStatus;
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
  readonly queued: number;
};

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

export type PluginView =
  | {
      readonly kind: "mcp";
      readonly id: string;
      readonly name: string;
      readonly enabled: boolean;
      readonly displayUrl: string;
      readonly headerNames: readonly string[];
      readonly connection: McpConnection;
      readonly tools: readonly { readonly name: string; readonly description: string }[];
    }
  | {
      readonly kind: "skill";
      readonly id: string;
      readonly name: string;
      readonly description: string;
      readonly enabled: boolean;
      readonly origin: SkillOrigin;
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

export type Added = { readonly id: string; readonly authorizeUrl: string | null };

export type ConversationInfo = {
  readonly id: SessionId;
  readonly title: string;
  readonly updatedAt: number;
};

export type AppState = {
  readonly plugins: readonly PluginView[];
  readonly conversations: readonly ConversationInfo[];
  readonly model: string;
};

export type Me = { readonly agentName: string; readonly email: string | null };
