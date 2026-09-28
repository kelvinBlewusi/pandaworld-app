// Fails the build when compiled server code would send an emoji as the
// literal text "🔒" instead of the character.
//
// The production minifier folds constant string joins into one string, and
// when a piece of the join was a `${}` template it printed a new template
// with the emoji escaped twice. Sellers got "Tap on the padlock icon
// 🔒" in WhatsApp on 2026-09-28 (lib/whatsapp/jumia-connect.ts).
// Unit tests run the source, not the minified build, so they can't see it;
// this reads the build itself.
//
// Run after `next build` (package.json "build", vercel.json buildCommand).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = ".next/server";
// Two backslashes, then half of a surrogate pair: in JS source that is a
// literal backslash followed by "uD83D", never an emoji.
const DOUBLE_ESCAPED = /\\\\u[dD][89abAB][0-9a-fA-F]{2}/g;

function* jsFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* jsFiles(path);
    else if (name.endsWith(".js")) yield path;
  }
}

const found = [];
for (const file of jsFiles(ROOT)) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(DOUBLE_ESCAPED)) {
    found.push(`${file}: …${text.slice(Math.max(0, m.index - 80), m.index + 20)}…`);
  }
}

if (found.length > 0) {
  console.error(
    "Compiled server code contains a double-escaped emoji; sellers would see the code instead of the icon.\n" +
    "Usually a list of message lines joined together where one line is a `${}` template: use plain strings.\n\n" +
    found.join("\n\n"),
  );
  process.exit(1);
}
console.log("check-built-emoji: no double-escaped emoji in the server build.");
