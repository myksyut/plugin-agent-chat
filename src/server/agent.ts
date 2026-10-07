import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { Agent, callable, getCurrentAgent, type Connection, type MCPServersState } from "agents";
import { PiHarness } from "agents/harness/pi";
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
import { CHATGPT_PROVIDER, ChatGPTLink, DEFAULT_MODEL } from "./chatgpt";
import { PluginBook } from "./plugins/book";

export type ViewerState = { readonly session: SessionId };

export class UserAgent extends Agent<Env, AppState> {
  initialState: AppState = { plugins: [], conversations: [], chatgpt: { state: "disconnected" } };

  readonly registry = createRegistry();
  readonly book = new PluginBook(this, () => super.getMcpServers());
  readonly hub = new ChatHub(this);
  readonly chatgpt = new ChatGPTLink(this, (slug) => this.hub.applyModel(slug));

  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      // Every plugin must be in the registry before pi resumes, or resumed tool tasks fail.
      await this.book.installAll();
      const models = createModels({ credentials: this.chatgpt.credentials });
      models.setProvider(this.chatgpt.provider);
      return Harness.open(
        storage,
        { models, registry: this.registry, onReport: (error) => console.error("pi extension failure", error) },
        context,
      );
    },
    defaults: { model: { provider: CHATGPT_PROVIDER, id: DEFAULT_MODEL } },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.harness);
  }

  async onStart(): Promise<void> {
    this.mcp.configureOAuthCallback({ customHandler: oauthResultPage });
    await this.hub.resume();
    this.mcp.onServerStateChanged(() => void this.book.reconcile());
    await this.book.deleteOrphans();
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
    this.setState({ plugins: this.book.views(), conversations: this.hub.conversations(), chatgpt: this.chatgpt.view() });
  }

  @callable()
  openConversation(session: SessionId): Promise<Outcome<null>> {
    return this.hub.open(viewer(), session);
  }

  @callable()
  newConversation(): Promise<Outcome<ConversationInfo>> {
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

  @callable()
  refreshPlugin(id: string): Promise<Outcome<Added>> {
    return this.book.refresh(id);
  }

  @callable()
  connectChatGPT(): Promise<Outcome<{ authorizeUrl: string }>> {
    return this.#published(this.chatgpt.begin());
  }

  @callable()
  completeChatGPT(callbackUrl: string): Promise<Outcome<null>> {
    return this.#published(this.chatgpt.complete(callbackUrl));
  }

  @callable()
  disconnectChatGPT(): Promise<Outcome<null>> {
    return this.#published(this.chatgpt.disconnect());
  }

  @callable()
  setModel(slug: string): Promise<Outcome<null>> {
    return this.#published(this.chatgpt.setModel(slug));
  }

  /** Test seam for the smoke script; never echoes the credential. */
  @callable()
  async importChatGPTCredential(credential: unknown): Promise<Outcome<null>> {
    if (this.env.AUTH_MODE !== "dev") return { ok: false, error: "Importing a credential is only allowed in dev mode." };
    return this.#published(this.chatgpt.import(credential));
  }

  async #published<T>(operation: Promise<Outcome<T>>): Promise<Outcome<T>> {
    const outcome = await operation;
    this.publish();
    return outcome;
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
