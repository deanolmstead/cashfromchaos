import { NextRequest, NextResponse } from "next/server";
import { ensureSeeded, getItem, saveItem, trace } from "@/lib/store";
import { createEbayListing, ebayConfigured } from "@/lib/marketplace/ebay";

export const dynamic = "force-dynamic";

// Publish an item's listing draft to eBay (sandbox by default).
// Body: { itemId: string }
export async function POST(req: NextRequest) {
  const { itemId } = await req.json();
  await ensureSeeded();
  const item = getItem(itemId);
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  if (!ebayConfigured()) {
    return NextResponse.json(
      { error: "eBay is not configured — set the EBAY_* env vars (see .env.example)." },
      { status: 503 }
    );
  }
  if (item.externalListings?.some((l) => l.channelId === "ebay" && l.status === "live")) {
    return NextResponse.json({ error: "Item already has a live eBay listing." }, { status: 409 });
  }

  // Prefer the eBay-channel draft; fall back to the primary draft.
  const draft =
    item.listings.find((l) => l.channelId.startsWith("ebay")) ?? item.listings[0];
  if (!draft) return NextResponse.json({ error: "Item has no listing drafts." }, { status: 409 });

  try {
    const result = await createEbayListing(draft, {
      sku: item.id,
      imageUrls: item.intake.photos, // http(s) URLs only; data URIs are skipped
      bestOffer: true,
    });
    item.externalListings = [...(item.externalListings ?? []), result];
    trace(item, "operator", "Published to eBay", result.url, "decision");
    saveItem(item);
    return NextResponse.json({ item, listing: result });
  } catch (err) {
    trace(item, "system", "eBay publish failed", (err as Error).message, "warn");
    saveItem(item);
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
