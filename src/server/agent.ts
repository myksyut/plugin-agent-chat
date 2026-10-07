// The per-user Durable Object: wiring, lifecycle hooks, and one-line @callable adapters.
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { Agent, callable, getCurrentAgent, type Connection, type MCPServersState } from "agents";
import { PiHarness } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";
import type {
  Added,
  AppState,
  ConversationInfo,
  Outcome,
  PluginDraft,
  SendInput,
  SessionId,
} from "../shared/protocol";
import { ChatHub } from "./chat/hub";
import { PluginBook } from "./plugins/book";

/** Per-connection hibernation attachment: the conversation this socket views. */
export type ViewerState = { readonly session: SessionId };

export class UserAgent extends Agent<Env, AppState> {
  initialState: AppState = { plugins: [], conversations: [], model: "" };

  readonly modelId: string = this.env.MODEL_ID;
  readonly ai = createAI({ binding: this.env.AI });
  readonly registry = createRegistry();
  readonly book = new PluginBook(this, () => super.getMcpServers());
  readonly hub = new ChatHub(this);

  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      // Every plugin must be in the registry before pi resumes, or resumed tool tasks fail.
      await this.book.installAll();
      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(storage, { models, registry: this.registry }, context);
    },
    defaults: { model: this.ai(this.modelId) },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.harness);
  }

  /** Every isolate start: cold start, hibernation wake, or a pi wake alarm. */
  async onStart(): Promise<void> {
    this.mcp.configureOAuthCallback({ customHandler: oauthResultPage });
    await this.hub.resume();
    this.mcp.onServerStateChanged(() => void this.book.reconcile());
    await this.book.sweep();
  }

  async onClose(connection: Connection): Promise<void> {
    await this.hub.close(connection as Connection<ViewerState>);
  }

  /** Both SDK broadcast sites read this; the browser gets plugin state only through AppState. */
  getMcpServers(): MCPServersState {
    return { servers: {}, tools: [], prompts: [], resources: [] };
  }

  validateStateChange(_next: AppState, source: Connection | "server"): void {
    if (source !== "server") throw new Error("AppState is written by the server only");
  }

  publish(): void {
    this.setState({ plugins: this.book.views(), conversations: this.hub.conversations(), model: this.modelId });
  }

  @callable()
  openConversation(session: SessionId): Promise<Outcome<null>> {
    return this.hub.open(viewer(), session);
  }

  @callable()
  newConversation(): Promise<ConversationInfo> {
    return this.hub.create(viewer());
  }

  @callable()
  send(input: SendInput): Promise<Outcome<{ accepted: boolean }>> {
    return this.hub.send(input);
  }

  @callable()
  abort(session: SessionId): Promise<boolean> {
    return this.hub.abort(session);
  }

  @callable()
  addPlugin(draft: PluginDraft): Promise<Outcome<Added>> {
    return this.book.add(draft);
  }

  @callable()
  setPluginEnabled(id: string, enabled: boolean): Promise<Outcome<null>> {
    return this.book.setEnabled(id, enabled);
  }

  @callable()
  removePlugin(id: string): Promise<Outcome<null>> {
    return this.book.remove(id);
  }

  /** skill-url: re-fetch; mcp: reconnect, or return a fresh authorize URL. */
  @callable()
  refreshPlugin(id: string): Promise<Outcome<Added>> {
    return this.book.refresh(id);
  }
}

function viewer(): Connection<ViewerState> {
  const { connection } = getCurrentAgent();
  if (!connection) throw new Error("This method needs a WebSocket connection");
  return connection as Connection<ViewerState>;
}

function oauthResultPage(result: { authSuccess: boolean; authError?: string }): Response {
  const message = result.authSuccess
    ? "Connected, you can close this tab."
    : `Authorization failed: ${result.authError ?? "unknown error"}`;
  const escaped = message.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  const html = `<!doctype html><meta charset="utf-8"><title>MCP authorization</title>
<body style="font-family: system-ui, sans-serif; padding: 2rem"><p>${escaped}</p>
${result.authSuccess ? "<script>window.close()</script>" : ""}</body>`;
  return new Response(html, {
    status: result.authSuccess ? 200 : 400,
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" },
  });
}
