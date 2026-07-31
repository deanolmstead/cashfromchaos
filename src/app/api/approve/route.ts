import { NextRequest, NextResponse } from "next/server";
import { ensureSeeded, getItem, resolveEscalation } from "@/lib/store";

export const dynamic = "force-dynamic";

// Seller resolves a below-floor offer the operator escalated.
// Body: { itemId: string, approve: boolean }
export async function POST(req: NextRequest) {
  const { itemId, approve } = await req.json();
  await ensureSeeded();
  const item = getItem(itemId);
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });

  const reply = resolveEscalation(item, Boolean(approve));
  if (!reply) {
    return NextResponse.json(
      { error: "No pending escalated offer on this item." },
      { status: 409 }
    );
  }
  return NextResponse.json({ item, reply });
}
