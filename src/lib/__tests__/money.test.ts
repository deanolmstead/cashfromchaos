import { describe, expect, it } from "vitest";
import { usd, niceRound, parseOffer, round2 } from "@/lib/money";

describe("round2", () => {
  it("rounds to cents", () => {
    expect(round2(1.005)).toBeCloseTo(1.0, 2);
    expect(round2(73.756)).toBe(73.76);
  });
});

describe("niceRound", () => {
  it("keeps whole euros under $30", () => {
    expect(niceRound(18.4)).toBe(18);
    expect(niceRound(29.6)).toBe(30);
  });
  it("snaps to $5 at $30+", () => {
    expect(niceRound(110.72)).toBe(110);
    expect(niceRound(73.75)).toBe(75);
  });
  it("never returns 0 for a positive price", () => {
    expect(niceRound(0.4)).toBe(1);
    expect(niceRound(0)).toBe(0);
  });
});

describe("usd", () => {
  it("formats as US dollars", () => {
    expect(usd(75)).toMatch(/75/);
    expect(usd(75)).toContain("$");
  });
});

describe("parseOffer — currency-marked numbers are offers", () => {
  it.each([
    ["Would you take $50?", 50],
    ["$50 and I pick it up today", 50],
    ["I can pay 75.50 dollars", 75.5],
    ["ok, 60 bucks", 60],
    ["$1,200 final", 1200],
  ])("%s → %d", (text, expected) => {
    expect(parseOffer(text)).toBe(expected);
  });
});

describe("parseOffer — bare numbers need offer context", () => {
  it.each([
    ["Would you take 50?", 50],
    ["I'll pay 45.50", 45.5],
    ["how about 40", 40],
    ["i can do 55", 55],
    ["50", 50], // whole message is the number
    ["65?", 65],
  ])("%s → %d", (text, expected) => {
    expect(parseOffer(text)).toBe(expected);
  });

  it.each([
    "does it run on 9V?",
    "is this the 2019 model?",
    "does it have 64GB of storage?",
    "is it the MK2 version?",
    "how tall is it in cm?",
  ])("spec question is NOT an offer: %s", (text) => {
    expect(parseOffer(text)).toBeUndefined();
  });
});
