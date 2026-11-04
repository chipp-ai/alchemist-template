/**
 * One-click unsubscribe (RFC 8058). PUBLIC: the signed token is the
 * credential, the same trust basis as a portal claim link.
 *
 *   POST /api/unsubscribe/:token   the unsubscribe. What a mail client's
 *                                  "Unsubscribe" button sends
 *                                  (body `List-Unsubscribe=One-Click`), and
 *                                  what the page below submits.
 *   GET  /api/unsubscribe/:token   a page with one button that POSTs. A GET
 *                                  NEVER unsubscribes: link scanners and
 *                                  mail-client prefetchers open every link
 *                                  in a message, and a GET that acted would
 *                                  unsubscribe people who never clicked.
 *
 * The token is minted by `unsubscribeUrl()` / the transport's
 * List-Unsubscribe header (src/services/mailing/unsubscribe-token.ts).
 * What the POST changes: suppression.service.ts `unsubscribe()`.
 */

import { Hono } from "hono";
import { BRAND } from "@/config/brand.ts";
import { escapeHtml } from "@/lib/safe-html.ts";
import { appPath } from "@/config/site.ts";
import { log } from "@/lib/logger.ts";
import { unsubscribe, verifyUnsubscribeToken } from "@/services/mailing/index.ts";

const unsubscribeRoutes = new Hono();

function page(title: string, body: string): string {
  const name = escapeHtml(BRAND.name);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
    `<meta name="robots" content="noindex">` +
    `<title>${escapeHtml(title)} - ${name}</title>` +
    `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;` +
    `line-height:1.5}button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;cursor:pointer}</style>` +
    `</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

const INVALID = page(
  "This link does not work",
  "<p>This unsubscribe link is incomplete or was changed. Use the link in the most recent " +
    "email you received, or reply to that email and ask to be removed.</p>",
);

unsubscribeRoutes.get("/:token", (c) => {
  const target = verifyUnsubscribeToken(c.req.param("token"));
  if (!target) return c.html(INVALID, 404);
  const action = escapeHtml(c.req.path);
  return c.html(page(
    "Unsubscribe",
    `<p>Stop emails from ${escapeHtml(BRAND.name)} to <strong>${
      escapeHtml(target.email)
    }</strong>?</p>` +
      `<form method="post" action="${action}">` +
      `<input type="hidden" name="List-Unsubscribe" value="One-Click">` +
      `<button type="submit" data-testid="unsubscribe-btn-confirm">Unsubscribe</button></form>` +
      `<p><small>Sign-in codes are still sent when you ask for one.</small></p>`,
  ));
});

unsubscribeRoutes.post("/:token", async (c) => {
  const target = verifyUnsubscribeToken(c.req.param("token"));
  if (!target) return c.html(INVALID, 404);
  try {
    await unsubscribe(target);
  } catch (err) {
    log.error(
      "One-click unsubscribe failed",
      { source: "mailing", feature: "unsubscribe" },
      err as Error,
    );
    return c.html(
      page(
        "Something went wrong",
        "<p>We could not record that just now. Please try again in a minute.</p>",
      ),
      500,
    );
  }
  return c.html(page(
    "You are unsubscribed",
    `<p>${escapeHtml(target.email)} will not get these emails from ${
      escapeHtml(BRAND.name)
    } any more.</p>` +
      `<p><small>Have an account? You can change this in <a href="${
        escapeHtml(appPath("/#/settings?tab=notifications"))
      }">your notification settings</a>.</small></p>`,
  ));
});

export { unsubscribeRoutes };
