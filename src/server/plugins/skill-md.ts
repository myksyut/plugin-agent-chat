// SKILL.md parsing and fetching, and the `agents.skills` extension built from the enabled skills.
// agents/skills is used for its types only: its runtime module imports ai, zod, @cloudflare/codemode
// and just-bash, none of which are installed, so the Worker cannot bundle it.
import type { Extension } from "@earendil-works/pi-durable";
import { skills } from "agents/harness/pi";
import type { SkillContent, SkillDescriptor, SkillSource } from "agents/skills";
import type { Outcome } from "../../shared/protocol";
import { sha256Hex } from "./mcp-tools";

export type SkillDoc = {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  /** Verbatim SKILL.md, kept as rawContent. */
  readonly markdown: string;
  readonly compatibility?: string;
  readonly license?: string;
  readonly allowedTools?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** metadata["disable-model-invocation"] === true */
  readonly hiddenFromModel: boolean;
};

export const SKILLS_EXTENSION = "agents.skills";

const MAX_SKILL_BYTES = 128 * 1024;
const MAX_FETCH_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

type YamlScalar = string | number | boolean | null;
type YamlValue = YamlScalar | readonly YamlScalar[] | { readonly [key: string]: YamlValue };

/** Agent Skills rules, as agents/skills parseSkillMarkdown applies them, plus size and name limits. */
export function parseSkillDoc(markdown: string): Outcome<SkillDoc> {
  if (new TextEncoder().encode(markdown).byteLength > MAX_SKILL_BYTES) {
    return { ok: false, error: `SKILL.md is larger than ${MAX_SKILL_BYTES / 1024} KB` };
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  const data = match ? parseFrontmatter(match[1] ?? "") : {};
  const text = (key: string) => {
    const value = data[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const name = text("name");
  const description = text("description");
  if (!match || name === undefined || description === undefined) {
    return { ok: false, error: "SKILL.md needs YAML frontmatter with a name and a description" };
  }
  if (name.length > 64 || /[\r\n]/.test(name)) {
    return { ok: false, error: "Skill name must be 1 to 64 characters on one line" };
  }
  const rawMetadata = data.metadata;
  const metadata =
    typeof rawMetadata === "object" && rawMetadata !== null && !Array.isArray(rawMetadata)
      ? (rawMetadata as Readonly<Record<string, YamlValue>>)
      : undefined;
  const allowedTools = data["allowed-tools"];
  const compatibility = text("compatibility");
  const license = text("license");
  return {
    ok: true,
    value: {
      name,
      description,
      body: match[2] ?? "",
      markdown,
      ...(compatibility === undefined ? {} : { compatibility }),
      ...(license === undefined ? {} : { license }),
      ...(typeof allowedTools === "string" ? { allowedTools } : {}),
      ...(Array.isArray(allowedTools) ? { allowedTools: allowedTools.join(" ") } : {}),
      ...(metadata === undefined ? {} : { metadata }),
      hiddenFromModel: metadata?.["disable-model-invocation"] === true,
    },
  };
}

/**
 * The YAML subset SKILL.md frontmatter uses: top-level keys with plain, quoted, flow-list, or
 * block (`|`, `>`) scalars, and one level of nested mapping or `- item` list.
 */
function parseFrontmatter(source: string): Record<string, YamlValue> {
  const lines = source.split(/\r?\n/);
  const result: Record<string, YamlValue> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    i++;
    const entry = /^([^\s#][^:]*):(?:\s+(.*))?$/.exec(line);
    if (!entry) continue;
    const key = (entry[1] ?? "").trim();
    const rest = (entry[2] ?? "").trim();
    const nested: string[] = [];
    while (i < lines.length && (/^\s+\S/.test(lines[i] ?? "") || (lines[i] ?? "").trim() === "")) {
      nested.push(lines[i] ?? "");
      i++;
    }
    while (nested.length > 0 && (nested[nested.length - 1] ?? "").trim() === "") nested.pop();
    if (/^[|>][+-]?$/.test(rest)) {
      const indent = Math.min(...nested.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
      const block = nested.map((l) => l.slice(indent));
      result[key] = rest.startsWith("|") ? block.join("\n") : block.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ");
    } else if (rest === "" || rest.startsWith("#")) {
      const items = nested.map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      if (items.length > 0 && items.every((l) => l.startsWith("- "))) {
        result[key] = items.map((l) => yamlScalar(l.slice(2)));
      } else {
        const map: Record<string, YamlValue> = {};
        for (const item of items) {
          const pair = /^([^:]+):(?:\s+(.*))?$/.exec(item);
          if (pair) map[(pair[1] ?? "").trim()] = yamlScalar(pair[2] ?? "");
        }
        result[key] = map;
      }
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      result[key] = rest
        .slice(1, -1)
        .split(",")
        .map((item) => yamlScalar(item))
        .filter((item) => item !== "");
    } else {
      const continuation = nested.map((l) => l.trim()).filter(Boolean);
      result[key] = yamlScalar([rest, ...continuation].join(" "));
    }
  }
  return result;
}

function yamlScalar(raw: string): YamlScalar {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/g, "'");
  const plain = value.replace(/\s+#.*$/, "");
  if (plain === "true" || plain === "false") return plain === "true";
  if (plain === "null" || plain === "~" || plain === "") return plain === "" ? "" : null;
  if (/^-?\d+(\.\d+)?$/.test(plain)) return Number(plain);
  return plain;
}

/** https only; GitHub blob URLs are read from raw.githubusercontent.com. */
export async function fetchSkillMarkdown(url: string): Promise<Outcome<string>> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, error: "Not a valid URL" };
  }
  if (target.protocol !== "https:") return { ok: false, error: "Skill URLs must use https" };
  if (target.username || target.password) return { ok: false, error: "Skill URLs must not carry credentials" };
  const blob = target.hostname === "github.com" ? /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(target.pathname) : null;
  if (blob) target = new URL(`https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`);

  let response: Response;
  try {
    response = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    return { ok: false, error: `Could not fetch the skill: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response.ok || response.body === null) {
    return { ok: false, error: `Could not fetch the skill: HTTP ${response.status}` };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FETCH_BYTES) {
      await reader.cancel();
      return { ok: false, error: `The skill is larger than ${MAX_FETCH_BYTES / 1024} KB` };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, error: "The skill is not UTF-8 text" };
  }
}

export function skillsFingerprint(docs: readonly SkillDoc[]): Promise<string> {
  return sha256Hex(JSON.stringify(docs.map((doc) => doc.markdown)));
}

/** The `agents.skills` extension over an in-memory source, shaped like agents/skills fromManifest. */
export async function skillsExtension(docs: readonly SkillDoc[]): Promise<Extension> {
  const id = "user-skills";
  const byName = new Map(docs.map((doc) => [doc.name, doc]));
  const describe = (doc: SkillDoc): SkillDescriptor => ({
    name: doc.name,
    description: doc.description,
    sourceId: id,
    ...(doc.compatibility === undefined ? {} : { compatibility: doc.compatibility }),
    ...(doc.license === undefined ? {} : { license: doc.license }),
    ...(doc.allowedTools === undefined ? {} : { allowedTools: doc.allowedTools }),
    ...(doc.metadata === undefined ? {} : { metadata: { ...doc.metadata } }),
  });
  const source: SkillSource = {
    id,
    fingerprint: await skillsFingerprint(docs),
    list: async () => docs.map(describe),
    load: async (name): Promise<SkillContent | null> => {
      const doc = byName.get(name);
      return doc ? { ...describe(doc), body: doc.body, rawContent: doc.markdown } : null;
    },
  };
  return skills([source]);
}
