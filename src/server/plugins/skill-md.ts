// SKILL.md parsing and fetching, and the `agents.skills` extension built from the enabled skills.
import type { Extension } from "@earendil-works/pi-durable";
import { skills } from "agents/harness/pi";
import { fromManifest, parseSkillMarkdown, type SkillManifestEntry } from "agents/skills";
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

export function parseSkillDoc(markdown: string): Outcome<SkillDoc> {
  if (new TextEncoder().encode(markdown).byteLength > MAX_SKILL_BYTES) {
    return { ok: false, error: `SKILL.md is larger than ${MAX_SKILL_BYTES / 1024} KB` };
  }
  const parsed = parseSkillMarkdown(markdown);
  if (parsed === null) {
    return { ok: false, error: "SKILL.md needs YAML frontmatter with a name and a description" };
  }
  const name = parsed.name.trim();
  if (name.length === 0 || name.length > 64 || /[\r\n]/.test(name)) {
    return { ok: false, error: "Skill name must be 1 to 64 characters on one line" };
  }
  return {
    ok: true,
    value: {
      ...parsed,
      name,
      markdown,
      hiddenFromModel: parsed.metadata?.["disable-model-invocation"] === true,
    },
  };
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

export async function skillsExtension(docs: readonly SkillDoc[]): Promise<Extension> {
  const entries = docs.map(
    (doc): SkillManifestEntry => ({
      name: doc.name,
      description: doc.description,
      body: doc.body,
      rawContent: doc.markdown,
      ...(doc.compatibility === undefined ? {} : { compatibility: doc.compatibility }),
      ...(doc.license === undefined ? {} : { license: doc.license }),
      ...(doc.allowedTools === undefined ? {} : { allowedTools: doc.allowedTools }),
      ...(doc.metadata === undefined ? {} : { metadata: { ...doc.metadata } }),
    }),
  );
  const source = fromManifest({ id: "user-skills", fingerprint: await skillsFingerprint(docs), skills: entries });
  return skills([source]);
}
