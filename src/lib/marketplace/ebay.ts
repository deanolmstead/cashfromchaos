// ============================================================================
// Real eBay adapter (sandbox-first) — the first channel that actually lists.
// ----------------------------------------------------------------------------
// Env-gated: without EBAY_* credentials every entry point reports "not
// configured" and the app behaves exactly as before (mock adapters only).
//
// What's implemented against eBay's APIs:
//   - OAuth user-token refresh (cached until expiry)
//   - Listing creation via the Sell Inventory API:
//       inventory item (PUT) → offer (POST) → publish (POST) → listingId
//   - Best Offer retrieval + response via the Trading API
//       (GetBestOffers / RespondToBestOffer) — the structured negotiation
//       surface that maps 1:1 onto the policy engine's accept/counter/decline.
//
// Setup (sandbox): create an eBay developer account, a sandbox keyset
// (client id + secret), mint a user refresh token with the sell.inventory
// scope, and create business policies on the sandbox seller account. See
// README → "Real eBay listing (sandbox)".
// ============================================================================

import type { ListingDraft } from "@/lib/types";
import type { ListingResult } from "@/lib/marketplace/registry";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface EbayConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  base: string; // https://api.sandbox.ebay.com or https://api.ebay.com
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
  merchantLocationKey: string;
  categoryId: string;
}

export function ebayConfig(): EbayConfig | null {
  const {
    EBAY_CLIENT_ID,
    EBAY_CLIENT_SECRET,
    EBAY_REFRESH_TOKEN,
    EBAY_ENV,
    EBAY_FULFILLMENT_POLICY_ID,
    EBAY_PAYMENT_POLICY_ID,
    EBAY_RETURN_POLICY_ID,
    EBAY_MERCHANT_LOCATION_KEY,
    EBAY_CATEGORY_ID,
  } = process.env;
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET || !EBAY_REFRESH_TOKEN) return null;
  return {
    clientId: EBAY_CLIENT_ID,
    clientSecret: EBAY_CLIENT_SECRET,
    refreshToken: EBAY_REFRESH_TOKEN,
    base:
      (EBAY_ENV ?? "sandbox").toLowerCase() === "production"
        ? "https://api.ebay.com"
        : "https://api.sandbox.ebay.com",
    fulfillmentPolicyId: EBAY_FULFILLMENT_POLICY_ID ?? "",
    paymentPolicyId: EBAY_PAYMENT_POLICY_ID ?? "",
    returnPolicyId: EBAY_RETURN_POLICY_ID ?? "",
    merchantLocationKey: EBAY_MERCHANT_LOCATION_KEY ?? "cashfromchaos",
    categoryId: EBAY_CATEGORY_ID ?? "175672", // generic "Other" fallback
  };
}

export function ebayConfigured(): boolean {
  return ebayConfig() !== null;
}

// ---------------------------------------------------------------------------
// OAuth — user access token via refresh-token grant, cached until expiry.
// ---------------------------------------------------------------------------
let tokenCache: { token: string; expiresAt: number } | null = null;

export async function getEbayAccessToken(fetchImpl: FetchLike = fetch): Promise<string> {
  const cfg = ebayConfig();
  if (!cfg) throw new Error("eBay is not configured (EBAY_* env vars missing)");
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.token;

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const res = await fetchImpl(`${cfg.base}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cfg.refreshToken,
      scope: "https://api.ebay.com/oauth/api_scope/sell.inventory",
    }).toString(),
  });
  if (!res.ok) throw new Error(`eBay token refresh failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

/** Test hook: clear the token cache. */
export function _resetTokenCache(): void {
  tokenCache = null;
}

// ---------------------------------------------------------------------------
// Listing creation — Sell Inventory API three-step flow.
// ---------------------------------------------------------------------------
export async function createEbayListing(
  draft: ListingDraft,
  opts: { sku: string; imageUrls?: string[]; bestOffer?: boolean },
  fetchImpl: FetchLike = fetch
): Promise<ListingResult> {
  const cfg = ebayConfig();
  if (!cfg) throw new Error("eBay is not configured");
  const token = await getEbayAccessToken(fetchImpl);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Content-Language": "en-US",
  };

  // 1. Inventory item (idempotent upsert by SKU)
  const invRes = await fetchImpl(
    `${cfg.base}/sell/inventory/v1/inventory_item/${encodeURIComponent(opts.sku)}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        product: {
          title: draft.title.slice(0, 80),
          description: draft.body,
          imageUrls: opts.imageUrls?.filter((u) => u.startsWith("http")).slice(0, 12),
        },
        condition: "USED_GOOD",
        availability: { shipToLocationAvailability: { quantity: 1 } },
      }),
    }
  );
  if (!invRes.ok && invRes.status !== 204) {
    throw new Error(`eBay inventory item failed: ${invRes.status} ${await invRes.text()}`);
  }

  // 2. Offer
  const offerRes = await fetchImpl(`${cfg.base}/sell/inventory/v1/offer`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      sku: opts.sku,
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
      availableQuantity: 1,
      categoryId: cfg.categoryId,
      listingDescription: draft.body,
      pricingSummary: { price: { value: draft.price.toFixed(2), currency: "USD" } },
      bestOfferTerms: { bestOfferEnabled: opts.bestOffer ?? true },
      listingPolicies: {
        fulfillmentPolicyId: cfg.fulfillmentPolicyId,
        paymentPolicyId: cfg.paymentPolicyId,
        returnPolicyId: cfg.returnPolicyId,
      },
      merchantLocationKey: cfg.merchantLocationKey,
    }),
  });
  if (!offerRes.ok) {
    throw new Error(`eBay offer failed: ${offerRes.status} ${await offerRes.text()}`);
  }
  const { offerId } = (await offerRes.json()) as { offerId: string };

  // 3. Publish
  const pubRes = await fetchImpl(`${cfg.base}/sell/inventory/v1/offer/${offerId}/publish`, {
    method: "POST",
    headers,
  });
  if (!pubRes.ok) {
    throw new Error(`eBay publish failed: ${pubRes.status} ${await pubRes.text()}`);
  }
  const { listingId } = (await pubRes.json()) as { listingId: string };

  const listingHost = cfg.base.includes("sandbox") ? "sandbox.ebay.com" : "www.ebay.com";
  return {
    channelId: "ebay",
    externalId: listingId,
    url: `https://${listingHost}/itm/${listingId}`,
    status: "live",
  };
}

// ---------------------------------------------------------------------------
// Best Offers — Trading API (XML). The buyer's structured offer surface.
// ---------------------------------------------------------------------------
export interface EbayBestOffer {
  offerId: string;
  listingId: string;
  buyerName: string;
  price: number;
  message?: string;
}

function tradingHeaders(callName: string, token: string): Record<string, string> {
  return {
    "X-EBAY-API-CALL-NAME": callName,
    "X-EBAY-API-SITEID": "0",
    "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
    "X-EBAY-API-IAF-TOKEN": token,
    "Content-Type": "text/xml",
  };
}

function xmlField(xml: string, tag: string): string | undefined {
  return xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];
}

export async function getBestOffers(
  listingId: string,
  fetchImpl: FetchLike = fetch
): Promise<EbayBestOffer[]> {
  const cfg = ebayConfig();
  if (!cfg) throw new Error("eBay is not configured");
  const token = await getEbayAccessToken(fetchImpl);
  const res = await fetchImpl(`${cfg.base}/ws/api.dll`, {
    method: "POST",
    headers: tradingHeaders("GetBestOffers", token),
    body:
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<GetBestOffersRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
      `<ItemID>${listingId}</ItemID><BestOfferStatus>Active</BestOfferStatus>` +
      `<DetailLevel>ReturnAll</DetailLevel></GetBestOffersRequest>`,
  });
  if (!res.ok) throw new Error(`GetBestOffers failed: ${res.status}`);
  const xml = await res.text();
  const offers: EbayBestOffer[] = [];
  for (const block of xml.match(/<BestOffer>[\s\S]*?<\/BestOffer>/g) ?? []) {
    const offerId = xmlField(block, "BestOfferID");
    const price = parseFloat(xmlField(block, "Price") ?? "");
    if (!offerId || !Number.isFinite(price)) continue;
    offers.push({
      offerId,
      listingId,
      buyerName: xmlField(block, "UserID") ?? "eBay buyer",
      price,
      message: xmlField(block, "BuyerMessage"),
    });
  }
  return offers;
}

export async function respondToBestOffer(
  listingId: string,
  offerId: string,
  action: "Accept" | "Decline" | "Counter",
  opts: { counterPrice?: number; message?: string } = {},
  fetchImpl: FetchLike = fetch
): Promise<void> {
  const cfg = ebayConfig();
  if (!cfg) throw new Error("eBay is not configured");
  const token = await getEbayAccessToken(fetchImpl);
  const counter =
    action === "Counter" && opts.counterPrice !== undefined
      ? `<CounterOfferPrice currencyID="USD">${opts.counterPrice.toFixed(2)}</CounterOfferPrice>` +
        `<CounterOfferQuantity>1</CounterOfferQuantity>`
      : "";
  const message = opts.message
    ? `<SellerResponse>${opts.message.slice(0, 250).replace(/[<>&]/g, "")}</SellerResponse>`
    : "";
  const res = await fetchImpl(`${cfg.base}/ws/api.dll`, {
    method: "POST",
    headers: tradingHeaders("RespondToBestOffer", token),
    body:
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<RespondToBestOfferRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
      `<ItemID>${listingId}</ItemID><BestOfferID>${offerId}</BestOfferID>` +
      `<Action>${action}</Action>${counter}${message}` +
      `</RespondToBestOfferRequest>`,
  });
  if (!res.ok) throw new Error(`RespondToBestOffer failed: ${res.status}`);
  const xml = await res.text();
  if (xmlField(xml, "Ack") === "Failure") {
    throw new Error(`RespondToBestOffer rejected: ${xmlField(xml, "LongMessage") ?? xml.slice(0, 300)}`);
  }
}
