"use client";

/**
 * CategoryDeck: the editor's category drawer (components/ui/category-drawer.tsx)
 * as a panel on its own, for the public category picker (/categories) and
 * the web chat's category question (owner, 2026-10-10: "the users can
 * navigate the category deck just as we have it in the review page ... the
 * orange Select Category button changes to Copy Category").
 *
 * The same tree, rows and search as the drawer. On top of it:
 *   - It opens on a category (the one the AI chose that Jumia refused),
 *     already selected, inside its parent.
 *   - "You can't list in this category": the black banner, for that
 *     category and for any Jumia has refused in the seller's country; its
 *     button stays off.
 *   - A note that a similar product on Jumia's own site shows its category.
 *   - The button copies the path ("Automobile > Car Care > Cleaning Kits"),
 *     or picks the category, whichever the page asks for.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, Copy, ExternalLink, Loader2, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { CategoryRow } from "@/components/ui/category-row";
import { buildTree, normaliseCategoryPath, type FlatCategory, type TreeNode } from "@/components/ui/category-drawer";
import { cn } from "@/lib/utils";

export interface DeckPick { code: number; name: string; path: string }

interface CategoryDeckProps {
  /** Two letters: what Jumia refused there, and its storefront for the note. */
  country?:      string | null;
  /** Open on this category, selected. */
  initialCode?:  number | null;
  /** A category Jumia refused for this product: the black banner when it's selected. */
  rejectedCode?: number | null;
  /** "copy" copies the path; "select" hands the category back. */
  mode:          "copy" | "select";
  onSelect?:     (pick: DeckPick) => void;
  onClose?:      () => void;
  /** Inside a chat message: a fixed height, no outer frame of its own. */
  compact?:      boolean;
  className?:    string;
}

const STOREFRONT: Record<string, string> = {
  GH: "jumia.com.gh", NG: "jumia.com.ng", KE: "jumia.co.ke", UG: "jumia.ug", EG: "jumia.com.eg", MA: "jumia.ma", CI: "jumia.ci", SN: "jumia.sn",
};

/** The stack of tree nodes down to the parent of the category at `path`. */
function stackTo(root: TreeNode, path: string): TreeNode[] {
  const segments = normaliseCategoryPath(path).split(" > ").filter(Boolean);
  const stack: TreeNode[] = [];
  let cursor = root;
  for (const seg of segments.slice(0, -1)) {
    const next = cursor.children.find((c) => c.segment === seg);
    if (!next) break;
    stack.push(next);
    cursor = next;
  }
  return stack;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  }
}

export function CategoryDeck({ country, initialCode, rejectedCode, mode, onSelect, onClose, compact, className }: CategoryDeckProps) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [rows, setRows] = useState<FlatCategory[]>([]);
  const [blocked, setBlocked] = useState<Set<number>>(new Set());
  const [proven, setProven] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [stack, setStack] = useState<TreeNode[]>([]);
  const [chosen, setChosen] = useState<FlatCategory | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/categories${country ? `?country=${encodeURIComponent(country)}` : ""}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { categories?: FlatCategory[]; blocked?: number[]; proven?: number[] }) => {
        if (!live) return;
        setRows(d.categories ?? []);
        setBlocked(new Set(d.blocked ?? []));
        setProven(new Set(d.proven ?? []));
      })
      .catch(() => live && setFailed(true))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [country]);

  const tree = useMemo(() => buildTree(rows), [rows]);

  // Open on the category it starts with, selected, inside its parent.
  useEffect(() => {
    if (rows.length === 0 || !initialCode) return;
    const start = rows.find((c) => c.code === initialCode);
    if (!start) return;
    setStack(stackTo(tree, start.path));
    setChosen(start);
  }, [rows, tree, initialCode]);

  const current = stack.length === 0 ? tree : stack[stack.length - 1];
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return rows
      .filter((c) => c.is_leaf && c.attribute_set_sid != null)
      .filter((c) => c.name.toLowerCase().includes(q) || c.path.toLowerCase().includes(q))
      .slice(0, 50);
  }, [query, rows]);

  const refused = chosen != null && (chosen.code === rejectedCode || blocked.has(chosen.code));
  const path = chosen ? normaliseCategoryPath(chosen.path) : "";
  const store = STOREFRONT[(country ?? "").toUpperCase()] ?? "jumia.com";
  const countryName = { GH: "Ghana", NG: "Nigeria", KE: "Kenya", UG: "Uganda", EG: "Egypt", MA: "Morocco", CI: "Ivory Coast", SN: "Senegal" }[(country ?? "").toUpperCase()];

  async function act() {
    if (!chosen || refused) return;
    if (mode === "copy") {
      if (await copyText(path)) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }
      return;
    }
    onSelect?.({ code: chosen.code, name: chosen.name, path: chosen.path });
  }

  const visible = current.children.filter((c) => c.category?.attribute_set_sid != null || c.children.length > 0);

  return (
    <div className={cn("flex flex-col overflow-hidden bg-white", compact ? "h-[440px]" : "h-full", className)}>
      <header className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
        {stack.length > 0 && !query ? (
          <button type="button" onClick={() => { setStack((s) => s.slice(0, -1)); setChosen(null); }} className="flex min-w-0 items-center gap-2 text-sm font-semibold text-zinc-800 hover:text-zinc-950">
            <ChevronLeft className="h-4 w-4 shrink-0" />
            <span className="truncate">{current.segment}</span>
          </button>
        ) : (
          <h2 className="text-sm font-semibold text-zinc-900">Categories</h2>
        )}
        <button
          type="button"
          onClick={() => (onClose ? onClose() : (setStack([]), setQuery(""), setChosen(null)))}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700"
          aria-label={onClose ? "Close categories" : "Back to all categories"}
        >
          <X className="h-5 w-5" />
        </button>
      </header>

      <div className="shrink-0 border-b px-4 py-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <Input placeholder="Search for a category" value={query} onChange={(e) => setQuery(e.target.value)} className="h-10 border-zinc-200 bg-zinc-50 pl-9" />
        </div>
        <p className="mt-2 text-[11px] leading-snug text-zinc-500">
          You can also get the category from a similar product on{" "}
          <a href={`https://www.${store}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-medium text-orange-600 hover:underline">
            www.{store} <ExternalLink className="h-3 w-3" />
          </a>
          : its path is at the top of the product&apos;s page.
        </p>
      </div>

      {stack.length > 0 && !query && (
        <div className="shrink-0 truncate border-b px-4 py-2 text-[11px] text-zinc-500">{current.fullPath}</div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {loading ? (
          <div className="flex items-center justify-center py-10 text-sm text-zinc-400"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading categories…</div>
        ) : failed || rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-zinc-500">The categories didn&apos;t load. Refresh the page to try again.</p>
        ) : results ? (
          results.length === 0 ? <p className="px-5 py-10 text-center text-sm text-zinc-400">No categories match that search.</p> : (
            <ul className="divide-y divide-zinc-100">
              {results.map((c) => (
                <CategoryRow key={c.code} label={c.name} subLabel={normaliseCategoryPath(c.path)} hasChildren={false} isSelectable
                  isSelected={chosen?.code === c.code} onDrillIn={() => setChosen(c)} onSelect={() => setChosen(c)} />
              ))}
            </ul>
          )
        ) : (
          <ul className="divide-y divide-zinc-100">
            {visible.map((n) => {
              const hasChildren = n.children.length > 0;
              return (
                <CategoryRow
                  key={n.fullPath}
                  label={n.segment}
                  hasChildren={hasChildren}
                  isSelectable={!hasChildren && n.category?.attribute_set_sid != null}
                  isSelected={chosen != null && n.category?.code === chosen.code}
                  onDrillIn={() => { setStack((s) => [...s, n]); setChosen(null); }}
                  onSelect={() => n.category && setChosen(n.category)}
                />
              );
            })}
          </ul>
        )}
      </div>

      {refused && (
        // Jumia's own wording, as Vendor Center shows it.
        <div className="shrink-0 bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white">
          You can&apos;t list products in this category{countryName ? ` in ${countryName}` : ""}. Choose a different (more specific) one.
        </div>
      )}

      <footer className="shrink-0 border-t bg-white px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <p className="mb-2 line-clamp-2 text-xs leading-snug text-zinc-500">
          {chosen ? <><span className="font-semibold text-zinc-800">Selected:</span> {path}</> : "Open the categories until you reach one without an arrow, then tap it."}
        </p>
        {chosen && !refused && proven.has(chosen.code) && (
          <p className="-mt-1 mb-2 text-[11px] font-medium text-emerald-700">✓ Products have gone live in this category{countryName ? ` in ${countryName}` : ""}.</p>
        )}
        <button
          type="button"
          disabled={!chosen || refused}
          onClick={() => void act()}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-orange-500 text-base font-semibold text-white transition-colors hover:bg-orange-600 disabled:opacity-40"
        >
          {mode === "copy" ? (copied ? <><Check className="h-5 w-5" /> Copied</> : <><Copy className="h-5 w-5" /> Copy category</>) : "Select category"}
        </button>
        {mode === "copy" && copied && (
          <p className="mt-2 text-center text-xs text-zinc-500">Now paste it in your chat with PandaWorld (WhatsApp or the website).</p>
        )}
      </footer>
    </div>
  );
}
