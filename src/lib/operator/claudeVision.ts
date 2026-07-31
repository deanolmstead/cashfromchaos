// ============================================================================
// Claude vision analysis — the "point your camera at it" promise, for real.
// ----------------------------------------------------------------------------
// When the seller's photo is an actual capture (a data: URI from the intake
// camera) and Anthropic credentials are available, Claude looks at the photo
// and produces the item analysis: what it is, condition, market band, critical
// questions. The result feeds the SAME deterministic policy engine — vision
// informs the price band, but every commerce decision stays clamped to the
// CommercePolicy built from it. No credentials / no photo / any failure →
// null, and the archetype path takes over. The demo never breaks.
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Confidence, ItemAnalysis, ItemCondition, ItemIntake } from "@/lib/types";
import { round2 } from "@/lib/money";

const MODEL = "claude-opus-5";

const CONDITIONS: ItemCondition[] = ["new", "like-new", "good", "fair", "for-parts", "unknown"];
const CONFIDENCES: Confidence[] = ["low", "medium", "medium-high", "high"];

// Structured-output schema: attributes as key/value pairs (open maps aren't
// expressible with additionalProperties:false).
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title", "category", "condition", "confidence", "attributes", "rationale",
    "flags", "marketLowUsd", "marketHighUsd", "description", "sellingPoints", "questions",
  ],
  properties: {
    title: { type: "string", description: "Marketplace-ready title, max ~60 chars" },
    category: { type: "string", description: "e.g. 'musical instruments / gear'" },
    condition: { type: "string", enum: CONDITIONS },
    confidence: { type: "string", enum: CONFIDENCES },
    attributes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "value"],
        properties: { key: { type: "string" }, value: { type: "string" } },
      },
    },
    rationale: { type: "array", items: { type: "string" } },
    flags: { type: "array", items: { type: "string" } },
    marketLowUsd: { type: "number" },
    marketHighUsd: { type: "number" },
    description: { type: "string", description: "2-3 sentence buyer-facing description" },
    sellingPoints: { type: "array", items: { type: "string" } },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "question", "reason", "options"],
        properties: {
          id: { type: "string" },
          question: { type: "string" },
          reason: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

interface VisionResult {
  title: string;
  category: string;
  condition: string;
  confidence: string;
  attributes: { key: string; value: string }[];
  rationale: string[];
  flags: string[];
  marketLowUsd: number;
  marketHighUsd: number;
  description: string;
  sellingPoints: string[];
  questions: { id: string; question: string; reason: string; options: string[] }[];
}

/** True when there is any plausible credential source for the Anthropic SDK. */
export function visionConfigured(): boolean {
  if ((process.env.VISION ?? "").toLowerCase() === "off") return false;
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  try {
    return fs.existsSync(path.join(os.homedir(), ".config", "anthropic"));
  } catch {
    return false;
  }
}

function dataUriToImage(uri: string): { media_type: string; data: string } | null {
  const m = uri.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/);
  if (!m) return null;
  return { media_type: m[1], data: m[2] };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "detail";
}

/** Clamp/sanitize the model output into a safe ItemAnalysis. */
function toAnalysis(r: VisionResult): ItemAnalysis {
  let low = Number.isFinite(r.marketLowUsd) ? round2(Math.abs(r.marketLowUsd)) : 20;
  let high = Number.isFinite(r.marketHighUsd) ? round2(Math.abs(r.marketHighUsd)) : 60;
  low = Math.min(Math.max(low, 1), 25000);
  high = Math.min(Math.max(high, low), 25000);
  const condition = CONDITIONS.includes(r.condition as ItemCondition)
    ? (r.condition as ItemCondition)
    : "unknown";
  const confidence = CONFIDENCES.includes(r.confidence as Confidence)
    ? (r.confidence as Confidence)
    : "medium";
  const attributes: Record<string, string> = {};
  for (const a of (r.attributes ?? []).slice(0, 8)) {
    if (a?.key && a?.value) attributes[String(a.key).slice(0, 40)] = String(a.value).slice(0, 120);
  }
  return {
    title: (r.title || "Pre-owned Item").slice(0, 70),
    category: (r.category || "general").slice(0, 60),
    detectedAttributes: attributes,
    condition,
    confidence,
    rationale: (r.rationale ?? []).slice(0, 5).map((s) => String(s).slice(0, 200)),
    missingInfo: (r.questions ?? []).slice(0, 3).map((q) => ({
      id: slug(q.id || q.question),
      question: String(q.question).slice(0, 160),
      reason: String(q.reason || "Affects price materially.").slice(0, 160),
      options: (q.options ?? []).slice(0, 4).map((o) => String(o).slice(0, 60)),
    })),
    flags: (r.flags ?? []).slice(0, 5).map((f) => String(f).slice(0, 40)),
    estimatedMarketLow: low,
    estimatedMarketHigh: high,
    description: r.description ? String(r.description).slice(0, 600) : undefined,
    sellingPoints: (r.sellingPoints ?? []).slice(0, 4).map((s) => String(s).slice(0, 120)),
  };
}

/**
 * Analyze the seller's actual photo with Claude vision. Returns null when
 * there is no real photo, no credentials, or on any API failure — callers
 * fall back to the deterministic archetype path.
 */
export async function visionAnalyze(intake: ItemIntake): Promise<ItemAnalysis | null> {
  if (!visionConfigured()) return null;
  const image = intake.photos.map(dataUriToImage).find(Boolean);
  if (!image) return null; // fixture/demo photos → archetype path

  const answers = intake.answers
    ? Object.entries(intake.answers).map(([k, v]) => `${k}: ${v}`).join("; ")
    : "none";
  const prompt =
    `You are Hermes, an autonomous recommerce operator analyzing an item a seller ` +
    `wants to sell on US marketplaces (Facebook Marketplace local first).\n` +
    `Seller's clue: "${intake.clue}".\nExtra notes: ${intake.notes || "none"}.\n` +
    `Seller's answers to earlier questions: ${answers}.\n` +
    `Look at the photo. Identify the item as specifically as you can (brand/model if ` +
    `visible), assess condition from what is visible, and estimate a realistic used-market ` +
    `price band in US dollars. Be honest about uncertainty — use the questions array for ` +
    `up to 3 CRITICAL questions whose answers would materially change price or policy ` +
    `(model number, working state, authenticity). Do not invent specs you cannot infer. ` +
    `Flags: short tags like "authenticity-sensitive", "bulky", "fragile", "restricted".`;

  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic();
    const params = {
      model: MODEL,
      max_tokens: 4096,
      output_config: { format: { type: "json_schema" as const, schema: SCHEMA } },
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: image.media_type as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: image.data,
              },
            },
            { type: "text" as const, text: prompt },
          ],
        },
      ],
    };
    // Non-streaming responses only; narrow shape for both beta and GA calls.
    type MsgLike = {
      stop_reason: string | null;
      content: { type: string; text?: string }[];
    };
    let response: MsgLike;
    try {
      // Opt into server-side refusal fallbacks by default (harmless for benign
      // photos; keeps the flow alive if a classifier ever fires).
      response = (await client.beta.messages.create({
        ...params,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      } as Parameters<typeof client.beta.messages.create>[0])) as unknown as MsgLike;
    } catch {
      response = (await client.messages.create(params)) as unknown as MsgLike;
    }
    if (response.stop_reason === "refusal") return null;
    const text = response.content.find((b) => b.type === "text" && typeof b.text === "string");
    if (!text?.text) return null;
    return toAnalysis(JSON.parse(text.text) as VisionResult);
  } catch (err) {
    console.warn("[vision] falling back to archetype analysis:", (err as Error).message);
    return null;
  }
}
