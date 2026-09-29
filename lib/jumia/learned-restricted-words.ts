/**
 * Banned words learned from Jumia's own rejections
 * (jumia_learned_restricted_words, supabase/migrations/2026-09-29_learned-
 * restricted-words.sql), fed into lib/ai/restricted-words.ts so drafting and
 * pushing treat them like the built-in list.
 *
 * Load before drafting or pushing; remember when a rejection names a word
 * (lib/jumia/feed-outcomes.ts). Failures never block anything: the built-in
 * list still applies.
 */

import { createServerClient } from "@/lib/supabase/server";
import { addLearnedRestrictedWords } from "@/lib/ai/restricted-words";

const CACHE_MS = 60 * 60 * 1000;
let loadedAt = 0;

/** Pull learned words into this process, at most once an hour. */
export async function loadLearnedRestrictedWords(): Promise<void> {
  if (Date.now() - loadedAt < CACHE_MS) return;
  try {
    const db = createServerClient();
    const { data, error } = await db.from("jumia_learned_restricted_words").select("word");
    if (error) throw new Error(error.message);
    addLearnedRestrictedWords(((data ?? []) as { word: string }[]).map((r) => r.word));
    loadedAt = Date.now();
  } catch (e) {
    console.warn(`[restricted-words] couldn't load learned words, using the built-in list: ${(e as Error).message}`);
  }
}

/** Record words a Jumia rejection named, and use them in this process straight away. */
export async function rememberRestrictedWords(words: string[], rejection: string | null): Promise<void> {
  if (words.length === 0) return;
  addLearnedRestrictedWords(words);
  try {
    const db = createServerClient();
    const now = new Date().toISOString();
    const { error } = await db.from("jumia_learned_restricted_words").upsert(
      words.map((word) => ({ word, last_seen: now, example: rejection?.slice(0, 500) ?? null })),
      { onConflict: "word" },
    );
    if (error) throw new Error(error.message);
    console.info(`[restricted-words] learned from a Jumia rejection: ${words.join(", ")}`);
  } catch (e) {
    console.warn(`[restricted-words] couldn't save learned words ${words.join(", ")}: ${(e as Error).message}`);
  }
}
