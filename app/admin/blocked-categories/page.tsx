import { createServerClient } from "@/lib/supabase/server";
import { unblockCategoryAction } from "./actions";

export const dynamic = "force-dynamic";

interface BlockedRow {
  country:         string;
  category_code:   number;
  rejection_count: number;
  last_error:      string | null;
  first_seen_at:   string;
  last_seen_at:    string;
}

interface CategoryInfo {
  code: number;
  name: string;
  path: string | null;
}

async function blockedCategories(): Promise<{ rows: BlockedRow[]; categories: Map<number, CategoryInfo> }> {
  const db = createServerClient();
  const { data } = await db
    .from("jumia_unlistable_categories")
    .select("*")
    .order("country")
    .order("last_seen_at", { ascending: false });
  const rows = (data ?? []) as BlockedRow[];

  const codes = Array.from(new Set(rows.map((r) => r.category_code)));
  const categories = new Map<number, CategoryInfo>();
  if (codes.length > 0) {
    const { data: cats } = await db.from("jumia_categories").select("code, name, path").in("code", codes);
    for (const c of (cats ?? []) as CategoryInfo[]) categories.set(Number(c.code), c);
  }
  return { rows, categories };
}

export default async function AdminBlockedCategoriesPage() {
  const { rows, categories } = await blockedCategories();

  return (
    <div>
      <h1 className="text-lg font-bold">Blocked categories</h1>
      <p className="mt-1 max-w-3xl text-sm text-zinc-500">
        Categories Jumia rejected with &ldquo;You can&apos;t list products in this category&rdquo;, per seller
        country. The AI never picks these for sellers in that country, and a redraft steers around them.
        One rejection is enough to block. Unblocking takes effect on the next draft. If Jumia still
        refuses the category, the next rejection blocks it again.
      </p>

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-500">Nothing blocked.</p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">Country</th>
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="px-3 py-2 font-medium">Rejections</th>
                <th className="px-3 py-2 font-medium">Last rejected</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((r) => {
                const cat = categories.get(Number(r.category_code));
                return (
                  <tr key={`${r.country}-${r.category_code}`} className="align-top">
                    <td className="px-3 py-2 font-medium">{r.country}</td>
                    <td className="px-3 py-2">
                      <div className="text-zinc-900">{cat?.name ?? "Unknown category"}</div>
                      <div className="text-xs text-zinc-400">
                        {r.category_code}
                        {cat?.path ? ` · ${cat.path}` : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{r.rejection_count}</td>
                    <td className="px-3 py-2 text-xs text-zinc-500">{new Date(r.last_seen_at).toLocaleString()}</td>
                    <td className="px-3 py-2 text-right">
                      <form action={unblockCategoryAction}>
                        <input type="hidden" name="country" value={r.country} />
                        <input type="hidden" name="category_code" value={r.category_code} />
                        <button
                          type="submit"
                          className="rounded-full border border-zinc-300 px-3 py-1 text-xs text-zinc-700 hover:border-zinc-900 hover:text-zinc-900"
                        >
                          Unblock
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
