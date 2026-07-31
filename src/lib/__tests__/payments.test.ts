import { describe, expect, it } from "vitest";
import { buildLedger, netPayout } from "@/lib/payments";
import { makeItem, brain } from "./helpers";

describe("ledger and payout", () => {
  it("nets gross minus marketplace fee minus shipping", async () => {
    const item = await makeItem("I want to sell this guitar pedal");
    item.payment = { provider: "simulated", status: "held", amount: 75 };
    item.fulfillment = await brain.decideFulfillment(item);
    item.ledger = buildLedger(item);

    const gross = 75;
    const fee = Math.round(gross * item.plan.primary.feePct) / 100;
    const expected =
      Math.round((gross - fee - (item.fulfillment?.labelCost ?? 0)) * 100) / 100;
    expect(netPayout(item)).toBeCloseTo(expected, 2);
    expect(netPayout(item)).toBeLessThan(gross);
    expect(netPayout(item)).toBeGreaterThan(0);
  });

  it("adds no shipping cost for pickup-only items", async () => {
    const item = await makeItem("I want to sell this chair");
    item.payment = { provider: "simulated", status: "held", amount: 40 };
    item.fulfillment = await brain.decideFulfillment(item);
    item.ledger = buildLedger(item);
    expect(item.ledger.some((e) => e.kind === "shipping")).toBe(false);
  });
});
