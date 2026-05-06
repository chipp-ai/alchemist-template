/**
 * Realtime / WebSocket routes
 *
 * One endpoint:
 *   GET /api/realtime/ws?token=<wsToken>
 *
 * The handshake authenticates via a short-lived JWT issued by
 * GET /api/auth/ws-token (see src/api/middleware/auth.ts → createWsToken).
 * Cookies don't reliably travel on cross-origin WS, and many WS client
 * libraries can't attach Cookie headers at all, so the standard pattern
 * is "fetch a short-lived token from REST, pass it in the URL or
 * subprotocol on the handshake."
 *
 * On open the server sends a `hello` envelope so the client can
 * confirm identity. Subsequent text frames are echoed back with the
 * sender's user id — a baseline customer apps can replace with their
 * own dispatch (chat, presence, live cursors, …) while keeping the
 * auth + connection lifecycle intact.
 */

import { Hono } from "hono";
import { verifyWsToken } from "@/api/middleware/auth.ts";
import { log } from "@/lib/logger.ts";

const realtimeRoutes = new Hono();

realtimeRoutes.get("/ws", async (c) => {
  // The handshake comes in as an HTTP GET with `Upgrade: websocket`.
  // Token is a query param so it's reachable from any WS client; the
  // 60s TTL bounds the URL-leak risk.
  const token = c.req.query("token");
  if (!token) {
    return c.json(
      { error: "Missing `token` query param", code: "WS_TOKEN_MISSING" },
      401,
    );
  }

  const payload = await verifyWsToken(token);
  if (!payload) {
    return c.json(
      { error: "Invalid or expired WS token", code: "WS_TOKEN_INVALID" },
      401,
    );
  }

  const userId = payload.sub as string;
  const organizationId = payload.organizationId as string;

  // Deno.upgradeWebSocket throws if the request isn't actually an
  // Upgrade request. Surface a 426 so curl users see a clear "use a
  // WebSocket client" message rather than a 500.
  let upgrade: { socket: WebSocket; response: Response };
  try {
    upgrade = Deno.upgradeWebSocket(c.req.raw);
  } catch (err) {
    log.warn("WS upgrade rejected (not a WebSocket request)", {
      source: "realtime",
      feature: "ws-upgrade-failed",
      userId,
    }, err as Error);
    return c.json(
      { error: "This endpoint requires a WebSocket upgrade", code: "WS_UPGRADE_REQUIRED" },
      426,
    );
  }

  const { socket, response } = upgrade;
  const connectionId = crypto.randomUUID();

  socket.onopen = () => {
    log.info("WS connected", {
      source: "realtime",
      feature: "ws-connect",
      userId,
      organizationId,
      connectionId,
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        userId,
        organizationId,
        connectionId,
      }),
    );
  };

  socket.onmessage = (event) => {
    // Baseline echo. Customers replace this branch with their own
    // dispatch (chat broadcast, presence pub/sub, live cursor merge).
    const data = typeof event.data === "string" ? event.data : "<binary>";
    socket.send(
      JSON.stringify({
        type: "echo",
        userId,
        connectionId,
        received: data,
      }),
    );
  };

  socket.onclose = (event) => {
    log.info("WS disconnected", {
      source: "realtime",
      feature: "ws-disconnect",
      userId,
      connectionId,
      code: event.code,
      reason: event.reason || null,
    });
  };

  socket.onerror = (event) => {
    log.warn(
      "WS socket error",
      {
        source: "realtime",
        feature: "ws-error",
        userId,
        connectionId,
      },
      event instanceof ErrorEvent ? event.error : new Error("WS error"),
    );
  };

  return response;
});

export { realtimeRoutes };
