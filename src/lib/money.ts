export function usd(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(amount);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Round a price to a natural-looking marketplace number. Low-value items keep
 * whole dollars (rounding $18.40→$18 not $20); everything else snaps to the
 * nearest $5 ($110.72→$110, $73.75→$75). Never returns 0 for a positive price.
 */
export function niceRound(n: number): number {
  if (n <= 0) return 0;
  if (n < 30) return Math.max(1, Math.round(n));
  return Math.round(n / 5) * 5;
}

/**
 * Words that signal a number in buyer text is a price proposal rather than a
 * spec question ("does it run on 9V?", "is this the 2019 model?").
 */
const OFFER_CONTEXT =
  /(take|accept|offer|offering|pay|give you|give\b|i can do|would you do|can you do|do you do|go (as )?low|lowest|best price|meet (me |you )?at|settle|deal at|final|i'?ll do|how about|what about)/i;

/**
 * Parse the first plausible dollar amount out of free buyer text.
 * A number counts as an offer only when it is currency-marked ("$50", "50
 * dollars", "50 bucks"), sits in offer context ("would you take 50?"), or IS
 * the whole message ("50"). Bare spec numbers ("9V", "2019 model") are not
 * offers.
 */
export function parseOffer(text: string): number | undefined {
  const cleaned = text.replace(/(\d),(\d{3})(?!\d)/g, "$1$2"); // 1,200 -> 1200
  // 1) Explicit currency marker: "$50", "50 dollars", "50 bucks", "50 usd"
  let m = cleaned.match(
    /\$\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:dollars?\b|bucks?\b|usd\b)/i
  );
  let raw = m ? m[1] ?? m[2] : undefined;
  if (!raw) {
    // 2) Bare number — only in offer context or as the entire message. The
    //    lookahead rejects numbers glued to units ("9V", "64GB").
    const justNumber = /^\s*\d+(?:\.\d{1,2})?\s*[?!.]*\s*$/.test(cleaned);
    if (!justNumber && !OFFER_CONTEXT.test(cleaned)) return undefined;
    const bm = cleaned.match(/(\d+(?:\.\d{1,2})?)(?![\w])/i);
    raw = bm?.[1];
  }
  if (!raw) return undefined;
  const val = parseFloat(raw);
  return Number.isFinite(val) ? val : undefined;
}
