// Everything about plugins: our table, the SDK MCP calls, the catalog cache, and the
// reconciler that projects enabled plugins into the pi registry.
import type { Extension, Registry, ToolRegistration } from "@earendil-works/pi-durable";
import { getCurrentAgent, normalizeServerId, type MCPServersState } from "agents";
import type { Added, McpConnection, Outcome, PluginDraft, PluginView, SkillOrigin } from "../../shared/protocol";
import type { UserAgent } from "../agent";
import { catalogFrom, mcpExtension, mcpExtensionName, type McpCall, type McpCatalog, type RawMcpResult } from "./mcp-tools";
import {
  fetchSkillMarkdown,
  parseSkillDoc,
  SKILLS_EXTENSION,
  skillsExtension,
  skillsFingerprint,
  type SkillDoc,
} from "./skill-md";

/** Header values are not here: they live only in the SDK's cf_agents_mcp_servers row with the same id. */
export type McpSpec = {
  /** origin + pathname */
  readonly url: string;
  readonly headerNames: readonly string[];
};
export type SkillSpec = { readonly doc: SkillDoc; readonly origin: SkillOrigin };

export type PluginRecord =
  | {
      readonly kind: "mcp";
      readonly id: string;
      readonly name: string;
      readonly enabled: boolean;
      readonly spec: McpSpec;
      readonly catalog: McpCatalog | null;
    }
  | {
      readonly kind: "skill";
      readonly id: string;
      readonly name: string;
      readonly enabled: boolean;
      readonly spec: SkillSpec;
    };

type McpRecord = Extract<PluginRecord, { kind: "mcp" }>;

type PluginRow = {
  id: string;
  kind: string;
  name: string;
  enabled: number;
  spec: string;
  catalog: string | null;
};

export type DesiredExtension = {
  readonly fingerprint: string;
  build(): Promise<Extension<ToolRegistration>> | Extension<ToolRegistration>;
};
export type Desired = ReadonlyMap<string, DesiredExtension>;
type Installed = Map<string, { fingerprint: string; ext: Extension<ToolRegistration> }>;
type ToolLabel = { readonly plugin: string | null; readonly tool: string };

const PLUGIN_ID = /^[a-z][a-z0-9_-]{0,40}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TOOL_WAIT_MS = 5000;

export class PluginBook {
  #installed: Installed = new Map();
  #labels = new Map<string, ToolLabel>();
  #chain: Promise<unknown> = Promise.resolve();
  #queuedReconcile: Promise<void> | null = null;

  constructor(
    private readonly agent: UserAgent,
    /** The SDK's real MCP state; the agent's own getMcpServers() is blanked for the browser. */
    private readonly serverStates: () => MCPServersState,
  ) {}

  /** Factory path, input gate held: SQL → registry from cached catalogs. No network. */
  async installAll(): Promise<void> {
    this.agent.sql`CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('mcp', 'skill')),
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      spec TEXT NOT NULL,
      catalog TEXT,
      created_at INTEGER NOT NULL
    )`;
    this.agent.sql`CREATE UNIQUE INDEX IF NOT EXISTS plugins_kind_name ON plugins (kind, name)`;
    await this.#apply(this.#rows());
  }

  /**
   * After the harness is open: SDK servers without a row are removed, mcp rows without an SDK
   * server are deleted. Finishes adds and removes a crash interrupted.
   */
  sweep(): Promise<void> {
    return this.#serial(async () => {
      const rows = new Set(this.#rows().flatMap((row) => (row.kind === "mcp" ? [row.id] : [])));
      const servers = new Set(this.agent.mcp.listServers().map((server) => server.id));
      for (const id of servers) if (!rows.has(id)) await this.agent.removeMcpServer(id);
      for (const id of rows) if (!servers.has(id)) this.agent.sql`DELETE FROM plugins WHERE id = ${id}`;
      await this.#reconcileNow();
    });
  }

  /** Coalesced: at most one reconcile waits behind the running mutation. */
  reconcile(): Promise<void> {
    this.#queuedReconcile ??= this.#serial(async () => {
      this.#queuedReconcile = null;
      await this.#reconcileNow();
    });
    return this.#queuedReconcile;
  }

  add(draft: PluginDraft): Promise<Outcome<Added>> {
    switch (draft.kind) {
      case "mcp": {
        const callbackHost = currentOrigin();
        return this.#serial(() => this.#addMcp(draft, callbackHost));
      }
      case "skill":
        return this.#serial(() => this.#addSkill(draft.markdown, { type: "pasted" }));
      case "skill-url":
        return this.#serial(async () => {
          const fetched = await fetchSkillMarkdown(draft.url);
          if (!fetched.ok) return fetched;
          return this.#addSkill(fetched.value, { type: "url", url: draft.url, fetchedAt: Date.now() });
        });
    }
  }

  /** Flips the flag only; MCP connections stay warm. Effective from the next pi request. */
  setEnabled(id: string, enabled: boolean): Promise<Outcome<null>> {
    return this.#serial(async () => {
      if (!this.#row(id)) return { ok: false, error: `No plugin with id ${id}` };
      this.agent.sql`UPDATE plugins SET enabled = ${enabled ? 1 : 0} WHERE id = ${id}`;
      await this.#reconcileNow();
      return { ok: true, value: null };
    });
  }

  /** SDK first, then our row: a crash in between leaves a row the sweep deletes. */
  remove(id: string): Promise<Outcome<null>> {
    return this.#serial(async () => {
      const row = this.#row(id);
      if (!row) return { ok: false, error: `No plugin with id ${id}` };
      if (row.kind === "mcp" && this.agent.mcp.listServers().some((server) => server.id === id)) {
        try {
          await this.agent.removeMcpServer(id);
        } catch (error) {
          return { ok: false, error: `Could not disconnect ${row.name}: ${messageOf(error)}` };
        }
      }
      this.agent.sql`DELETE FROM plugins WHERE id = ${id}`;
      await this.#reconcileNow();
      return { ok: true, value: null };
    });
  }

  /** skill-url: re-fetch. mcp: reconnect, rediscover, or hand out a fresh authorize URL. */
  refresh(id: string): Promise<Outcome<Added>> {
    const callbackHost = currentOrigin();
    return this.#serial(async () => {
      const row = this.#row(id);
      if (!row) return { ok: false, error: `No plugin with id ${id}` };
      const outcome = row.kind === "mcp" ? await this.#refreshMcp(row, callbackHost) : await this.#refreshSkill(row);
      await this.#reconcileNow();
      return outcome;
    });
  }

  views(): PluginView[] {
    const servers = this.serverStates().servers;
    return this.#rows().map((row): PluginView => {
      if (row.kind === "skill") {
        const { doc, origin } = row.spec;
        return {
          kind: "skill",
          id: row.id,
          name: row.name,
          description: doc.description,
          enabled: row.enabled,
          origin,
          hiddenFromModel: doc.hiddenFromModel,
        };
      }
      const server = servers[row.id];
      let connection: McpConnection;
      switch (server?.state) {
        case undefined:
          connection = { state: "failed", error: "Not registered with the MCP client" };
          break;
        case "ready":
          connection = { state: "ready" };
          break;
        case "authenticating":
          connection = { state: "authenticating", authUrl: server.auth_url };
          break;
        case "failed":
          connection = { state: "failed", error: scrubUrl(server.error ?? "Connection failed", server.server_url) };
          break;
        default:
          connection = { state: "connecting" };
      }
      return {
        kind: "mcp",
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        url: row.spec.url,
        headerNames: row.spec.headerNames,
        connection,
        tools: (row.catalog?.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description })),
      };
    });
  }

  /** Model-facing tool name → display labels; built-in tools such as activate_skill have no plugin. */
  labelTool(modelName: string): ToolLabel {
    return this.#labels.get(modelName) ?? { plugin: null, tool: modelName };
  }

  async #addMcp(draft: Extract<PluginDraft, { kind: "mcp" }>, callbackHost: string | undefined): Promise<Outcome<Added>> {
    const name = draft.name.trim();
    if (name.length === 0 || name.length > 64 || /[\u0000-\u001f]/.test(name)) {
      return { ok: false, error: "Name must be 1 to 64 printable characters" };
    }
    let url: URL;
    try {
      url = new URL(draft.url.trim());
    } catch {
      return { ok: false, error: "Not a valid URL" };
    }
    if (!(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)))) {
      return { ok: false, error: "MCP servers must use https (http only on localhost)" };
    }
    if (url.username || url.password) return { ok: false, error: "Put credentials in a header, not in the URL" };
    const headers: Record<string, string> = {};
    for (const header of draft.headers) {
      const headerName = header.name.trim();
      if (!HEADER_NAME.test(headerName)) return { ok: false, error: `Invalid header name: ${headerName}` };
      if (header.value.length === 0 || /[\r\n\0]/.test(header.value)) {
        return { ok: false, error: `Header ${headerName} needs a single-line value` };
      }
      if (Object.keys(headers).some((key) => key.toLowerCase() === headerName.toLowerCase())) {
        return { ok: false, error: `Header ${headerName} is given twice` };
      }
      headers[headerName] = header.value;
    }
    const rows = this.#rows();
    if (rows.some((row) => row.kind === "mcp" && row.name === name)) {
      return { ok: false, error: `An MCP server named ${name} already exists` };
    }
    const id = this.#freeId(name, rows);

    let authorize: string | null;
    try {
      const result = await this.agent.addMcpServer(name, url.href, {
        id,
        ...(callbackHost === undefined ? {} : { callbackHost }),
        transport: { type: "auto", ...(Object.keys(headers).length === 0 ? {} : { headers }) },
      });
      authorize = result.state === "authenticating" ? result.authUrl : null;
    } catch (error) {
      await this.agent.removeMcpServer(id).catch(() => undefined);
      return { ok: false, error: scrubUrl(messageOf(error), url.href) };
    }
    const spec: McpSpec = { url: `${url.origin}${url.pathname}`, headerNames: Object.keys(headers) };
    this.agent.sql`INSERT INTO plugins (id, kind, name, enabled, spec, catalog, created_at)
      VALUES (${id}, 'mcp', ${name}, 1, ${JSON.stringify(spec)}, NULL, ${Date.now()})`;
    await this.#reconcileNow();
    return { ok: true, value: { id, authorize } };
  }

  async #addSkill(markdown: string, origin: SkillOrigin): Promise<Outcome<Added>> {
    const parsed = parseSkillDoc(markdown);
    if (!parsed.ok) return parsed;
    const doc = parsed.value;
    const rows = this.#rows();
    if (rows.some((row) => row.kind === "skill" && row.name === doc.name)) {
      return { ok: false, error: `A skill named ${doc.name} already exists` };
    }
    const id = this.#freeId(doc.name, rows);
    const spec: SkillSpec = { doc, origin };
    this.agent.sql`INSERT INTO plugins (id, kind, name, enabled, spec, catalog, created_at)
      VALUES (${id}, 'skill', ${doc.name}, 1, ${JSON.stringify(spec)}, NULL, ${Date.now()})`;
    await this.#reconcileNow();
    return { ok: true, value: { id, authorize: null } };
  }

  async #refreshSkill(row: Extract<PluginRecord, { kind: "skill" }>): Promise<Outcome<Added>> {
    const origin = row.spec.origin;
    if (origin.type !== "url") return { ok: true, value: { id: row.id, authorize: null } };
    const fetched = await fetchSkillMarkdown(origin.url);
    if (!fetched.ok) return fetched;
    const parsed = parseSkillDoc(fetched.value);
    if (!parsed.ok) return parsed;
    if (parsed.value.name !== row.name) {
      return { ok: false, error: `The skill at this URL is now named ${parsed.value.name}; add it as a new plugin` };
    }
    const spec: SkillSpec = { doc: parsed.value, origin: { ...origin, fetchedAt: Date.now() } };
    this.agent.sql`UPDATE plugins SET spec = ${JSON.stringify(spec)} WHERE id = ${row.id}`;
    return { ok: true, value: { id: row.id, authorize: null } };
  }

  async #refreshMcp(row: McpRecord, callbackHost: string | undefined): Promise<Outcome<Added>> {
    const server = this.agent.mcp.listServers().find((candidate) => candidate.id === row.id);
    if (!server) return { ok: false, error: `${row.name} is not registered; remove and add it again` };
    const state = this.agent.mcp.mcpConnections[row.id]?.connectionState;
    try {
      if (state === "ready") {
        await this.agent.mcp.discoverIfConnected(row.id);
        return { ok: true, value: { id: row.id, authorize: null } };
      }
      if (state === "authenticating") {
        const again = await this.agent.addMcpServer(row.name, server.server_url, {
          id: row.id,
          ...(callbackHost === undefined ? {} : { callbackHost }),
        });
        return { ok: true, value: { id: row.id, authorize: again.state === "authenticating" ? again.authUrl : null } };
      }
      const connected = await this.agent.mcp.connectToServer(row.id);
      if (connected.state === "authenticating") {
        return { ok: true, value: { id: row.id, authorize: connected.authUrl } };
      }
      if (connected.state === "failed") return { ok: false, error: scrubUrl(connected.error, server.server_url) };
      await this.agent.mcp.discoverIfConnected(row.id);
      return { ok: true, value: { id: row.id, authorize: null } };
    } catch (error) {
      return { ok: false, error: scrubUrl(messageOf(error), server.server_url) };
    }
  }

  /** Refresh catalogs of ready servers (written only when the fingerprint changed), apply, publish. */
  async #reconcileNow(): Promise<void> {
    const servers = this.serverStates().servers;
    const rows: PluginRecord[] = [];
    for (const row of this.#rows()) {
      const server = row.kind === "mcp" ? servers[row.id] : undefined;
      if (row.kind !== "mcp" || server?.state !== "ready") {
        rows.push(row);
        continue;
      }
      const catalog = await catalogFrom(row.id, this.agent.mcp.listTools({ serverId: row.id }), server.instructions);
      if (catalog.fingerprint !== row.catalog?.fingerprint) {
        this.agent.sql`UPDATE plugins SET catalog = ${JSON.stringify(catalog)} WHERE id = ${row.id}`;
      }
      rows.push({ ...row, catalog });
    }
    await this.#apply(rows);
    this.agent.publish();
  }

  async #apply(rows: readonly PluginRecord[]): Promise<void> {
    const labels = new Map<string, ToolLabel>();
    for (const row of rows) {
      if (row.kind !== "mcp") continue;
      for (const tool of row.catalog?.tools ?? []) labels.set(tool.modelName, { plugin: row.name, tool: tool.name });
    }
    this.#labels = labels;
    await applyDiff(this.agent.registry, this.#installed, await desired(rows, (row) => this.#mcpCall(row)));
  }

  #mcpCall(row: McpRecord): McpCall {
    return async (toolName, args, signal) => {
      const mcp = this.agent.mcp;
      if (mcp.mcpConnections[row.id]?.connectionState !== "ready") await mcp.waitForConnections({ timeout: TOOL_WAIT_MS });
      const state = mcp.mcpConnections[row.id]?.connectionState;
      if (state !== "ready") return { failure: `MCP server ${row.name} is ${state ?? "not connected"}` };
      try {
        return (await mcp.callTool({ serverId: row.id, name: toolName, arguments: args }, { signal })) as RawMcpResult;
      } catch (error) {
        if (signal?.aborted) throw error;
        return { failure: `MCP server ${row.name} failed to run ${toolName}: ${messageOf(error)}` };
      }
    };
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(task);
    this.#chain = run.catch(() => undefined);
    return run;
  }

  #row(id: string): PluginRecord | undefined {
    return this.#rows().find((row) => row.id === id);
  }

  #rows(): PluginRecord[] {
    const rows = this.agent.sql<PluginRow>`SELECT id, kind, name, enabled, spec, catalog FROM plugins ORDER BY created_at, id`;
    return rows.map((row): PluginRecord => {
      const base = { id: row.id, name: row.name, enabled: row.enabled === 1 };
      return row.kind === "mcp"
        ? {
            ...base,
            kind: "mcp",
            spec: JSON.parse(row.spec) as McpSpec,
            catalog: row.catalog === null ? null : (JSON.parse(row.catalog) as McpCatalog),
          }
        : { ...base, kind: "skill", spec: JSON.parse(row.spec) as SkillSpec };
    });
  }

  /** The id doubles as the SDK server id and the `mcp-<id>` section key, so it must stay a plain slug. */
  #freeId(name: string, rows: readonly PluginRecord[]): string {
    const taken = new Set([...rows.map((row) => row.id), ...this.agent.mcp.listServers().map((server) => server.id)]);
    const base = normalizeServerId(name).slice(0, 41).replace(/[-_]+$/, "");
    let id = PLUGIN_ID.test(base) ? base : "plugin";
    for (let n = 2; taken.has(id); n++) {
      const suffix = `-${n}`;
      id = `${base.slice(0, 41 - suffix.length).replace(/[-_]+$/, "")}${suffix}`;
    }
    return id;
  }
}

/** Enabled rows → extensions: `mcp.<id>` per server with a catalog, one `agents.skills` for all skills. */
export async function desired(rows: readonly PluginRecord[], callFor: (row: McpRecord) => McpCall): Promise<Desired> {
  const want = new Map<string, DesiredExtension>();
  const skills: SkillDoc[] = [];
  for (const row of rows) {
    if (!row.enabled) continue;
    if (row.kind === "skill") {
      skills.push(row.spec.doc);
      continue;
    }
    const catalog = row.catalog;
    if (catalog === null) continue;
    want.set(mcpExtensionName(row.id), {
      fingerprint: catalog.fingerprint,
      build: () => mcpExtension(row, catalog, callFor(row)),
    });
  }
  if (skills.length > 0) {
    want.set(SKILLS_EXTENSION, { fingerprint: await skillsFingerprint(skills), build: () => skillsExtension(skills) });
  }
  return want;
}

/** Same-name install replaces in place; identical fingerprints are skipped so pi records no tool churn. */
export async function applyDiff(registry: Registry<ToolRegistration>, installed: Installed, want: Desired): Promise<void> {
  for (const [name, { fingerprint, build }] of want) {
    if (installed.get(name)?.fingerprint === fingerprint) continue;
    const ext = await build();
    registry.install(ext);
    installed.set(name, { fingerprint, ext });
  }
  for (const [name, { ext }] of installed) {
    if (want.has(name)) continue;
    registry.uninstall(ext);
    installed.delete(name);
  }
}

function currentOrigin(): string | undefined {
  const { request, connection } = getCurrentAgent();
  const uri = request?.url ?? connection?.uri;
  return uri ? new URL(uri).origin : undefined;
}

/** SDK errors quote the server URL; its query string may carry a key and must not reach the browser. */
function scrubUrl(text: string, rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return text;
  }
  const display = `${url.origin}${url.pathname}`;
  let scrubbed = text.split(rawUrl).join(display).split(url.href).join(display);
  if (url.search.length > 1) scrubbed = scrubbed.split(url.search.slice(1)).join("…");
  return scrubbed;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
