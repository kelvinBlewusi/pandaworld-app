"use client";

/**
 * CategoryDrawer — Jumia-style slide-in panel for category selection.
 *
 * Behaviour (matches the PDF screenshots from Jumia Vendor Center):
 *   - Slides in from the right, full height, ~420px wide on desktop
 *   - Header: "Categories" + close X
 *   - Search bar with magnifying glass
 *   - "Most used categories" section (DISABLED until we have learned data;
 *     hidden entirely per the spec until then)
 *   - "All the categories" section listing top-level categories
 *   - Each row: radio circle on the left + name + chevron-right if it has
 *     children, OR no chevron if it's a leaf
 *   - Clicking a parent drills DOWN one level (replaces the list)
 *   - Header shows breadcrumb of the current level
 *   - Bottom footer with orange "Select Category" button that's disabled
 *     until a leaf is chosen (parents can't be selected per Jumia's rule)
 *
 * The drawer fetches `/api/jumia/categories?all=1` once and works entirely
 * from that flat list using completePath to build the tree.
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import { ChevronLeft, X, Search, Loader2, RefreshCw, AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CategoryRow } from "@/components/ui/category-row";
import { cn } from "@/lib/utils";

interface FlatCategory {
  code:               number;
  name:               string;
  path:               string;          // "Electronics > Headphones > Over-Ear Headphones"
  parent_code:        number | null;
  level:              number;
  is_leaf:            boolean;
  attribute_set_sid?: string | null;
}

export interface SelectedCategory {
  code: number;
  name: string;
  path: string;
}

interface TreeNode {
  segment:      string;                // single segment label e.g. "Headphones"
  fullPath:     string;                // "Electronics > Headphones"
  category:     FlatCategory | null;   // present only when path matches an actual category row
  children:     TreeNode[];
}

// Build a path-based tree from a flat category list. Each segment in a
// completePath becomes a node. A node is "selectable" only when its path
// matches a category row AND that row is a leaf.
function buildTree(categories: FlatCategory[]): TreeNode {
  const root: TreeNode = { segment: "", fullPath: "", category: null, children: [] };

  // Index categories by path for quick lookup
  const byPath = new Map<string, FlatCategory>();
  for (const c of categories) byPath.set(c.path, c);

  for (const cat of categories) {
    const segments = cat.path.split(/\s*>\s*/).filter(Boolean);
    let cursor = root;
    let pathSoFar = "";
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      pathSoFar = pathSoFar ? `${pathSoFar} > ${seg}` : seg;
      let child = cursor.children.find((c) => c.segment === seg);
      if (!child) {
        child = {
          segment:  seg,
          fullPath: pathSoFar,
          category: byPath.get(pathSoFar) ?? null,
          children: [],
        };
        cursor.children.push(child);
      }
      cursor = child;
    }
  }

  // Alphabetise each level for predictable rendering
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => a.segment.localeCompare(b.segment));
    n.children.forEach(sortRec);
  };
  sortRec(root);

  return root;
}

interface CategoryDrawerProps {
  open:          boolean;
  onClose:       () => void;
  onSelect:      (cat: SelectedCategory) => void;
  initialPath?:  string;                       // pre-select this category path
}

export function CategoryDrawer({ open, onClose, onSelect, initialPath }: CategoryDrawerProps) {
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);
  const [refreshMsg,  setRefreshMsg]  = useState<string | null>(null);
  const [rawCategories, setRawCategories] = useState<FlatCategory[]>([]);
  const [query,       setQuery]       = useState("");
  const [stack,       setStack]       = useState<TreeNode[]>([]);     // breadcrumb of drill-down
  const [chosen,      setChosen]      = useState<FlatCategory | null>(null);

  const loadFromCache = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch("/api/jumia/categories?all=1");
      const data = await res.json() as { categories?: FlatCategory[] };
      setRawCategories(data.categories ?? []);

      // Auto-refresh in the background if the cached data is more than
      // 24 hours old. The cached list renders immediately; the next time
      // the drawer opens it'll have fresh data. Non-blocking — failures
      // are silent (the existing manual refresh button is still available).
      const lastSyncedAt = res.headers.get("X-Last-Synced-At");
      if (lastSyncedAt) {
        const ageMs = Date.now() - new Date(lastSyncedAt).getTime();
        const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
        if (Number.isFinite(ageMs) && ageMs > TWENTY_FOUR_HOURS) {
          fetch("/api/jumia/sync-categories", { method: "POST" }).catch(() => {});
        }
      }
    } catch {
      setRawCategories([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch all categories once when the drawer opens for the first time
  useEffect(() => {
    if (!open || rawCategories.length > 0) return;
    loadFromCache();
  }, [open, rawCategories.length, loadFromCache]);

  // Manual refresh — pulls live from Jumia, repopulates Supabase, reloads cache
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const r = await fetch("/api/jumia/sync-categories", { method: "POST" });
      const d = await r.json();
      if (!r.ok) {
        setRefreshMsg(d.error ?? "Refresh failed");
        return;
      }
      await loadFromCache();
      setRefreshMsg(`Updated · ${d.categories ?? "?"} categories from Jumia`);
      setTimeout(() => setRefreshMsg(null), 3000);
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }, [loadFromCache]);

  // Reset selection + drill state when drawer opens
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setChosen(null);
    setStack([]);
  }, [open]);

  const tree = useMemo(() => buildTree(rawCategories), [rawCategories]);

  // Current view = root if stack is empty, else last node on stack
  const currentNode = stack.length === 0 ? tree : stack[stack.length - 1];

  // Search across the whole flat list. Returns true LEAVES with a
  // schema — categories the seller can actually SELECT. VC's behaviour:
  // parents must be drilled into, so showing them in search would be
  // misleading. is_leaf is computed at sync time from breadcrumb paths;
  // attribute_set_sid != null confirms Jumia accepts listings here.
  const searchResults = useMemo(() => {
    if (!query.trim()) return null;
    const q = query.toLowerCase();
    return rawCategories
      .filter((c) => c.is_leaf && c.attribute_set_sid != null)
      .filter((c) => c.name.toLowerCase().includes(q) || c.path.toLowerCase().includes(q))
      .slice(0, 50);
  }, [query, rawCategories]);

  // Drill INTO a node (body click + chevron). Always allowed when the
  // node has children, regardless of whether the node itself is listable.
  const handleDrillIn = (node: TreeNode) => {
    setStack((s) => [...s, node]);
    setChosen(null);
  };

  // SELECT a node (radio click). The CategoryRow only fires this when
  // the row is listable — so we just trust the signal here.
  const handleSelectNode = (node: TreeNode) => {
    if (node.category) setChosen(node.category);
  };

  const handleSearchSelect = (cat: FlatCategory) => {
    setChosen(cat);
  };

  const handleBack = () => {
    setStack((s) => s.slice(0, -1));
    setChosen(null);
  };

  // Keyboard support — Esc closes the drawer, Backspace pops one level
  // (when focus is inside the drawer, NOT inside the search input where
  // Backspace is used to delete characters).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Backspace") {
        const target = e.target as HTMLElement | null;
        const isTyping =
          target?.tagName === "INPUT" ||
          target?.tagName === "TEXTAREA" ||
          target?.isContentEditable;
        if (!isTyping && stack.length > 0) {
          e.preventDefault();
          handleBack();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, stack.length, onClose]);

  // Stale-rehydrate detection: if the seller previously saved a category
  // whose listability has since flipped (Jumia removed the attributeSet),
  // we need to surface that. Computed once data is loaded.
  const rehydrateWarning = useMemo(() => {
    if (!initialPath || rawCategories.length === 0) return null;
    const match = rawCategories.find((c) => c.path === initialPath);
    if (!match) return null;
    if (match.attribute_set_sid != null) return null;
    return `"${match.name}" is no longer accepting listings on Jumia — please pick another category.`;
  }, [initialPath, rawCategories]);

  const handleConfirm = () => {
    if (!chosen) return;
    onSelect({ code: chosen.code, name: chosen.name, path: chosen.path });
    onClose();
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity",
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onClick={onClose}
      />

      {/* Drawer */}
      <aside
        className={cn(
          "fixed top-0 right-0 z-50 h-screen w-full max-w-[420px] bg-white shadow-2xl flex flex-col transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "translate-x-full"
        )}
      >
        {/* Header */}
        <header className="flex items-center justify-between border-b px-5 py-4 shrink-0">
          {stack.length > 0 ? (
            <button
              type="button"
              onClick={handleBack}
              className="flex items-center gap-2 text-sm font-semibold text-zinc-700 hover:text-zinc-900"
            >
              <ChevronLeft className="h-4 w-4" />
              <span className="truncate">
                {currentNode.segment}
              </span>
            </button>
          ) : (
            <h2 className="text-base font-semibold text-zinc-900">Categories</h2>
          )}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50"
              title="Refresh categories from Jumia"
              aria-label="Refresh from Jumia"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
              aria-label="Close drawer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>
        {refreshMsg && (
          <div className="px-5 py-1.5 bg-violet-50 text-[11px] text-violet-700 border-b border-violet-100 shrink-0">
            {refreshMsg}
          </div>
        )}

        {/* Search */}
        <div className="border-b px-5 py-3 shrink-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <Input
              autoFocus={open}
              placeholder="Search for a category"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9 h-10 bg-zinc-50 border-zinc-200"
            />
          </div>
        </div>

        {/* Stale-rehydrate warning: the previously-saved category lost
            its attributeSet on Jumia's side (no longer accepting
            listings). Surface this so the seller picks another. */}
        {rehydrateWarning && (
          <div className="flex items-start gap-2 px-5 py-2 border-b bg-amber-50 text-[11px] text-amber-800 shrink-0">
            <AlertCircle className="h-3 w-3 shrink-0 mt-0.5 text-amber-500" />
            <span className="break-words">{rehydrateWarning}</span>
          </div>
        )}

        {/* Breadcrumb path under search when drilled down */}
        {stack.length > 0 && !query && (
          <div className="px-5 py-2 border-b text-[11px] text-zinc-500 shrink-0 truncate">
            {currentNode.fullPath}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-zinc-400">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              <span className="text-sm">Loading categories…</span>
            </div>
          ) : rawCategories.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-zinc-400 space-y-1">
              <p>No categories synced yet.</p>
              <p className="text-xs">Settings → Integrations → Sync categories.</p>
            </div>
          ) : query ? (
            // Search results — flat list of leaf categories
            <SearchResults
              results={searchResults ?? []}
              chosen={chosen}
              onSelect={handleSearchSelect}
              initialPath={initialPath}
            />
          ) : (
            // Drill-down tree view
            <TreeView
              node={currentNode}
              chosen={chosen}
              onDrillIn={handleDrillIn}
              onSelect={handleSelectNode}
              showHeader={stack.length === 0}
              initialPath={initialPath}
            />
          )}
        </div>

        {/* Footer */}
        <footer className="border-t bg-white px-5 py-3 shrink-0">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-zinc-500 truncate">
              {chosen
                ? <><span className="font-semibold text-zinc-700">Selected:</span> {chosen.path}</>
                : "Pick a leaf category to continue"}
            </p>
            <Button
              type="button"
              size="sm"
              disabled={!chosen}
              onClick={handleConfirm}
              className="bg-orange-500 hover:bg-orange-600 text-white disabled:bg-zinc-200 disabled:text-zinc-400 shrink-0"
            >
              Select Category
            </Button>
          </div>
        </footer>
      </aside>
    </>
  );
}

// ─── Drill-down tree view ────────────────────────────────────────────────────

function TreeView({
  node,
  chosen,
  onDrillIn,
  onSelect,
  showHeader,
  initialPath,
}: {
  node:         TreeNode;
  chosen:       FlatCategory | null;
  onDrillIn:    (n: TreeNode) => void;
  onSelect:     (n: TreeNode) => void;
  showHeader:   boolean;
  initialPath?: string;
}) {
  // Visible children: hide pure tree-only nodes that have no children
  // either (downgrade-pass leftovers). A non-listable node with children
  // is still useful for navigation; we keep those.
  const visibleChildren = node.children.filter((c) => {
    const isListable  = c.category?.attribute_set_sid != null;
    const hasChildren = c.children.length > 0;
    return isListable || hasChildren;
  });

  return (
    <div>
      {showHeader && (
        <p className="px-5 pt-4 pb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          All the categories
        </p>
      )}
      <ul className="divide-y divide-zinc-100">
        {visibleChildren.map((child) => {
          const hasChildren = child.children.length > 0;
          // VC rule: parents are NEVER directly selectable. Leaves are
          // selectable iff Jumia returned an attributeSet for them
          // (their schema is real and a listing can actually go there).
          const isSelectable = !hasChildren && child.category?.attribute_set_sid != null;
          const isSelected   =
            (chosen != null && child.category != null && chosen.code === child.category.code) ||
            (chosen == null && initialPath != null && child.fullPath === initialPath);
          return (
            <CategoryRow
              key={child.fullPath}
              label={child.segment}
              hasChildren={hasChildren}
              isSelectable={isSelectable}
              isSelected={isSelected}
              onDrillIn={() => onDrillIn(child)}
              onSelect={() => onSelect(child)}
            />
          );
        })}
        {visibleChildren.length === 0 && (
          <li className="px-5 py-10 text-center text-sm text-zinc-400">
            No subcategories.
          </li>
        )}
      </ul>
    </div>
  );
}

// ─── Search results view ─────────────────────────────────────────────────────

function SearchResults({
  results,
  chosen,
  onSelect,
  initialPath,
}: {
  results:      FlatCategory[];
  chosen:       FlatCategory | null;
  onSelect:     (c: FlatCategory) => void;
  initialPath?: string;
}) {
  if (results.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-sm text-zinc-400">
        No categories match that search.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-zinc-100">
      {results.map((cat) => {
        // All search results are listable (filtered upstream by
        // attribute_set_sid). Search is a flat list — no drill-in.
        const isSelected =
          (chosen != null && chosen.code === cat.code) ||
          (chosen == null && initialPath === cat.path);
        return (
          <CategoryRow
            key={cat.code}
            label={cat.name}
            subLabel={cat.path}
            hasChildren={false}
            isSelectable={true}
            isSelected={isSelected}
            onDrillIn={() => onSelect(cat)}  // No-op for search; body click selects via !hasChildren path
            onSelect={() => onSelect(cat)}
          />
        );
      })}
    </ul>
  );
}
