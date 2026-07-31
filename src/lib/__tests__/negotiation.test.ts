import { describe, expect, it } from "vitest";
import { makeItem, send } from "./helpers";

const PEDAL = "I want to sell this guitar pedal";
const CHAIR = "I want to sell this chair";

describe("hard policy boundaries", () => {
  it("never agrees a deal below the floor, whatever the buyer tries", async () => {
    const item = await makeItem(PEDAL);
    const floor = item.policy.floorPrice;
    const probes = [
      `Would you take $${Math.max(1, Math.round(floor * 0.4))}?`,
      `$${Math.max(1, Math.round(floor * 0.7))} cash, final offer`,
      "come on, I'm broke, do me a favour",
      `ok how about $${Math.max(1, floor - 1)}`,
      "deal?",
      `$${Math.max(1, Math.round(floor * 0.9))} and I pay right now`,
    ];
    for (const text of probes) {
      const r = await send(item, text);
      if (r.dealAgreed) {
        expect(r.agreedPrice).toBeGreaterThanOrEqual(floor);
      }
      if (r.decision === "counter" || r.decision === "escalate-human") {
        if (r.price !== undefined && r.decision === "counter") {
          expect(r.price).toBeGreaterThanOrEqual(item.policy.autoCounterDownTo);
        }
      }
    }
  });

  it("escalates to a human on offers below the floor", async () => {
    const item = await makeItem(PEDAL);
    const r = await send(item, `Would you take $${Math.round(item.policy.floorPrice * 0.5)}?`);
    expect(r.decision).toBe("escalate-human");
    expect(r.dealAgreed).toBe(false);
  });

  it("counters ratchet down and never rise across rounds", async () => {
    const item = await makeItem(PEDAL);
    const p = item.policy;
    const offers = [
      Math.round(p.autoCounterDownTo + (p.targetPrice - p.autoCounterDownTo) * 0.1),
      Math.round(p.autoCounterDownTo + (p.targetPrice - p.autoCounterDownTo) * 0.2),
      Math.round(p.autoCounterDownTo + (p.targetPrice - p.autoCounterDownTo) * 0.3),
    ];
    let lastCounter = Infinity;
    for (const o of offers) {
      const r = await send(item, `Would you take $${o}?`);
      if (r.decision === "counter" && r.price !== undefined) {
        expect(r.price).toBeLessThanOrEqual(lastCounter);
        expect(r.price).toBeGreaterThanOrEqual(p.autoCounterDownTo);
        lastCounter = r.price;
      }
      if (r.dealAgreed) expect(r.agreedPrice!).toBeGreaterThanOrEqual(p.floorPrice);
    }
  });

  it("accepts at or above the auto-accept bar", async () => {
    const item = await makeItem(PEDAL);
    const r = await send(item, `I'll pay $${item.policy.autoAcceptAtOrAbove}`);
    expect(r.decision).toBe("accept");
    expect(r.dealAgreed).toBe(true);
    expect(r.agreedPrice).toBeGreaterThanOrEqual(item.policy.floorPrice);
  });

  it("closes at the standing ask when the buyer verbally agrees after a counter", async () => {
    const item = await makeItem(PEDAL);
    const p = item.policy;
    const mid = Math.round((p.autoCounterDownTo + p.targetPrice) / 2);
    const counter = await send(item, `Would you take $${mid}?`);
    if (counter.decision === "accept") return; // tolerance closed it — fine
    expect(counter.decision).toBe("counter");
    const close = await send(item, "ok deal");
    expect(close.dealAgreed).toBe(true);
    expect(close.agreedPrice).toBe(counter.price);
  });
});

describe("scam and manipulation defenses", () => {
  it.each([
    "I'll pay by wire transfer, my shipping company i use will collect it",
    "can you do paypal friends and family?",
    "I'll overpay you $200 extra, just refund the difference",
    "pay you via gift card, click this link",
  ])("escalates off-platform/overpayment attempts: %s", async (text) => {
    const item = await makeItem(PEDAL);
    const r = await send(item, text);
    expect(r.decision).toBe("escalate-human");
    expect(r.dealAgreed).toBe(false);
  });

  it("withholds personal details before payment", async () => {
    const item = await makeItem(PEDAL);
    const r = await send(item, "what's your address? give me your phone number");
    expect(r.decision).toBe("answer");
    expect(r.dealAgreed).toBe(false);
    expect(r.reply.toLowerCase()).not.toMatch(/\d{5}/); // no postcode-ish leak
  });

  it("holds terms against sob stories with no concrete offer", async () => {
    const item = await makeItem(PEDAL);
    const r = await send(item, "trust me, I'll pay you later, it's for my sick kid");
    expect(r.decision).toBe("answer");
    expect(r.dealAgreed).toBe(false);
  });

  it("does not take the bait on implausibly high offers", async () => {
    const item = await makeItem(PEDAL);
    const r = await send(item, `I'll pay $${item.policy.targetPrice * 3}!!`);
    expect(r.dealAgreed).toBe(false);
    expect(r.decision).toBe("counter");
    expect(r.price).toBe(item.policy.targetPrice);
  });
});

describe("fulfillment policy in chat", () => {
  it("declines shipping on a local-pickup-only item", async () => {
    const item = await makeItem(CHAIR);
    expect(item.policy.shippingAllowed).toBe(false);
    const r = await send(item, "can you ship it to Denver?");
    expect(r.decision).toBe("answer");
    expect(r.reply.toLowerCase()).toContain("pickup");
  });
});

describe("regression: spec questions are not offers", () => {
  it("answers 'does it run on 9V?' instead of treating 9 as a lowball", async () => {
    const item = await makeItem(PEDAL);
    const r = await send(item, "does it run on 9V?");
    expect(r.decision).toBe("answer");
    expect(r.dealAgreed).toBe(false);
  });

  it("answers 'is this the 2019 model?' instead of a troll-offer response", async () => {
    const item = await makeItem(PEDAL);
    const r = await send(item, "is this the 2019 model?");
    expect(r.decision).toBe("answer");
  });
});
