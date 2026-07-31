import { describe, expect, it } from "vitest";
import { parseOffer } from "@/lib/money";
import { createItemFromIntake, negotiate, resolveEscalation } from "@/lib/store";
import { brain } from "./helpers";
import type { Item } from "@/lib/types";

async function makeStoreItem(): Promise<Item> {
  return createItemFromIntake({
    clue: "I want to sell this guitar pedal",
    photos: ["/img/pedal.jpg"],
  });
}

async function lowball(item: Item): Promise<number> {
  const offer = Math.max(1, Math.round(item.policy.floorPrice * 0.6));
  await negotiate(
    item,
    {
      itemId: item.id,
      buyerName: "Lowball Larry",
      text: `Would you take $${offer}?`,
      offer: parseOffer(`Would you take $${offer}?`),
      ts: Date.now(),
    },
    brain
  );
  return offer;
}

describe("human approval of escalated offers", () => {
  it("parks a below-floor offer as escalated with a pendingOffer", async () => {
    const item = await makeStoreItem();
    const offer = await lowball(item);
    expect(item.status).toBe("escalated");
    expect(item.pendingOffer?.offer).toBe(offer);
    expect(item.pendingOffer?.buyerName).toBe("Lowball Larry");
  });

  it("decline holds at floor and returns to negotiation", async () => {
    const item = await makeStoreItem();
    await lowball(item);
    const reply = resolveEscalation(item, false);
    expect(reply?.decision).toBe("reject");
    expect(reply?.dealAgreed).toBe(false);
    expect(item.status).toBe("buyer-engaged");
    expect(item.pendingOffer).toBeUndefined();
  });

  it("approve closes the deal at the offered price — the only below-floor path", async () => {
    const item = await makeStoreItem();
    const offer = await lowball(item);
    const reply = resolveEscalation(item, true);
    expect(reply?.dealAgreed).toBe(true);
    expect(reply?.agreedPrice).toBe(offer);
    expect(item.status).toBe("offer-accepted");
    expect(item.payment.amount).toBe(offer);
    expect(item.pendingOffer).toBeUndefined();
  });

  it("is a no-op when nothing is pending", async () => {
    const item = await makeStoreItem();
    expect(resolveEscalation(item, true)).toBeNull();
    expect(item.status).toBe("listed");
  });
});
