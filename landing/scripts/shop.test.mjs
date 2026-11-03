// The shop library (src/lib/shop.ts): route generation, JSON-LD, the buy
// action and the path checks. The full builds are in site-migration.test.mjs.
// Run with: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blogTermsProblems, catalogProblems, PRODUCT_ENQUIRY_FORM } from "../src/lib/composed.ts";
import {
  buyAction,
  categoryProducts,
  formatPrice,
  hasShop,
  productLd,
  productPrice,
  shopPathProblems,
  shopRoutes,
  termHref,
  termPosts,
  withoutProductLd,
} from "../src/lib/shop.ts";

function product(over = {}) {
  return {
    id: "301",
    slug: "silver-band-ring",
    path: "/product/silver-band-ring/",
    title: "Silver band ring",
    sku: "RING-001",
    price: "120.00",
    regularPrice: "150.00",
    salePrice: "120.00",
    currency: "USD",
    onSale: true,
    inStock: true,
    shortDescription: "A 4 mm band in recycled sterling silver.",
    html: "<p>Brushed by hand.</p>",
    images: ["https://build.chipp.ai/a.jpg", "/b.jpg"],
    categories: ["rings"],
    tags: ["silver"],
    vendor: null,
    variants: [],
    attributes: [{ name: "Ring size", values: ["6", "7"] }],
    ...over,
  };
}

function catalog(over = {}) {
  return {
    indexPath: "/shop/",
    currency: "USD",
    categories: [
      { id: "21", slug: "rings", name: "Rings", path: "/product-category/rings", parentSlug: null, description: null, image: null, productCount: 1 },
      { id: "22", slug: "sale", name: "Sale", path: null, parentSlug: null, description: null, image: null, productCount: null, productIds: ["302"] },
    ],
    items: [product(), product({ id: "302", slug: "gift-card", path: "/product/gift-card", title: "Gift card", categories: [], onSale: false, inStock: null })],
    ...over,
  };
}

const TERMS = {
  categories: [{ slug: "care", name: "Jewelry care", path: "/category/care", count: 1 }, { slug: "draft", name: "No page", path: null, count: 0 }],
  tags: [{ slug: "silver", name: "Silver", path: "/tag/silver/", count: 1 }],
};

test("routes: the shop list, every product, every category with a path, every blog term with a path", () => {
  const routes = shopRoutes(catalog(), TERMS);
  assert.deepEqual(routes.map((r) => [r.kind, r.path]), [
    ["shop", "/shop/"],
    ["product", "/product/silver-band-ring/"],
    ["product", "/product/gift-card/"],
    ["category", "/product-category/rings/"],
    ["term", "/category/care/"],
    ["term", "/tag/silver/"],
  ]);
  const gift = routes.find((r) => r.kind === "product" && r.product.slug === "gift-card");
  assert.equal(gift.product.path, "/product/gift-card/", "paths are normalized on the route's own record");
  assert.equal(shopRoutes(catalog({ indexPath: null }), null)[0].path, "/shop/", "the shop list defaults to /shop/");
  assert.equal(shopRoutes(catalog({ indexPath: "/collections/all" }), null)[0].path, "/collections/all/");
});

test("routes: no products.json, an empty one, or one with no products builds no shop route", () => {
  for (const c of [null, undefined, catalog({ items: [] }), catalog({ items: [], categories: [] })]) {
    assert.equal(hasShop(c), false);
    assert.deepEqual(shopRoutes(c, null), []);
  }
  assert.deepEqual(shopRoutes(null, { categories: [], tags: [] }), []);
  assert.deepEqual(shopRoutes(null, TERMS).map((r) => r.kind), ["term", "term"], "blog terms do not need a shop");
});

test("path checks: a shop route that is also a page, post or another shop route fails", () => {
  assert.deepEqual(shopPathProblems(catalog(), TERMS, ["/", "/about/"]), []);
  assert.deepEqual(shopPathProblems(catalog(), null, ["/shop"]), ["src/content/products.json: path /shop/ is also a page or post (the shop list)"]);
  assert.deepEqual(shopPathProblems(catalog({ indexPath: "/product/gift-card/" }), null, []), [
    'src/content/products.json: path /product/gift-card/ is also the shop list (product "gift-card")',
  ]);
  assert.deepEqual(shopPathProblems(null, TERMS, ["/category/care/"]), [
    'src/content/blog-terms.json: path /category/care/ is also a page or post (blog category "care")',
  ]);
});

test("category membership: by the product's category slugs or the category's productIds", () => {
  const c = catalog();
  assert.deepEqual(categoryProducts(c, c.categories[0]).map((p) => p.slug), ["silver-band-ring"]);
  assert.deepEqual(categoryProducts(c, c.categories[1]).map((p) => p.slug), ["gift-card"]);
});

test("prices: the store currency, and the old price only when on sale", () => {
  assert.equal(formatPrice("120.00", "USD"), "$120.00");
  assert.equal(formatPrice("3500", "EUR"), "€3,500.00");
  assert.equal(formatPrice("12.5", "NOPE"), "12.5 NOPE");
  assert.equal(formatPrice("12.5", null), "12.5");
  assert.equal(formatPrice(null, "USD"), null);
  assert.deepEqual(productPrice(product()), { current: "$120.00", was: "$150.00" });
  assert.deepEqual(productPrice(product({ onSale: false, regularPrice: "120.00", salePrice: null })), { current: "$120.00", was: null });
  assert.deepEqual(productPrice(product({ currency: null }), "GBP"), { current: "£120.00", was: "£150.00" });
});

test("buy action: a buyUrl links to that store, else the enquiry form on the page", () => {
  assert.deepEqual(buyAction(product()), { kind: "enquire", href: "#form-product-enquiry", label: "Ask about this product" });
  assert.equal(`#form-${PRODUCT_ENQUIRY_FORM.name}`, "#form-product-enquiry", "the link targets the form section's id");
  assert.deepEqual(buyAction(product({ buyUrl: "https://www.etsy.com/listing/1" })), { kind: "store", href: "https://www.etsy.com/listing/1", label: "Buy on etsy.com" });
  assert.equal(buyAction(product({ buyUrl: "javascript:alert(1)" })).kind, "enquire");
  assert.deepEqual(PRODUCT_ENQUIRY_FORM.fields.filter((f) => f.required).map((f) => f.name), ["product", "name", "email"]);
});

test("JSON-LD: a dated ItemPage, then a Product with an Offer from the same values", () => {
  const ld = productLd(product(), catalog(), { siteUrl: "https://jewelry.example.com/", siteName: "Fixture Jewelry", published: "2026-01-02", updated: "2026-10-01" });
  const [page, item, org] = ld["@graph"];
  assert.equal(ld["@context"], "https://schema.org");
  assert.deepEqual(page, {
    "@type": "ItemPage",
    name: "Silver band ring",
    datePublished: "2026-01-02",
    dateModified: "2026-10-01",
    mainEntity: { "@id": "#product" },
    publisher: { "@id": "#organization" },
    url: "https://jewelry.example.com/product/silver-band-ring/",
  });
  assert.deepEqual(item, {
    "@type": "Product",
    "@id": "#product",
    name: "Silver band ring",
    description: "A 4 mm band in recycled sterling silver.",
    sku: "RING-001",
    image: ["https://build.chipp.ai/a.jpg", "https://jewelry.example.com/b.jpg"],
    url: "https://jewelry.example.com/product/silver-band-ring/",
    category: "Rings",
    offers: {
      "@type": "Offer",
      price: "120.00",
      priceCurrency: "USD",
      seller: { "@id": "#organization" },
      availability: "https://schema.org/InStock",
      url: "https://jewelry.example.com/product/silver-band-ring/",
    },
  });
  assert.deepEqual(org, { "@type": "Organization", "@id": "#organization", name: "Fixture Jewelry", url: "https://jewelry.example.com/" });
});

test("JSON-LD: out of stock, unknown stock, no price, variant price ranges, no site url", () => {
  const opts = { siteName: "S", published: "2026-01-01", updated: "2026-01-01" };
  const out = productLd(product({ inStock: false }), catalog(), opts)["@graph"][1];
  assert.equal(out.offers.availability, "https://schema.org/OutOfStock");
  assert.equal(out.url, undefined, "no absolute URL without site.json url");
  assert.equal(out.offers.url, undefined);
  assert.equal(productLd(product({ inStock: null }), catalog(), opts)["@graph"][1].offers.availability, undefined);
  assert.equal(productLd(product({ price: null, salePrice: null, regularPrice: null }), catalog(), opts)["@graph"][1].offers, undefined);
  assert.equal(productLd(product({ currency: null }), catalog({ currency: null }), opts)["@graph"][1].offers, undefined, "a price without a currency is no Offer");
  const ranged = productLd(product({
    variants: [
      { id: "1", title: "Small", sku: null, price: "10.00", available: true },
      { id: "2", title: "Large", sku: null, price: "25.00", available: true },
    ],
  }), catalog(), opts)["@graph"][1];
  assert.deepEqual(ranged.offers, { "@type": "AggregateOffer", priceCurrency: "USD", lowPrice: "10", highPrice: "25", offerCount: 2, availability: "https://schema.org/InStock" });
  const brand = productLd(product({ vendor: "Acme", shortDescription: null, seo: { description: "From the SEO." } }), catalog(), opts)["@graph"][1];
  assert.deepEqual(brand.brand, { "@type": "Brand", name: "Acme" });
  assert.equal(brand.description, "From the SEO.");
});

test("carried JSON-LD loses its Product nodes: the page prints its own", () => {
  assert.deepEqual(
    withoutProductLd([{ "@type": "Product", name: "old" }, { "@graph": [{ "@type": "Product" }, { "@type": "BreadcrumbList" }] }, { "@type": "Organization" }]),
    [{ "@graph": [{ "@type": "BreadcrumbList" }] }, { "@type": "Organization" }],
  );
});

test("blog terms: posts by term name or slug, and the archive link for a post's term", () => {
  const posts = [
    { path: "/a/", title: "A", date: "2026-03-01", html: "", categories: ["Jewelry care"], tags: ["silver"] },
    { path: "/b/", title: "B", date: "2026-01-01", html: "", categories: ["Studio news"] },
  ];
  assert.deepEqual(termPosts(posts, TERMS.categories[0], "category").map((p) => p.path), ["/a/"]);
  assert.deepEqual(termPosts(posts, TERMS.tags[0], "tag").map((p) => p.path), ["/a/"]);
  assert.deepEqual(termPosts(posts, TERMS.tags[0], "category"), []);
  assert.equal(termHref(TERMS, "category", "Jewelry care"), "/category/care/");
  assert.equal(termHref(TERMS, "tag", "SILVER"), "/tag/silver/");
  assert.equal(termHref(TERMS, "category", "No page"), null);
  assert.equal(termHref(null, "category", "Jewelry care"), null);
});

test("validation: buyUrl, the shop index and blog terms", () => {
  assert.deepEqual(catalogProblems(catalog()), []);
  assert.deepEqual(catalogProblems(catalog({ items: [product({ buyUrl: "ftp://x" })] })), [
    "src/content/products.json items[0].buyUrl: an http or https URL, or null",
  ]);
  assert.deepEqual(catalogProblems(catalog({ indexPath: "/" })), ['src/content/products.json indexPath: the shop list cannot be "/"']);
  assert.deepEqual(catalogProblems(catalog({ index: { title: 7 } })), ["src/content/products.json index.title: text"]);
  assert.deepEqual(blogTermsProblems(TERMS), []);
  assert.deepEqual(blogTermsProblems({ categories: [{ slug: "x", name: "X", path: "/x.html" }] }), [
    'src/content/blog-terms.json categories[0]: "path" /x.html looks like a file; use a clean path and add a redirect from the old URL',
  ]);
});
