// Pure MCP → pi adaptation. Holds no SDK objects: the caller supplies an McpCall.
import type { TSchema } from "@earendil-works/pi-ai";
import type { Extension, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";

export type JsonSchemaObject = { readonly [key: string]: unknown };

/** Shape of what `this.mcp.listTools()` yields (structural). */
export type RawMcpTool = {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: JsonSchemaObject;
};

export type McpToolSpec = {
  /** Original MCP tool name, sent to callTool. */
  readonly name: string;
  /** Model-facing: `<pluginId>__<sanitized>`, [A-Za-z0-9_-], at most 64, collision-suffixed. */
  readonly modelName: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
};

export type McpCatalog = {
  readonly instructions: string | null;
  readonly tools: readonly McpToolSpec[];
  /** Hash of tools + instructions; equal fingerprint means the installed extension is current. */
  readonly fingerprint: string;
};

/** The MCP content blocks this adapter maps; everything else is passed on as JSON text. */
export type McpContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  | { readonly type: "resource"; readonly resource: { readonly text?: string } }
  | { readonly type: "audio" | "resource_link" };

export type RawMcpResult = {
  readonly content?: readonly McpContentBlock[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
};

/** A controlled tool error the model can reason about: server not ready, or the call failed. */
export type McpFailure = { readonly failure: string };

/** Calls one tool on one server; the caller guards the connection state. */
export type McpCall = (
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
) => Promise<RawMcpResult | McpFailure>;

const MAX_TOOL_NAME = 64;
const PERMISSIVE_SCHEMA: JsonSchemaObject = { type: "object", additionalProperties: true };

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function catalogFrom(
  pluginId: string,
  tools: readonly RawMcpTool[],
  instructions: string | null,
): Promise<McpCatalog> {
  const taken = new Set<string>();
  const specs = tools.map((tool): McpToolSpec => {
    const base = `${pluginId}__${tool.name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    let modelName = base.slice(0, MAX_TOOL_NAME);
    for (let n = 2; taken.has(modelName); n++) {
      const suffix = `_${n}`;
      modelName = base.slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
    }
    taken.add(modelName);
    return {
      name: tool.name,
      modelName,
      description: tool.description ?? tool.title ?? tool.name,
      inputSchema: sanitizeSchema(tool.inputSchema),
    };
  });
  const fingerprint = await sha256Hex(JSON.stringify({ instructions, tools: specs }));
  return { instructions, tools: specs, fingerprint };
}

/**
 * The schema goes verbatim to the model provider and to pi's validator, which throws on
 * unresolvable `$ref`s and would then reject every call; such schemas become permissive.
 */
function sanitizeSchema(schema: JsonSchemaObject): JsonSchemaObject {
  if (schema.type !== "object") return PERMISSIVE_SCHEMA;
  const { $schema: _schema, $id: _id, ...rest } = schema;
  return refsResolve(rest, rest) ? rest : PERMISSIVE_SCHEMA;
}

function refsResolve(node: unknown, root: JsonSchemaObject): boolean {
  if (typeof node !== "object" || node === null) return true;
  if (Array.isArray(node)) return node.every((item) => refsResolve(item, root));
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && (typeof value !== "string" || !pointerResolves(root, value))) return false;
    if (!refsResolve(value, root)) return false;
  }
  return true;
}

function pointerResolves(root: JsonSchemaObject, ref: string): boolean {
  if (ref === "#") return true;
  if (!ref.startsWith("#/")) return false;
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const segment = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, segment)) return false;
    node = (node as JsonSchemaObject)[segment];
  }
  return true;
}

/**
 * Extension `mcp.<id>`: one tool per catalog entry, plus a tagged `mcp-<id>` section carrying
 * the server's instructions. Replay stays "unsafe": server annotations are not trusted.
 */
export function mcpExtension(
  plugin: { readonly id: string; readonly name: string },
  catalog: McpCatalog,
  call: McpCall,
): Extension<ToolRegistration> {
  const tools = catalog.tools.map(
    (spec): ToolRegistration => ({
      name: spec.modelName,
      description: spec.description,
      parameters: spec.inputSchema as unknown as TSchema,
      replay: "unsafe",
      async execute(args, _api, context) {
        return toPiResult(await call(spec.name, (args ?? {}) as Record<string, unknown>, context.abortSignal));
      },
    }),
  );
  const instructions = catalog.instructions?.trim();
  const sections = instructions
    ? [{ key: `mcp-${plugin.id}`, render: () => `Instructions from the MCP server "${plugin.name}":\n${instructions}` }]
    : [];
  return { name: mcpExtensionName(plugin.id), tools, sections };
}

export function mcpExtensionName(pluginId: string): string {
  return `mcp.${pluginId}`;
}

type PiContent = NonNullable<ToolExecutionResult["content"]>[number];

export function toPiResult(result: RawMcpResult | McpFailure): ToolExecutionResult {
  if ("failure" in result) {
    return { isError: true, content: [{ type: "text", text: result.failure }] };
  }
  const content = (result.content ?? []).map((block): PiContent => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "image":
        return { type: "image", data: block.data, mimeType: block.mimeType };
      case "resource":
        return { type: "text", text: block.resource.text ?? JSON.stringify(block) };
      default:
        return { type: "text", text: JSON.stringify(block) };
    }
  });
  // Many servers mirror structuredContent as text; it is only the result when there is no content.
  if (content.length === 0 && result.structuredContent !== undefined) {
    content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
  }
  if (content.length === 0) content.push({ type: "text", text: "(empty result)" });
  return { isError: result.isError === true, content };
}
