// ============================================================================
// Marketplace registry — adapters as interfaces with mock implementations.
// The operator is marketplace-agnostic; it routes by item, not by default.
// Real adapters (Facebook Marketplace/OfferUp/eBay) can be added behind this interface
// later without touching the UI or the operator brain.
// ============================================================================

import type { ListingDraft } from "@/lib/types";

export interface ListingResult {
  channelId: string;
  externalId: string;
  url: string;
  status: "live" | "pending" | "rejected";
}

export interface MarketplaceAdapter {
  id: string;
  name: string;
  kind: "shipping" | "local" | "collector" | "generalist";
  feePct: number;
  shippingFriendly: boolean;
  blurb: string;
  /** Category keywords this channel is strong for. */
  strengths: string[];
  supportsCategory(category: string): boolean;
  createListing(draft: ListingDraft): Promise<ListingResult>;
}

function mockAdapter(
  cfg: Omit<MarketplaceAdapter, "supportsCategory" | "createListing">
): MarketplaceAdapter {
  return {
    ...cfg,
    supportsCategory(category: string) {
      const c = category.toLowerCase();
      return cfg.strengths.some((s) => c.includes(s) || s.includes(c));
    },
    async createListing(draft: ListingDraft): Promise<ListingResult> {
      // Mock: pretend we posted. Real adapter would call the channel API.
      return {
        channelId: cfg.id,
        externalId: `${cfg.id}_${Math.random().toString(36).slice(2, 9)}`,
        url: `/market/listing`,
        status: "live",
      };
    },
  };
}

export const ADAPTERS: Record<string, MarketplaceAdapter> = {
  "cashfromchaos-sandbox": mockAdapter({
    id: "cashfromchaos-sandbox",
    name: "CashFromChaos Sandbox",
    kind: "generalist",
    feePct: 0,
    shippingFriendly: true,
    blurb: "Internal demo marketplace where the fake buyer browses and pays.",
    strengths: ["", "general", "electronics", "music", "collectibles", "furniture", "kids"],
  }),
  "facebook-marketplace-mock": mockAdapter({
    id: "facebook-marketplace-mock",
    name: "Facebook Marketplace · Local (mock)",
    kind: "local",
    feePct: 0,
    shippingFriendly: false,
    blurb:
      "The primary channel: huge local buyer pool, zero fees on local pickup, fast turnover for almost every category.",
    strengths: [
      "general", "electronics", "music", "collectibles", "furniture",
      "home", "kids", "bulky", "appliance",
    ],
  }),
  "offerup-mock": mockAdapter({
    id: "offerup-mock",
    name: "OfferUp (mock)",
    kind: "local",
    feePct: 0,
    shippingFriendly: false,
    blurb: "Local-first mobile marketplace; strong second local channel after Facebook.",
    strengths: ["electronics", "general", "kids", "home", "furniture"],
  }),
  "craigslist-mock": mockAdapter({
    id: "craigslist-mock",
    name: "Craigslist (mock)",
    kind: "local",
    feePct: 0,
    shippingFriendly: false,
    blurb: "Classic local classifieds; still strong for furniture, appliances and bulky items.",
    strengths: ["furniture", "home", "bulky", "appliance"],
  }),
  "tcgplayer-mock": mockAdapter({
    id: "tcgplayer-mock",
    name: "TCGplayer-style Collector Channel (mock)",
    kind: "collector",
    feePct: 10,
    shippingFriendly: true,
    blurb: "Specialist collector demand for trading cards; better prices than local generalists.",
    strengths: ["collectibles", "trading cards", "pokemon", "tcg", "cards"],
  }),
  "reverb-mock": mockAdapter({
    id: "reverb-mock",
    name: "Reverb (mock)",
    kind: "shipping",
    feePct: 5,
    shippingFriendly: true,
    blurb: "Buyers specifically hunting instruments & music electronics.",
    strengths: ["music", "instrument", "guitar", "pedal", "audio", "electronics"],
  }),
  "mercari-mock": mockAdapter({
    id: "mercari-mock",
    name: "Mercari (mock)",
    kind: "shipping",
    feePct: 10,
    shippingFriendly: true,
    blurb: "Easy shipping-first generalist; good for small items worth mailing.",
    strengths: ["electronics", "general", "kids", "collectibles", "home"],
  }),
  "ebay-mock": mockAdapter({
    id: "ebay-mock",
    name: "eBay (mock)",
    kind: "shipping",
    feePct: 13,
    shippingFriendly: true,
    blurb: "National/global reach fallback for rare or niche items.",
    strengths: ["electronics", "collectibles", "music", "rare"],
  }),
};

export function getAdapter(id: string): MarketplaceAdapter | undefined {
  return ADAPTERS[id];
}

export function allAdapters(): MarketplaceAdapter[] {
  return Object.values(ADAPTERS);
}
