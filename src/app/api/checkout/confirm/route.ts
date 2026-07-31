import { NextRequest, NextResponse } from "next/server";
import { ensureSeeded, getItem, saveItem, setStatus, trace } from "@/lib/store";
import { getOperator } from "@/lib/operator";
import { buildLedger } from "@/lib/payments";
import { usd } from "@/lib/money";
import { notify } from "@/lib/notify";

export const dynamic = "force-dynamic";

// Stripe success_url and the simulated flow both land here.
export async function GET(req: NextRequest) {
  const itemId = req.nextUrl.searchParams.get("item");
  if (!itemId) return NextResponse.json({ error: "Missing item" }, { status: 400 });
  await ensureSeeded();
  const item = getItem(itemId);
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });

  if (item.payment.status !== "released") {
    // Mark payment held in custody.
    item.payment.status = "held";
    trace(item, "stripe", "Payment received — held in custody", usd(item.payment.amount), "money");
    setStatus(item, "paid");

    // Operator decides fulfillment, then we build the ledger.
    const fulfillment = await getOperator().decideFulfillment(item);
    item.fulfillment = fulfillment;
    item.ledger = buildLedger(item);
    trace(
      item,
      "operator",
      fulfillment.mode === "shipping" ? "Shipping label generated" : "Local pickup arranged",
      fulfillment.instruction,
      "money"
    );
    setStatus(item, fulfillment.mode === "shipping" ? "shipping-required" : "shipping-required");
    saveItem(item);
    notify(
      "💵 Payment held",
      `${usd(item.payment.amount)} for ${item.analysis.title} — ${
        fulfillment.mode === "shipping" ? "ship it to release payout" : "arrange pickup"
      }`
    );
  }

  return NextResponse.redirect(new URL(`/market/${itemId}?paid=1`, req.url));
}
