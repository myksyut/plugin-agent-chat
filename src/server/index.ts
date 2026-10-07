// The Worker: identity and routing only.
import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import type { Me } from "../shared/protocol";
import { resolveIdentity, type Identity } from "./identity";

export { UserAgent } from "./agent";

type AppEnv = { Bindings: Env; Variables: { identity: Identity } };
const app = new Hono<AppEnv>();

app.use("/api/*", async (c, next) => {
  const identity = await resolveIdentity(c.req.raw, c.env);
  if (identity === null) return c.json({ error: "unauthenticated" }, 401);
  c.set("identity", identity);
  await next();
});

app.get("/api/me", (c) => {
  const identity = c.get("identity");
  return c.json({ agentName: identity.agentName, email: identity.email } satisfies Me);
});

/**
 * Guards WebSocket upgrades, HTTP RPC, and the SDK's MCP OAuth callback
 * (/agents/user-agent/<name>/callback). A browser Origin must be this host, which blocks
 * cross-site WebSocket hijacking with the Access cookie; the recomputed identity must own the name.
 * Hosts are compared without the scheme because a TLS-terminating proxy (vite dev over https)
 * hands the Worker an http:// URL.
 */
async function guard(request: Request, route: { readonly name: string }, env: Env): Promise<Response | undefined> {
  const origin = request.headers.get("Origin");
  const originHost = origin !== null && URL.canParse(origin) ? new URL(origin).host : null;
  if (origin !== null && originHost !== new URL(request.url).host) return new Response("Forbidden", { status: 403 });
  const identity = await resolveIdentity(request, env);
  if (identity === null) return new Response("Unauthenticated", { status: 401 });
  if (identity.agentName !== route.name) return new Response("Forbidden", { status: 403 });
  return undefined;
}

app.all("/agents/*", async (c) => {
  const response = await routeAgentRequest(c.req.raw, c.env, {
    onBeforeConnect: (request, route) => guard(request, route, c.env),
    onBeforeRequest: (request, route) => guard(request, route, c.env),
  });
  return response ?? c.notFound();
});

export default app;
