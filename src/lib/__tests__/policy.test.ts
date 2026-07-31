import { describe, expect, it } from "vitest";
import { makeItem } from "./helpers";

// One clue per archetype (collectible / music / watch / furniture / kids / generic).
const CLUES = [
  "I want to sell these Pokémon cards",
  "I want to sell this guitar pedal",
  "I want to sell this GPS smartwatch",
  "I want to sell this chair",
  "I want to sell this kid's stroller",
  "I want to sell this random thing",
];

describe.each(CLUES)("CommercePolicy invariants — %s", (clue) => {
  it("keeps the price ladder ordered: floor ≤ counter-down ≤ auto-accept, floor ≤ target", async () => {
    const { policy: p } = await makeItem(clue);
    expect(p.floorPrice).toBeGreaterThan(0);
    expect(p.floorPrice).toBeLessThanOrEqual(p.targetPrice);
    expect(p.autoCounterDownTo).toBeGreaterThanOrEqual(p.floorPrice);
    expect(p.autoAcceptAtOrAbove).toBeGreaterThanOrEqual(p.autoCounterDownTo);
    expect(p.requireHumanBelow).toBeLessThanOrEqual(p.floorPrice);
  });

  it("only allows Stripe payment and planned channels", async () => {
    const { policy: p, plan } = await makeItem(clue);
    expect(p.allowedPaymentMethods).toEqual(["stripe"]);
    expect(p.allowedChannels).toContain(plan.primary.channelId);
  });

  it("never budgets fulfillment spend for pickup-only items", async () => {
    const { policy: p } = await makeItem(clue);
    if (!p.shippingAllowed) expect(p.maxFulfillmentSpend).toBe(0);
    expect(p.shippingAllowed || p.pickupAllowed).toBe(true);
  });

  it("prices every listing draft at the policy target", async () => {
    const { policy: p, listings } = await makeItem(clue);
    expect(listings.length).toBeGreaterThan(0);
    for (const l of listings) expect(l.price).toBe(p.targetPrice);
  });
});

describe("seller answers refine the price band", () => {
  it("cuts the band materially when the item is reported faulty", async () => {
    const base = await makeItem("I want to sell this guitar pedal");
    const faulty = await makeItem("I want to sell this guitar pedal", {
      works: "it's faulty, not working",
    });
    expect(faulty.analysis.estimatedMarketHigh).toBeLessThan(
      base.analysis.estimatedMarketHigh
    );
    expect(faulty.policy.targetPrice).toBeLessThan(base.policy.targetPrice);
  });

  it("drops answered questions from missingInfo", async () => {
    const base = await makeItem("I want to sell this guitar pedal");
    const firstQ = base.analysis.missingInfo[0];
    if (!firstQ) return;
    const answered = await makeItem("I want to sell this guitar pedal", {
      [firstQ.id]: "yes, works perfectly",
    });
    expect(answered.analysis.missingInfo.map((q) => q.id)).not.toContain(firstQ.id);
  });
});

describe("fulfillment stays inside policy", () => {
  it.each(CLUES)("label cost never exceeds maxFulfillmentSpend — %s", async (clue) => {
    const { brain } = await import("./helpers");
    const item = await makeItem(clue);
    const plan = await brain.decideFulfillment(item);
    expect(plan.labelCost).toBeLessThanOrEqual(item.policy.maxFulfillmentSpend);
    if (plan.mode === "local-pickup") expect(plan.labelCost).toBe(0);
  });
});
