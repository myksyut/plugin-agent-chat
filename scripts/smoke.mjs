// End-to-end smoke against a running dev server (AUTH_MODE=dev).
//   node scripts/smoke.mjs                 fresh run: registers plugins, chats, checks secrets
//   node scripts/smoke.mjs --after-restart  run after restarting the dev server: checks persistence
import { AgentClient } from "agents/client";

const host = process.env.HOST ?? "127.0.0.1:5173";
const afterRestart = process.argv.includes("--after-restart");
const SECRET_HEADER = "SMOKE-SECRET-VALUE-9f3c";
const SECRET_QUERY = "SMOKEQUERY4411";
const SKILL_CODE = "OKAPI-7731";

const checks = [];
function check(ok, label, detail) {
  checks.push({ ok, label });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${!ok && detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  if (!ok) process.exitCode = 1;
}

function waitFor(predicate, label, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const value = predicate();
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${label}`));
      }
    }, 100);
  });
}

const meResponse = await fetch(`http://${host}/api/me`);
check(meResponse.ok, "GET /api/me answers", meResponse.status);
const me = await meResponse.json();

const forged = await fetch(`http://${host}/agents/user-agent/u-someone-else`);
check(forged.status === 403, "agent route for another user is rejected", forged.status);

const rawFrames = [];
let state;
let view = null;
const client = new AgentClient({
  host,
  protocol: "ws",
  agent: "UserAgent",
  name: me.agentName,
  onStateUpdate: (s) => (state = s),
  defaultCallTimeout: 60_000,
});
client.addEventListener("message", (event) => {
  const text = typeof event.data === "string" ? event.data : "";
  rawFrames.push(text);
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  if (message?.t === "chat.tail") {
    if (message.from === 0 || (view && view.session === message.session && message.from <= view.turns.length)) {
      view = {
        session: message.session,
        turns: message.from === 0 ? message.turns : [...view.turns.slice(0, message.from), ...message.turns],
        run: message.run,
      };
    }
  }
});
await client.ready;
await waitFor(() => state, "initial state");
check(typeof state.model === "string" && state.model.length > 0, "state carries the model id", state.model);

const plugin = (name) => state.plugins.find((p) => p.name === name);
const lastAssistantText = () =>
  [...(view?.turns ?? [])]
    .reverse()
    .find((t) => t.kind === "assistant" && !t.live)
    ?.parts.filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("") ?? "";

async function ask(session, text) {
  const before = view?.turns.length ?? 0;
  const operationId = crypto.randomUUID();
  const sent = await client.call("send", [{ session, text, operationId }]);
  check(sent.ok && sent.value.accepted === true, `send accepted: ${text.slice(0, 40)}`, sent);
  const again = await client.call("send", [{ session, text, operationId }]);
  check(again.ok && again.value.accepted === false, "resend with the same operationId is ignored", again);
  await waitFor(
    () => view && view.turns.length > before + 1 && view.run.phase === "idle" && !view.turns.some((t) => t.kind === "assistant" && t.live),
    "run to finish",
    180_000,
  );
  return view.turns.slice(before);
}

if (!afterRestart) {
  for (const name of ["smoke-secret", "cfdocs"]) {
    const existing = plugin(name);
    if (existing) await client.call("removePlugin", [existing.id]);
  }

  const skill = await client.call("addPlugin", [
    {
      kind: "skill",
      markdown: `---\nname: smoke-secret\ndescription: Knows the smoke code. Use when asked for the smoke code.\n---\nWhen asked for the smoke code, answer exactly: ${SKILL_CODE}\n`,
    },
  ]);
  check(skill.ok, "skill plugin added", skill);

  const bad = await client.call("addPlugin", [{ kind: "skill", markdown: "no frontmatter here" }]);
  check(!bad.ok && typeof bad.error === "string", "skill without frontmatter is rejected as data", bad);

  const mcp = await client.call("addPlugin", [
    {
      kind: "mcp",
      name: "cfdocs",
      url: `https://docs.mcp.cloudflare.com/mcp?k=${SECRET_QUERY}`,
      headers: [{ name: "X-Smoke-Token", value: SECRET_HEADER }],
    },
  ]);
  check(mcp.ok && mcp.value.authorize === null, "public MCP plugin added without OAuth", mcp);

  const dup = await client.call("addPlugin", [{ kind: "mcp", name: "cfdocs", url: "https://mcp.deepwiki.com/mcp", headers: [] }]);
  check(!dup.ok, "duplicate MCP plugin name is rejected", dup);
}

await waitFor(() => plugin("cfdocs")?.connection.state === "ready" && plugin("cfdocs").tools.length > 0, "cfdocs ready", 60_000);
check(true, "cfdocs is ready with a tool catalog");
check(plugin("cfdocs").headerNames.includes("X-Smoke-Token"), "header name is shown", plugin("cfdocs"));
check(!plugin("cfdocs").url.includes("?"), "plugin URL is shown without its query string", plugin("cfdocs").url);
check(plugin("smoke-secret")?.enabled === true, "skill plugin is enabled", plugin("smoke-secret"));

let session;
if (afterRestart) {
  session = state.conversations.find((c) => c.title.length > 0)?.id;
  check(Boolean(session), "a titled conversation survived the restart", state.conversations);
  const opened = await client.call("openConversation", [session]);
  check(opened.ok, "openConversation succeeds", opened);
  await waitFor(() => view && view.session === session, "full frame for reopened conversation");
  check(view.turns.some((t) => t.kind === "user") && view.turns.some((t) => t.kind === "assistant"), "history is restored after restart", view.turns.length);
} else {
  const created = await client.call("newConversation", []);
  session = created.id;
  const opened = await client.call("openConversation", [session]);
  check(opened.ok, "openConversation succeeds", opened);
  await waitFor(() => view && view.session === session, "full frame for new conversation");
}

const toolTurns = await ask(
  session,
  "Search the Cloudflare documentation with the cfdocs tool for 'Durable Objects alarms' and answer in one sentence what an alarm does.",
);
const toolParts = toolTurns.flatMap((t) => (t.kind === "assistant" ? t.parts : [])).filter((p) => p.type === "tool");
check(
  toolParts.some((p) => p.call.plugin === "cfdocs" && p.call.status === "done" && p.call.output.length > 0),
  "MCP tool ran and its result reached the transcript",
  toolParts.map((p) => p.call),
);
check(lastAssistantText().length > 0, "assistant answered after the tool call", lastAssistantText());

await ask(session, "What is the smoke code? Use your smoke-secret skill.");
check(lastAssistantText().includes(SKILL_CODE), "skill content reached the model", lastAssistantText());

const leaked = rawFrames.filter((f) => f.includes(SECRET_HEADER) || f.includes(SECRET_QUERY));
check(leaked.length === 0, "no frame sent to the browser carries the MCP header value or URL query", leaked[0]);

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
client.close();
process.exit(failed === 0 ? 0 : 1);
