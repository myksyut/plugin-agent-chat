// Who is calling. The only place that knows about Cloudflare Access.

export type Identity = {
  /** DO instance name: "u-" + hex(sha256(iss + "|" + sub)).slice(0, 32). Never an email. */
  readonly agentName: string;
  readonly email: string | null;
};

export type IdentityEnv = Pick<Env, "AUTH_MODE" | "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD">;

const DEV_IDENTITY: Identity = { agentName: "u-dev", email: "dev@localhost" };

type AccessClaims = {
  readonly iss?: unknown;
  readonly sub?: unknown;
  readonly aud?: unknown;
  readonly exp?: unknown;
  readonly nbf?: unknown;
  readonly email?: unknown;
};

/** Signing keys by kid, per team domain; refetched when a token names an unknown kid. */
const jwksCache = new Map<string, Map<string, CryptoKey>>();

/**
 * access: verifies the Cf-Access-Jwt-Assertion header (or the CF_Authorization cookie):
 * RS256 against the team's JWKS, aud includes ACCESS_AUD, iss is the team, exp/nbf hold.
 * dev: the fixed local identity. Anything else, or any failure: null.
 */
export async function resolveIdentity(request: Request, env: IdentityEnv): Promise<Identity | null> {
  if (env.AUTH_MODE === "dev") return DEV_IDENTITY;
  if (env.AUTH_MODE !== "access" || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = request.headers.get("Cf-Access-Jwt-Assertion") ?? cookie(request, "CF_Authorization");
  if (!token) return null;
  try {
    const claims = await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
    if (claims === null) return null;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${claims.iss}|${claims.sub}`));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return { agentName: `u-${hex.slice(0, 32)}`, email: claims.email };
  } catch {
    return null;
  }
}

async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  audience: string,
): Promise<{ iss: string; sub: string; email: string | null } | null> {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) return null;
  const header = JSON.parse(new TextDecoder().decode(base64url(encodedHeader))) as { alg?: unknown; kid?: unknown };
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
  const issuer = `https://${teamDomain}`;
  const key = await signingKey(issuer, header.kid);
  if (key === null) return null;
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64url(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) return null;

  const claims = JSON.parse(new TextDecoder().decode(base64url(encodedPayload))) as AccessClaims;
  const now = Date.now() / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer || typeof claims.sub !== "string" || claims.sub.length === 0) return null;
  if (!audiences.includes(audience)) return null;
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) return null;
  return { iss: issuer, sub: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
}

async function signingKey(issuer: string, kid: string): Promise<CryptoKey | null> {
  const cached = jwksCache.get(issuer)?.get(kid);
  if (cached) return cached;
  const response = await fetch(`${issuer}/cdn-cgi/access/certs`);
  if (!response.ok) return null;
  const { keys } = (await response.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const imported = new Map<string, CryptoKey>();
  for (const jwk of keys ?? []) {
    if (jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
    imported.set(
      jwk.kid,
      await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
    );
  }
  jwksCache.set(issuer, imported);
  return imported.get(kid) ?? null;
}

function base64url(input: string): Uint8Array<ArrayBuffer> {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function cookie(request: Request, name: string): string | null {
  for (const pair of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}
