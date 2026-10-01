import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { calculatorPathFor } from "@/lib/marketing/countries";
import { visitorJumiaCountry } from "@/lib/marketing/visitor-country";

// ─── /calculator — the nav's calculator link ──────────────────────────────────
//
// Redirects to the calculator for the country the visitor sells in: their
// Jumia connection's country when signed in, otherwise where Vercel
// locates the request, and Ghana's calculator when neither is a Jumia
// market (lib/marketing/countries.ts calculatorPathFor). A temporary
// redirect that's never cached, since the answer differs per visitor.

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { userId } = await auth();
  const country = await visitorJumiaCountry(userId);
  const response = NextResponse.redirect(new URL(calculatorPathFor(country?.code), request.url), 307);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
