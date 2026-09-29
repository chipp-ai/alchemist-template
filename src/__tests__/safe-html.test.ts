import { assertEquals } from "@std/assert";
import { escapeHtml, sanitizeHref } from "@/lib/safe-html.ts";
import { escapeHtml as emailEscapeHtml } from "@/services/email.ts";

Deno.test("escapeHtml: escapes the five HTML metacharacters", () => {
  assertEquals(
    escapeHtml(`<a href="x" title='y'>&</a>`),
    "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
  );
});

Deno.test("escapeHtml: the email facade re-exports the same function", () => {
  assertEquals(emailEscapeHtml, escapeHtml);
});

Deno.test("sanitizeHref: keeps safe links", () => {
  for (
    const href of [
      "https://example.com/a?b=1",
      "http://example.com",
      "/pricing",
      "#contact",
      "mailto:hi@example.com",
      "tel:+1 (555) 010-0000",
    ]
  ) {
    assertEquals(sanitizeHref(href), href);
  }
  assertEquals(sanitizeHref("  /x  "), "/x");
});

Deno.test("sanitizeHref: rejects unsafe or malformed links", () => {
  for (
    const href of [
      "javascript:alert(1)",
      " JAVASCRIPT:alert(1)",
      "data:text/html,x",
      "vbscript:x",
      "//evil.example",
      "/\\evil.example",
      "java\nscript:x",
      "",
      "not a url",
      "ftp://example.com",
    ]
  ) {
    assertEquals(sanitizeHref(href), null, href);
  }
  assertEquals(sanitizeHref(null), null);
  assertEquals(sanitizeHref(undefined), null);
});
