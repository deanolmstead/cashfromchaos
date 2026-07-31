import { NextRequest, NextResponse } from "next/server";
import { ensureSeeded, listItems, negotiate, saveItem, trace } from "@/lib/store";
import { ebayConfigured, getBestOffers, respondToBestOffer } from "@/lib/marketplace/ebay";
import type { Item } from "@/lib/types";

export const dynamic = "force-dynamic";

// Poll eBay Best Offers for every live eBay listing and route each new offer
// through the policy engine. Trigger manually, from a cron, or a launchd job:
//   curl -X POST http://localhost:3000/api/ebay/poll
export async function POST(_req: NextRequest) {
  await ensureSeeded();
  if (!ebayConfigured()) {
    return NextResponse.json(
      { error: "eBay is not configured — set the EBAY_* env vars (see .env.example)." },
      { status: 503 }
    );
  }

  const NEGOTIABLE: Item["status"][] = ["listed", "buyer-engaged", "escalated"];
  const handled: { itemId: string; offerId: string; decision: string }[] = [];

  for (const item of listItems()) {
    const listing = item.externalListings?.find(
      (l) => l.channelId === "ebay" && l.status === "live"
    );
    if (!listing || !NEGOTIABLE.includes(item.status)) continue;

    let offers;
    try {
      offers = await getBestOffers(listing.externalId);
    } catch (err) {
      trace(item, "system", "eBay offer poll failed", (err as Error).message, "warn");
      saveItem(item);
      continue;
    }

    for (const offer of offers) {
      const seen = item.ebayOffersSeen ?? [];
      if (seen.includes(offer.offerId)) continue;
      item.ebayOffersSeen = [...seen, offer.offerId];

      // The SAME policy-bound negotiation the sandbox buyer goes through.
      const reply = await negotiate(item, {
        itemId: item.id,
        buyerName: `${offer.buyerName} (eBay)`,
        text: offer.message ?? `Best Offer: $${offer.price}`,
        offer: offer.price,
        ts: Date.now(),
      });

      try {
        if (reply.decision === "accept" && reply.dealAgreed) {
          await respondToBestOffer(listing.externalId, offer.offerId, "Accept", {
            message: reply.reply,
          });
        } else if (reply.decision === "counter" && reply.price !== undefined) {
          await respondToBestOffer(listing.externalId, offer.offerId, "Counter", {
            counterPrice: reply.price,
            message: reply.reply,
          });
        } else if (reply.decision === "reject") {
          await respondToBestOffer(listing.externalId, offer.offerId, "Decline", {
            message: reply.reply,
          });
        }
        // escalate-human: leave the offer open on eBay until the seller
        // decides on the item page (eBay Best Offers stay live for 48h).
      } catch (err) {
        trace(item, "system", "eBay offer response failed", (err as Error).message, "warn");
      }
      saveItem(item);
      handled.push({ itemId: item.id, offerId: offer.offerId, decision: reply.decision });
    }
  }

  return NextResponse.json({ handled });
}
