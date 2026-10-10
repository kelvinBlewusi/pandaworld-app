import type { Metadata } from "next";
import { CategoryPicker } from "./picker";

// ─── /categories — Jumia's categories, to copy the right one ─────────────────
//
// Where a category rejection sends the seller (owner, 2026-10-10: "visit
// this link to copy the right one ... the page should not be gated to a
// login"): the editor's category deck on its own, opened on the category
// the AI chose that Jumia refused (?c=<code>), with Jumia's refusals in
// their country (?cc=GH). They find the right one and copy its path into
// the chat, which takes a path as the answer (lib/whatsapp/intake.ts
// handleCategoryAnswer). Public, not indexed.

export const metadata: Metadata = {
  title: "Jumia categories",
  description: "Find the Jumia category your product belongs in and copy it.",
  robots: { index: false, follow: false },
};

export default async function CategoriesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const code = Number(one(sp.c));
  const country = /^[a-z]{2}$/i.test(one(sp.cc)) ? one(sp.cc).toUpperCase() : null;
  return <CategoryPicker initialCode={Number.isInteger(code) && code > 0 ? code : null} country={country} />;
}
