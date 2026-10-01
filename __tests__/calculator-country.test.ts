/**
 * The nav's calculator link opens the seller's own country's calculator:
 * their Jumia connection's country, else where the request comes from,
 * else Ghana (app/calculator/route.ts).
 */

const ipCountry: { value: string | null } = { value: null };
jest.mock("next/headers", () => ({
  headers: () => ({ get: (name: string) => (name === "x-vercel-ip-country" ? ipCountry.value : null) }),
}));

const connections: Record<string, string | null> = {};
jest.mock("@/lib/jumia/unlistable-categories", () => ({
  sellerCountry: jest.fn(async (userId: string) => {
    if (userId === "user-broken") throw new Error("db down");
    return connections[userId] ?? null;
  }),
}));

const session: { userId: string | null } = { userId: null };
jest.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: session.userId }) }));

import { NextRequest } from "next/server";
import { calculatorPathFor, jumiaCountryByCode } from "@/lib/marketing/countries";
import { visitorJumiaCountry } from "@/lib/marketing/visitor-country";
import { GET } from "@/app/calculator/route";

beforeEach(() => {
  ipCountry.value = null;
  session.userId = null;
  for (const k of Object.keys(connections)) delete connections[k];
});

describe("jumiaCountryByCode", () => {
  it("finds a Jumia country by its code, in any case", () => {
    expect(jumiaCountryByCode("NG")?.slug).toBe("nigeria");
    expect(jumiaCountryByCode("ke")?.slug).toBe("kenya");
    expect(jumiaCountryByCode(" ci ")?.slug).toBe("cote-divoire");
  });

  it("is undefined outside Jumia's markets and for nothing", () => {
    expect(jumiaCountryByCode("US")).toBeUndefined();
    expect(jumiaCountryByCode("")).toBeUndefined();
    expect(jumiaCountryByCode(null)).toBeUndefined();
    expect(jumiaCountryByCode(undefined)).toBeUndefined();
  });
});

describe("calculatorPathFor", () => {
  it("sends Ghana to its own calculator page", () => {
    expect(calculatorPathFor("GH")).toBe("/jumia-price-calculator");
  });

  it("sends the other countries to the calculator on their country page", () => {
    expect(calculatorPathFor("NG")).toBe("/sell-on-jumia/nigeria#calculator");
    expect(calculatorPathFor("eg")).toBe("/sell-on-jumia/egypt#calculator");
    expect(calculatorPathFor("UG")).toBe("/sell-on-jumia/uganda#calculator");
  });

  it("falls back to Ghana when the country is unknown or not a Jumia market", () => {
    expect(calculatorPathFor(null)).toBe("/jumia-price-calculator");
    expect(calculatorPathFor("US")).toBe("/jumia-price-calculator");
  });
});

describe("visitorJumiaCountry", () => {
  it("uses the seller's Jumia connection first, over where they browse from", async () => {
    connections["user-1"] = "KE";
    ipCountry.value = "GH";
    expect((await visitorJumiaCountry("user-1"))?.code).toBe("KE");
  });

  it("uses the request's country when the seller hasn't connected", async () => {
    ipCountry.value = "NG";
    expect((await visitorJumiaCountry("user-2"))?.code).toBe("NG");
  });

  it("uses the request's country for a logged-out visitor", async () => {
    ipCountry.value = "MA";
    expect((await visitorJumiaCountry(null))?.code).toBe("MA");
  });

  it("falls back to the request's country when the connection lookup fails", async () => {
    ipCountry.value = "SN";
    expect((await visitorJumiaCountry("user-broken"))?.code).toBe("SN");
  });

  it("is undefined when neither is a Jumia country", async () => {
    ipCountry.value = "GB";
    expect(await visitorJumiaCountry(null)).toBeUndefined();
  });
});

describe("GET /calculator", () => {
  const request = () => new NextRequest("https://pandaworldai.site/calculator");

  it("redirects a signed-in seller to their own country's calculator, uncached", async () => {
    session.userId = "user-ng";
    connections["user-ng"] = "NG";
    const res = await GET(request());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://pandaworldai.site/sell-on-jumia/nigeria#calculator");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("redirects a logged-out visitor by where the request comes from", async () => {
    ipCountry.value = "CI";
    const res = await GET(request());
    expect(res.headers.get("location")).toBe("https://pandaworldai.site/sell-on-jumia/cote-divoire#calculator");
  });

  it("redirects everyone else to Ghana's calculator", async () => {
    ipCountry.value = "US";
    const res = await GET(request());
    expect(res.headers.get("location")).toBe("https://pandaworldai.site/jumia-price-calculator");
  });
});
