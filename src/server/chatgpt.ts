import type { Credential, CredentialInfo, CredentialStore, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import type { ChatGPTState, Outcome } from "../shared/protocol";
import type { UserAgent } from "./agent";

/**
 * pi-ai's openai-responses omits the fields Sign in with ChatGPT rejects only for this provider id and
 * base URL (`isChatGPTSignIn`), so both stay exactly as they are.
 */
export const CHATGPT_PROVIDER = "openai";
export const DEFAULT_MODEL = "gpt-5.6-luna";

const RESOURCE = "https://api.openai.com/v1";
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
/** Fixed by OpenAI for dynamic clients; nothing listens there, so the user pastes the landing URL back. */
const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const AGENT_NAME = "Plugin Agent Chat";
const REFRESH_TIMEOUT_MS = 15_000;
const SUPPORTED_MODELS = new Set<string>(Object.values(OPENAI_MODELS).map((model) => model.id));

/** The stored OAuth credential: `clientId` is the client OpenAI issued at consent, needed for every refresh. */
export type PlanCredential = OAuthCredential & { readonly clientId: string; readonly scope: string };

/** The shape `importChatGPTCredential` accepts (the paste-back login script's output). */
export type CredentialImport = {
  readonly clientId: string;
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly scope: string;
};

type PendingRow = { verifier: string; state: string; authorize_url: string };
type SettingsRow = { email: string | null; models: string; model: string };
type TokenResponse = { access_token?: unknown; refresh_token?: unknown; id_token?: unknown; scope?: unknown; expires_in?: unknown };

/** Owns the link to the user's ChatGPT plan: authorization, the stored credential, and the chosen model. */
export class ChatGPTLink {
  readonly credentials: CredentialStore;
  readonly provider: Provider;
  readonly #models: MutableModels;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly agent: UserAgent,
    private readonly applyModel: (slug: string) => Promise<void>,
  ) {
    agent.sql`CREATE TABLE IF NOT EXISTS chatgpt_host (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      host_id TEXT NOT NULL
    )`;
    agent.sql`CREATE TABLE IF NOT EXISTS chatgpt_pending (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      verifier TEXT NOT NULL,
      state TEXT NOT NULL,
      authorize_url TEXT NOT NULL
    )`;
    agent.sql`CREATE TABLE IF NOT EXISTS chatgpt_credential (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      credential TEXT NOT NULL
    )`;
    agent.sql`CREATE TABLE IF NOT EXISTS chatgpt_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      email TEXT,
      models TEXT NOT NULL,
      model TEXT NOT NULL
    )`;
    this.credentials = new SqlCredentialStore(agent);
    this.provider = chatgptProvider();
    this.#models = createModels({ credentials: this.credentials });
    this.#models.setProvider(this.provider);
  }

  view(): ChatGPTState {
    const settings = this.agent.sql<SettingsRow>`SELECT email, models, model FROM chatgpt_settings WHERE id = 1`[0];
    const hasCredential = this.agent.sql`SELECT 1 FROM chatgpt_credential WHERE id = 1`.length > 0;
    if (settings !== undefined && hasCredential) {
      return { state: "connected", email: settings.email, models: JSON.parse(settings.models) as string[], model: settings.model };
    }
    const pending = this.#pending();
    return pending === undefined ? { state: "disconnected" } : { state: "connecting", authorizeUrl: pending.authorize_url };
  }

  /** The applied model slug, or null when no plan is connected. */
  model(): string | null {
    const view = this.view();
    return view.state === "connected" ? view.model : null;
  }

  begin(): Promise<Outcome<{ authorizeUrl: string }>> {
    return this.#serial(async () => {
      if (this.view().state === "connected") return { ok: false, error: "ChatGPT is already connected. Disconnect it first." };
      const verifier = randomToken();
      const state = randomToken();
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: DYNAMIC_CLIENT_ID,
        agent_name_hint: AGENT_NAME,
        ext_agent_host_id: `urn:uuid:${this.#hostId()}`,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
        scope: SCOPE,
        state,
        code_challenge: toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))),
        code_challenge_method: "S256",
        nonce: randomToken(),
      }).toString();
      const authorizeUrl = url.toString();
      this.agent.sql`INSERT OR REPLACE INTO chatgpt_pending (id, verifier, state, authorize_url)
        VALUES (1, ${verifier}, ${state}, ${authorizeUrl})`;
      return { ok: true, value: { authorizeUrl } };
    });
  }

  complete(callbackUrl: string): Promise<Outcome<null>> {
    return this.#serial(async () => {
      const pending = this.#pending();
      if (pending === undefined) return { ok: false, error: "Start connecting ChatGPT first." };
      let callback: URL;
      try {
        callback = new URL(callbackUrl.trim());
      } catch {
        return { ok: false, error: "Paste the full address of the tab that failed to load." };
      }
      if (`${callback.origin}${callback.pathname}` !== REDIRECT_URI) {
        return { ok: false, error: `That address should start with ${REDIRECT_URI}.` };
      }
      const error = callback.searchParams.get("error");
      if (error !== null) {
        const description = callback.searchParams.get("error_description");
        return { ok: false, error: `ChatGPT sign-in failed: ${description ?? error}` };
      }
      if (callback.searchParams.get("state") !== pending.state) {
        return { ok: false, error: "This address belongs to a different sign-in attempt. Open the latest sign-in link." };
      }
      const code = callback.searchParams.get("code");
      const clientId = callback.searchParams.get("client_id");
      if (!code || !clientId) return { ok: false, error: "The address is missing the code or client_id parameter." };

      let token: TokenResponse;
      try {
        token = await requestToken(
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            code,
            code_verifier: pending.verifier,
            redirect_uri: REDIRECT_URI,
            resource: RESOURCE,
          }),
          AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        );
      } catch (cause) {
        return { ok: false, error: messageOf(cause) };
      }
      const credential = credentialFrom(token, clientId, null);
      if (!credential.ok) return credential;
      return this.#establish(credential.value, emailFrom(token.id_token));
    });
  }

  import(input: unknown): Promise<Outcome<null>> {
    return this.#serial(async () => {
      const parsed = parseImport(input);
      if (!parsed.ok) return parsed;
      const { clientId, access, refresh, expires, scope } = parsed.value;
      return this.#establish({ type: "oauth", clientId, access, refresh, expires, scope }, null);
    });
  }

  disconnect(): Promise<Outcome<null>> {
    return this.#serial(async () => {
      await this.credentials.delete(CHATGPT_PROVIDER);
      this.agent.sql`DELETE FROM chatgpt_settings`;
      this.agent.sql`DELETE FROM chatgpt_pending`;
      return { ok: true, value: null };
    });
  }

  setModel(slug: string): Promise<Outcome<null>> {
    return this.#serial(async () => {
      const view = this.view();
      if (view.state !== "connected") return { ok: false, error: "Connect your ChatGPT plan first." };
      if (!view.models.includes(slug)) return { ok: false, error: `Your ChatGPT plan does not offer ${slug}.` };
      this.agent.sql`UPDATE chatgpt_settings SET model = ${slug}`;
      await this.applyModel(slug);
      return { ok: true, value: null };
    });
  }

  /**
   * Stores the credential, then lists models through pi's auth resolution so an expiring token refreshes
   * under the store lock. A credential that may have been rotated is kept even when listing fails: its
   * predecessor is already invalid.
   */
  async #establish(credential: PlanCredential, email: string | null): Promise<Outcome<null>> {
    await this.credentials.modify(CHATGPT_PROVIDER, async () => credential);
    let models: string[];
    try {
      models = await this.#listModels();
    } catch (cause) {
      return { ok: false, error: `Could not list your ChatGPT plan's models: ${messageOf(cause)}` };
    }
    if (models.length === 0) {
      await this.credentials.delete(CHATGPT_PROVIDER);
      return { ok: false, error: "Your ChatGPT plan offers no model this app can run." };
    }
    const model = models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models[0];
    this.agent.sql`INSERT OR REPLACE INTO chatgpt_settings (id, email, models, model)
      VALUES (1, ${email}, ${JSON.stringify(models)}, ${model})`;
    this.agent.sql`DELETE FROM chatgpt_pending`;
    await this.applyModel(model);
    return { ok: true, value: null };
  }

  async #listModels(): Promise<string[]> {
    const auth = await this.#models.getAuth(CHATGPT_PROVIDER);
    const apiKey = auth?.auth.apiKey;
    if (apiKey === undefined) throw new Error("No ChatGPT credential is stored");
    const response = await fetch(`${RESOURCE}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GET /v1/models answered ${response.status}`);
    const body = (await response.json()) as { models?: { slug?: unknown }[] };
    const slugs = (body.models ?? []).flatMap((entry) => (typeof entry.slug === "string" ? [entry.slug] : []));
    return [...new Set(slugs)].filter((slug) => SUPPORTED_MODELS.has(slug));
  }

  #hostId(): string {
    const row = this.agent.sql<{ host_id: string }>`SELECT host_id FROM chatgpt_host WHERE id = 1`[0];
    if (row !== undefined) return row.host_id;
    const hostId = crypto.randomUUID();
    this.agent.sql`INSERT INTO chatgpt_host (id, host_id) VALUES (1, ${hostId})`;
    return hostId;
  }

  #pending(): PendingRow | undefined {
    return this.agent.sql<PendingRow>`SELECT verifier, state, authorize_url FROM chatgpt_pending WHERE id = 1`[0];
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(task);
    this.#chain = run.catch(() => undefined);
    return run;
  }
}

/**
 * One credential, for `CHATGPT_PROVIDER`. Writes run one at a time so concurrent model calls refresh a
 * rotating refresh token once, and the replacement is persisted before the next write reads it.
 */
class SqlCredentialStore implements CredentialStore {
  #chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly agent: UserAgent) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return providerId === CHATGPT_PROVIDER ? this.#get() : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return this.#get() === undefined ? [] : [{ providerId: CHATGPT_PROVIDER, type: "oauth" }];
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: { signal?: AbortSignal },
  ): Promise<Credential | undefined> {
    return this.#serial(async () => {
      options?.signal?.throwIfAborted();
      if (providerId !== CHATGPT_PROVIDER) throw new Error(`No credential storage for provider ${providerId}`);
      const current = this.#get();
      const next = await fn(current);
      if (next === undefined) return current;
      this.agent.sql`INSERT OR REPLACE INTO chatgpt_credential (id, credential) VALUES (1, ${JSON.stringify(next)})`;
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.#serial(async () => {
      if (providerId === CHATGPT_PROVIDER) this.agent.sql`DELETE FROM chatgpt_credential`;
    });
  }

  #get(): Credential | undefined {
    const row = this.agent.sql<{ credential: string }>`SELECT credential FROM chatgpt_credential WHERE id = 1`[0];
    return row === undefined ? undefined : (JSON.parse(row.credential) as Credential);
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(task);
    this.#chain = run.catch(() => undefined);
    return run;
  }
}

function chatgptProvider(): Provider {
  const oauth: OAuthAuth = {
    name: "ChatGPT plan",
    isSubscription: true,
    async login() {
      throw new Error("Connect ChatGPT from the app");
    },
    async refresh(credential, signal) {
      const { clientId, scope } = credential as PlanCredential;
      const token = await requestToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: credential.refresh,
          resource: RESOURCE,
        }),
        signal,
      );
      const next = credentialFrom(token, clientId, scope);
      if (!next.ok) throw new Error(next.error);
      return next.value;
    },
    async toAuth(credential) {
      return { apiKey: credential.access };
    },
  };
  return createProvider({
    id: CHATGPT_PROVIDER,
    name: "ChatGPT plan",
    baseUrl: RESOURCE,
    auth: { oauth },
    models: Object.values(OPENAI_MODELS),
    api: openAIResponsesApi(),
  });
}

/** Error text carries the status and OAuth error code only; token endpoint bodies are never echoed. */
async function requestToken(body: URLSearchParams, signal: AbortSignal): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });
  const data = (await response.json().catch(() => null)) as (TokenResponse & { error?: unknown }) | null;
  if (!response.ok) {
    const code = typeof data?.error === "string" ? `: ${data.error}` : "";
    throw new Error(`OpenAI token request failed (${response.status}${code})`);
  }
  if (data === null || typeof data !== "object") throw new Error("OpenAI token response is not JSON");
  return data;
}

/** A refresh may omit `scope`; the grant keeps the scope it had. */
function credentialFrom(token: TokenResponse, clientId: string, previousScope: string | null): Outcome<PlanCredential> {
  const { access_token: access, refresh_token: refresh, expires_in: expiresIn } = token;
  const scope = typeof token.scope === "string" ? token.scope : previousScope;
  if (typeof access !== "string" || access.length === 0) return { ok: false, error: "OpenAI returned no access token." };
  if (typeof refresh !== "string" || refresh.length === 0) return { ok: false, error: "OpenAI returned no refresh token." };
  if (typeof expiresIn !== "number" || !(expiresIn > 0)) return { ok: false, error: "OpenAI returned no token lifetime." };
  if (scope === null || !scope.split(/\s+/).includes(DIRECT_SCOPE)) {
    return { ok: false, error: `The grant is missing ${DIRECT_SCOPE}; approve plan usage when signing in.` };
  }
  return { ok: true, value: { type: "oauth", clientId, access, refresh, expires: Date.now() + expiresIn * 1000, scope } };
}

function parseImport(input: unknown): Outcome<CredentialImport> {
  if (typeof input !== "object" || input === null) return { ok: false, error: "Expected a credential object." };
  const { clientId, access, refresh, expires, scope } = input as Record<string, unknown>;
  for (const [name, value] of Object.entries({ clientId, access, refresh, scope })) {
    if (typeof value !== "string" || value.length === 0) return { ok: false, error: `Credential field ${name} must be a non-empty string.` };
  }
  if (typeof expires !== "number" || !Number.isFinite(expires)) return { ok: false, error: "Credential field expires must be a number." };
  if (!(scope as string).split(/\s+/).includes(DIRECT_SCOPE)) return { ok: false, error: `Credential scope is missing ${DIRECT_SCOPE}.` };
  return { ok: true, value: input as CredentialImport };
}

/** Display only: the ID token arrives straight from the token endpoint over TLS, so it is not verified. */
function emailFrom(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(idToken.split(".")[1] ?? ""))) as { email?: unknown };
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

function randomToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}
