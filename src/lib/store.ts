// ============================================================================
// In-memory store + orchestration. Single source of truth for the demo.
// Persisted on globalThis so it survives Next.js dev hot-reloads and is shared
// across API routes within a server process. No DB required for the demo;
// Supabase can back this later behind the same functions.
// ============================================================================

import { dbClear, dbLoadAll, dbUpsert } from "@/lib/db";
import { usd } from "@/lib/money";
import { notify } from "@/lib/notify";

// Seeding replays canned buyer history — don't ping the seller about it.
let seeding = false;
function ping(title: string, body: string): void {
  if (!seeding) notify(title, body);
}
import { getOperator } from "@/lib/operator";
import { FixtureBrain } from "@/lib/operator/fixtureBrain";
import type {
  AgentReply,
  BuyerMessage,
  Item,
  ItemIntake,
  OperatorBrain,
  TraceEvent,
  TransactionStatus,
} from "@/lib/types";

interface Store {
  items: Map<string, Item>;
  seeded: boolean;
}

const g = globalThis as unknown as { __cfc_store?: Store };
function store(): Store {
  if (!g.__cfc_store) {
    const items = new Map<string, Item>();
    // Hydrate from SQLite: items survive server restarts. If the file has any
    // rows, we consider the store seeded (don't overwrite real data with demo
    // fixtures).
    for (const item of dbLoadAll()) items.set(item.id, item);
    g.__cfc_store = { items, seeded: items.size > 0 };
  }
  return g.__cfc_store;
}

let counter = 0;
export function newId(prefix = "item"): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

export function trace(
  item: Item,
  actor: TraceEvent["actor"],
  label: string,
  detail?: string,
  level: TraceEvent["level"] = "info"
): void {
  item.trace.push({ ts: Date.now(), actor, label, detail, level });
}

// ---------------------------------------------------------------------------
// Build a full Item by running the operator brain pipeline.
// ---------------------------------------------------------------------------
export async function createItemFromIntake(
  intake: ItemIntake,
  opts: { id?: string; createdAt?: number } = {}
): Promise<Item> {
  const op = getOperator();
  const analysis = await op.analyzeItem(intake);
  const plan = await op.chooseMarketplace(analysis);
  const policy = await op.buildPolicy(analysis, plan);
  const listings = await op.draftListings(analysis, plan, policy);

  const item: Item = {
    id: opts.id ?? newId(),
    createdAt: opts.createdAt ?? Date.now(),
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

  trace(item, "seller", "Item submitted", `"${intake.clue}"`);
  trace(
    item,
    "operator",
    `Analyzed: ${analysis.title}`,
    `${analysis.category} · confidence ${analysis.confidence} · est ${usd(
      analysis.estimatedMarketLow
    )}–${usd(analysis.estimatedMarketHigh)}`,
    "decision"
  );
  if (analysis.missingInfo.length) {
    trace(
      item,
      "operator",
      `Needs ${analysis.missingInfo.length} critical detail(s)`,
      analysis.missingInfo.map((q) => q.question).join(" | "),
      "warn"
    );
  }
  trace(
    item,
    "operator",
    `Routed to ${plan.primary.name}`,
    `fit ${(plan.primary.fitScore * 100).toFixed(0)}% · ${plan.primary.reason}`,
    "decision"
  );
  trace(
    item,
    "operator",
    `Policy set`,
    `target ${usd(policy.targetPrice)} · floor ${usd(policy.floorPrice)} · auto-counter to ${usd(
      policy.autoCounterDownTo
    )} · human approval below ${usd(policy.requireHumanBelow)}`,
    "decision"
  );
  trace(item, "system", `Listing live on ${plan.primary.name}`, listings[0]?.title);

  saveItem(item);
  return item;
}

export function getItem(id: string): Item | undefined {
  return store().items.get(id);
}

export function listItems(): Item[] {
  return [...store().items.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function saveItem(item: Item): void {
  store().items.set(item.id, item);
  dbUpsert(item);
}

export function setStatus(item: Item, status: TransactionStatus): void {
  item.status = status;
  saveItem(item);
}

// ---------------------------------------------------------------------------
// Negotiation: record a buyer message, run the brain, record the reply.
// ---------------------------------------------------------------------------
export async function negotiate(
  item: Item,
  msg: BuyerMessage,
  brain?: OperatorBrain
): Promise<AgentReply> {
  const op = brain ?? getOperator();
  item.messages.push(msg);
  trace(
    item,
    "buyer",
    `${msg.buyerName}: ${msg.text}`,
    msg.offer !== undefined ? `offer ${usd(msg.offer)}` : undefined
  );
  if (item.status === "listed") {
    setStatus(item, "buyer-engaged");
    ping("💬 Buyer engaged", `${msg.buyerName} is asking about ${item.analysis.title}`);
  }

  const reply = await op.handleBuyerMessage(item, msg);
  item.agentReplies.push(reply);
  trace(
    item,
    "operator",
    `Hermes → ${reply.decision}`,
    reply.reason,
    reply.decision === "accept" ? "money" : "decision"
  );

  if (reply.dealAgreed && reply.agreedPrice !== undefined) {
    item.payment = {
      provider: item.payment.provider,
      status: "none",
      amount: reply.agreedPrice,
    };
    setStatus(item, "offer-accepted");
    trace(item, "operator", `Deal agreed at ${usd(reply.agreedPrice)}`, "Awaiting Stripe payment", "money");
    ping("🤝 Deal agreed", `${item.analysis.title} at ${usd(reply.agreedPrice)} — awaiting payment`);
  } else if (reply.decision === "escalate-human" && msg.offer !== undefined) {
    // Below-floor offer: park it for the seller's explicit decision. Only
    // pre-deal states escalate — a paid item can't re-enter negotiation.
    if (item.status === "listed" || item.status === "buyer-engaged" || item.status === "escalated") {
      item.pendingOffer = { buyerName: msg.buyerName, offer: msg.offer, ts: msg.ts };
      setStatus(item, "escalated");
      trace(
        item,
        "operator",
        `Requires your approval: ${usd(msg.offer)} from ${msg.buyerName}`,
        `Below floor ${usd(item.policy.floorPrice)} — approve or decline on the item page.`,
        "warn"
      );
      ping(
        "⚠️ Needs your call",
        `${msg.buyerName} offered ${usd(msg.offer)} for ${item.analysis.title} (floor ${usd(item.policy.floorPrice)})`
      );
    }
  }
  saveItem(item);
  return reply;
}

// ---------------------------------------------------------------------------
// Human approval: the seller resolves a below-floor offer the operator parked.
// This is the only path that can close a deal under the policy floor.
// ---------------------------------------------------------------------------
export function resolveEscalation(item: Item, approve: boolean): AgentReply | null {
  const pending = item.pendingOffer;
  if (item.status !== "escalated" || !pending) return null;
  item.pendingOffer = undefined;

  if (approve) {
    const reply: AgentReply = {
      decision: "accept",
      price: pending.offer,
      reply: `Good news — the seller signed off on ${usd(pending.offer)}. Deal. I'm sending a secure Stripe payment link now; pay today and it's yours.`,
      reason: `Seller explicitly approved below-floor offer ${usd(pending.offer)} (floor ${usd(item.policy.floorPrice)}).`,
      dealAgreed: true,
      agreedPrice: pending.offer,
    };
    item.agentReplies.push(reply);
    item.payment = { provider: item.payment.provider, status: "none", amount: pending.offer };
    setStatus(item, "offer-accepted");
    trace(item, "seller", `Approved ${usd(pending.offer)} from ${pending.buyerName}`, "Below-floor deal closed with explicit approval", "money");
    saveItem(item);
    return reply;
  }

  const reply: AgentReply = {
    decision: "reject",
    price: item.policy.floorPrice,
    reply: `Checked with the seller — ${usd(pending.offer)} doesn't work. ${usd(item.policy.floorPrice)} is the true bottom; happy to close at that today via Stripe.`,
    reason: `Seller declined below-floor offer ${usd(pending.offer)}; holding at floor ${usd(item.policy.floorPrice)}.`,
    dealAgreed: false,
  };
  item.agentReplies.push(reply);
  setStatus(item, "buyer-engaged");
  trace(item, "seller", `Declined ${usd(pending.offer)} from ${pending.buyerName}`, `Operator holds at floor ${usd(item.policy.floorPrice)}`, "decision");
  saveItem(item);
  return reply;
}

// ---------------------------------------------------------------------------
// Seed the three demo items (collectible / music / bulky-local).
// ---------------------------------------------------------------------------
let seedPromise: Promise<void> | null = null;

/** Wipe all items and re-seed the three demo fixtures (for clean video takes). */
export async function resetDemo(): Promise<void> {
  const s = store();
  s.items.clear();
  dbClear();
  s.seeded = false;
  seedPromise = null;
  await ensureSeeded();
}

export function ensureSeeded(): Promise<void> {
  const s = store();
  if (s.seeded) return Promise.resolve();
  if (!seedPromise) {
    s.seeded = true; // set first to avoid re-entry while async seeds run
    seedPromise = seedDemo();
  }
  return seedPromise;
}

async function seedDemo(): Promise<void> {
  seeding = true;
  try {
    await seedDemoInner();
  } finally {
    seeding = false;
  }
}

async function seedDemoInner(): Promise<void> {
  const { DEMO_INTAKES } = await import("@/fixtures/items");
  // Pre-canned demo history is always generated by the deterministic fixture
  // brain so seeding (and Reset) stays instant even when OPERATOR_BRAIN=hermes.
  // The live Hermes operator only kicks in for new buyer messages typed during
  // the demo, via getOperator() in negotiate().
  const seedBrain = new FixtureBrain();
  let t = Date.now() - 1000 * 60 * 60;
  for (const seed of DEMO_INTAKES) {
    const item = await createItemFromIntake(seed.intake, { id: seed.id, createdAt: (t += 60000) });
    for (const m of seed.seedMessages ?? []) {
      await negotiate(
        item,
        {
          itemId: item.id,
          buyerName: m.buyerName,
          text: m.text,
          offer: m.offer,
          ts: Date.now() - (m.agoMs ?? 0),
        },
        seedBrain
      );
    }
    saveItem(item);
  }
}
