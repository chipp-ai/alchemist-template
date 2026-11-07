/**
 * The client IP, for rate-limit keys.
 *
 * On the Chipp platform every request reaches the app through Cloudflare,
 * which sets `cf-connecting-ip` and never forwards a client's own value.
 * Never key a limit on the first `X-Forwarded-For` entry or on a cookie:
 * the caller writes both.
 *
 * Null when the header is missing or malformed (local dev, a test, a
 * request that did not come through the edge). A caller decides what null
 * means: one shared bucket for a public form, or no per-IP limit at all
 * where a shared bucket would let one visitor lock everyone out.
 */

/** Reads one request header (Hono's `c.req` fits). */
export interface ClientIpRequest {
  header(name: string): string | undefined;
}

export function clientIp(req: ClientIpRequest): string | null {
  const ip = (req.header("cf-connecting-ip") ?? "").trim();
  return /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : null;
}
