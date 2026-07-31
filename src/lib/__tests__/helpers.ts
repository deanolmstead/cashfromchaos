import { FixtureBrain } from "@/lib/operator/fixtureBrain";
import { parseOffer } from "@/lib/money";
import type { AgentReply, BuyerMessage, Item } from "@/lib/types";

export const brain = new FixtureBrain();

/** Build a full Item aggregate through the real brain pipeline. */
export async function makeItem(clue: string, answers?: Record<string, string>): Promise<Item> {
  const intake = { clue, photos: ["/img/generic.jpg"], answers };
  const analysis = await brain.analyzeItem(intake);
  const plan = await brain.chooseMarketplace(analysis);
  const policy = await brain.buildPolicy(analysis, plan);
  const listings = await brain.draftListings(analysis, plan, policy);
  return {
    id: "test-item",
    createdAt: 0,
    intake,
    analysis,
    plan,
    policy,
    listings,
    status: "listed",
    messages: [],
    agentReplies: [],
    payment: { provider: "simulated", status: "none", amount: 0 },
    ledger: [],
    trace: [],
  };
}

/**
 * Send one buyer message through the brain, recording message + reply on the
 * item the way the store does, so multi-round negotiations carry memory.
 */
export async function send(item: Item, text: string): Promise<AgentReply> {
  const message: BuyerMessage = {
    itemId: item.id,
    buyerName: "Test Buyer",
    text,
    offer: parseOffer(text),
    ts: item.messages.length,
  };
  const reply = await brain.handleBuyerMessage(item, message);
  item.messages.push(message);
  item.agentReplies.push(reply);
  return reply;
}
