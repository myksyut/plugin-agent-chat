// agents/skills is used for its types only: its runtime module imports ai, @cloudflare/codemode
// and just-bash, none of which are installed, so the Worker cannot bundle it.
import type { Extension } from "@earendil-works/pi-durable";
import { skills } from "agents/harness/pi";
import type { SkillContent, SkillDescriptor, SkillSource } from "agents/skills";
import { parse as parseYaml } from "yaml";
import type { Outcome } from "../../shared/protocol";
import { sha256Hex } from "./mcp-tools";

export type SkillDoc = {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly markdown: string;
  readonly compatibility?: string;
  readonly license?: string;
  readonly allowedTools?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly hiddenFromModel: boolean;
};

export const SKILLS_EXTENSION = "agents.skills";

const MAX_SKILL_BYTES = 128 * 1024;
const MAX_FETCH_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

type Frontmatter = { readonly [key: string]: unknown };

export function parseSkillDoc(markdown: string): Outcome<SkillDoc> {
  if (new TextEncoder().encode(markdown).byteLength > MAX_SKILL_BYTES) {
    return { ok: false, error: `SKILL.md is larger than ${MAX_SKILL_BYTES / 1024} KB` };
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  let data: Frontmatter = {};
  if (match) {
    try {
      const parsed: unknown = parseYaml(match[1] ?? "");
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) data = parsed as Frontmatter;
    } catch (error) {
      return { ok: false, error: `SKILL.md frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
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
      ? (rawMetadata as Readonly<Record<string, unknown>>)
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
