/**
 * Sanitize HTML that came from somewhere else (an old site's page body or
 * blog post) before it goes into a landing page: richText and html
 * sections, and blog post bodies.
 *
 * Kept: text structure (headings, lists, tables, quotes, code), links,
 * images, figures, and video or map embeds from a short list of hosts.
 * Removed: scripts, styles, inline event handlers, forms and inputs (use
 * the form section), and every other iframe.
 *
 * Two changes keep the AEO rules true on imported HTML:
 *   - an <h1> becomes an <h2>: the page has one H1, from its first section;
 *   - an <img> with no alt text gets alt="" and aria-hidden="true", so a
 *     screen reader skips it instead of reading the file name. Write real
 *     alt text where the old site had none and the picture carries meaning.
 */
import sanitizeHtml from "sanitize-html";

const EMBED_HOSTS = [
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "player.vimeo.com",
  "www.google.com",
  "maps.google.com",
  "w.soundcloud.com",
  "open.spotify.com",
  "calendly.com",
];

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "blockquote", "pre", "code",
    "ul", "ol", "li", "dl", "dt", "dd",
    "strong", "b", "em", "i", "u", "s", "small", "sub", "sup", "mark", "abbr", "cite", "q", "span",
    "a", "img", "figure", "figcaption", "picture", "source", "video", "audio", "iframe",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
    "div", "section", "article", "aside", "address", "time",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel", "id"],
    img: ["src", "alt", "width", "height", "loading", "decoding", "srcset", "sizes", "aria-hidden", "title"],
    source: ["src", "srcset", "type", "media", "sizes"],
    video: ["src", "controls", "poster", "width", "height", "preload", "muted", "loop", "playsinline"],
    audio: ["src", "controls", "preload"],
    iframe: ["src", "title", "width", "height", "allow", "allowfullscreen", "loading", "referrerpolicy"],
    th: ["colspan", "rowspan", "scope"],
    td: ["colspan", "rowspan"],
    time: ["datetime"],
    abbr: ["title"],
    "*": ["id"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  allowProtocolRelative: false,
  allowedIframeHostnames: EMBED_HOSTS,
  disallowedTagsMode: "discard",
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "form", "select", "button"],
  transformTags: {
    h1: "h2",
    a: (tagName, attribs) => {
      const out = { ...attribs };
      if (out.target === "_blank") out.rel = "noopener noreferrer";
      return { tagName, attribs: out };
    },
    img: (tagName, attribs) => {
      const out = { ...attribs };
      if (!out.alt || !out.alt.trim()) {
        out.alt = "";
        out["aria-hidden"] = "true";
      }
      if (!out.loading) out.loading = "lazy";
      return { tagName, attribs: out };
    },
    iframe: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, title: attribs.title?.trim() || "Embedded content", loading: "lazy" },
    }),
  },
};

/** Safe HTML for a landing page. */
export function sanitize(html: string): string {
  return sanitizeHtml(html, OPTIONS);
}
