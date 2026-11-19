/**
 * Build-side half of campaigns (lib/campaigns.ts): a campaign's page is the
 * base page with the campaign's words in the hero, its own <title> and
 * description, `noindex`, and a canonical link to the base page. The
 * server, not the browser, picks the variant (src/lib/landing-site.ts).
 */
import type { Campaign } from "./campaigns";
import type { ComposedPage, HeroSection, PageSeo, Section } from "./composed";

/** The SEO of a campaign page: never indexed, canonical to the base page. */
export function campaignSeo(campaign: Campaign, base: PageSeo | undefined, basePath: string): PageSeo {
  return {
    ...(base ?? {}),
    title: campaign.title ?? base?.title,
    description: campaign.description ?? base?.description,
    canonical: base?.canonical?.trim() || basePath,
    noindex: true,
  };
}

function patchHero(hero: HeroSection, campaign: Campaign): HeroSection {
  const h = campaign.hero;
  const actions = [...(hero.actions ?? [])];
  if (h.cta) {
    if (actions.length > 0) actions[0] = { ...actions[0], label: h.cta.label, href: h.cta.href };
    else actions.push({ label: h.cta.label, href: h.cta.href });
  }
  return {
    ...hero,
    eyebrow: h.eyebrow ?? hero.eyebrow,
    heading: h.headline ?? hero.heading,
    subhead: h.subhead ?? hero.subhead,
    actions,
  };
}

/** A composed page with the campaign applied to its first hero section. */
export function campaignComposedPage(page: ComposedPage, campaign: Campaign): ComposedPage {
  let done = false;
  const sections = page.sections.map((s: Section) => {
    if (done || s.type !== "hero") return s;
    done = true;
    return patchHero(s, campaign);
  });
  return {
    ...page,
    title: campaign.title ?? page.title,
    sections,
    seo: campaignSeo(campaign, page.seo, page.path),
  };
}
