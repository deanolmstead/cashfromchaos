import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetTokenCache,
  createEbayListing,
  ebayConfigured,
  getBestOffers,
  getEbayAccessToken,
  respondToBestOffer,
  type FetchLike,
} from "@/lib/marketplace/ebay";

const ENV = {
  EBAY_CLIENT_ID: "test-client",
  EBAY_CLIENT_SECRET: "test-secret",
  EBAY_REFRESH_TOKEN: "test-refresh",
  EBAY_ENV: "sandbox",
  EBAY_FULFILLMENT_POLICY_ID: "fp1",
  EBAY_PAYMENT_POLICY_ID: "pp1",
  EBAY_RETURN_POLICY_ID: "rp1",
};

function mockFetch(routes: { match: string; body: string | object; status?: number }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) return new Response("not found", { status: 404 });
    const status = route.status ?? 200;
    const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return new Response(status === 204 ? null : body, { status });
  };
  return { impl, calls };
}

const TOKEN_ROUTE = {
  match: "/identity/v1/oauth2/token",
  body: { access_token: "tok_123", expires_in: 7200 },
};

beforeEach(() => {
  Object.assign(process.env, ENV);
  _resetTokenCache();
});

afterEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  _resetTokenCache();
});

describe("eBay config gating", () => {
  it("is not configured without credentials", () => {
    delete process.env.EBAY_CLIENT_ID;
    expect(ebayConfigured()).toBe(false);
  });
  it("is configured with credentials", () => {
    expect(ebayConfigured()).toBe(true);
  });
});

describe("OAuth token refresh", () => {
  it("fetches once and caches until expiry", async () => {
    const { impl, calls } = mockFetch([TOKEN_ROUTE]);
    expect(await getEbayAccessToken(impl)).toBe("tok_123");
    expect(await getEbayAccessToken(impl)).toBe("tok_123");
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("api.sandbox.ebay.com");
    const auth = (calls[0].init?.headers as Record<string, string>).Authorization;
    expect(auth).toMatch(/^Basic /);
  });
});

describe("listing creation flow", () => {
  it("runs inventory → offer → publish and returns the live listing", async () => {
    const { impl, calls } = mockFetch([
      TOKEN_ROUTE,
      { match: "/sell/inventory/v1/inventory_item/", body: "", status: 204 },
      { match: "/offer/of_1/publish", body: { listingId: "1100001" } },
      { match: "/sell/inventory/v1/offer", body: { offerId: "of_1" }, status: 201 },
    ]);
    const result = await createEbayListing(
      { channelId: "ebay-mock", title: "Guitar Pedal", body: "desc", tags: [], price: 140, currency: "USD" },
      { sku: "item_test_1" },
      impl
    );
    expect(result.status).toBe("live");
    expect(result.externalId).toBe("1100001");
    expect(result.url).toContain("sandbox.ebay.com/itm/1100001");
    const offerCall = calls.find((c) => c.url.endsWith("/sell/inventory/v1/offer"));
    const payload = JSON.parse(String(offerCall!.init!.body));
    expect(payload.pricingSummary.price.value).toBe("140.00");
    expect(payload.pricingSummary.price.currency).toBe("USD");
    expect(payload.bestOfferTerms.bestOfferEnabled).toBe(true);
  });
});

describe("Best Offers", () => {
  it("parses active offers from Trading API XML", async () => {
    const xml =
      `<GetBestOffersResponse><Ack>Success</Ack><BestOfferArray>` +
      `<BestOffer><BestOfferID>bo1</BestOfferID><Price>95.00</Price>` +
      `<Buyer><UserID>testbuyer</UserID></Buyer><BuyerMessage>would you take 95?</BuyerMessage></BestOffer>` +
      `</BestOfferArray></GetBestOffersResponse>`;
    const { impl } = mockFetch([TOKEN_ROUTE, { match: "/ws/api.dll", body: xml }]);
    const offers = await getBestOffers("1100001", impl);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      offerId: "bo1",
      listingId: "1100001",
      price: 95,
      buyerName: "testbuyer",
    });
  });

  it("sends a counter with price and throws on Ack Failure", async () => {
    const ok = `<RespondToBestOfferResponse><Ack>Success</Ack></RespondToBestOfferResponse>`;
    const { impl, calls } = mockFetch([TOKEN_ROUTE, { match: "/ws/api.dll", body: ok }]);
    await respondToBestOffer("1100001", "bo1", "Counter", { counterPrice: 120 }, impl);
    const xmlBody = String(calls.find((c) => c.url.includes("/ws/api.dll"))!.init!.body);
    expect(xmlBody).toContain("<Action>Counter</Action>");
    expect(xmlBody).toContain('120.00');

    const fail = `<RespondToBestOfferResponse><Ack>Failure</Ack><LongMessage>nope</LongMessage></RespondToBestOfferResponse>`;
    const bad = mockFetch([TOKEN_ROUTE, { match: "/ws/api.dll", body: fail }]);
    await expect(
      respondToBestOffer("1100001", "bo1", "Decline", {}, bad.impl)
    ).rejects.toThrow(/nope/);
  });
});
