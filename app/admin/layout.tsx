import { auth } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { isAdmin } from "@/lib/auth/is-admin";

// ─── /admin — staff-only, not a customer-facing area ─────────────────────────
//
// Gated the same way the existing /admin/brands and /admin/categories
// pages already are (app/(main)/admin/*) — redirect signed-out visitors
// to sign in, then 404 (not a permission error) for anyone signed in who
// isn't on the ADMIN_USER_IDS allow-list, so the existence of the admin
// surface isn't leaked. This is a SEPARATE route tree from
// app/(main)/admin (outside the (main) route group, so it renders
// without that group's own nav/shell) — the URLs don't collide since
// this only adds /admin, /admin/messages, /admin/errors,
// /admin/blocked-categories, /admin/billing, none of which
// app/(main)/admin/* already serves.

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");
  if (!isAdmin(userId)) notFound();

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-4">
          <span className="text-sm font-bold">PandaWorld admin</span>
          <nav className="flex gap-4 text-sm text-zinc-600">
            <Link href="/admin/messages" className="hover:text-zinc-900">WhatsApp messages</Link>
            <Link href="/admin/errors" className="hover:text-zinc-900">Errors</Link>
            <Link href="/admin/blocked-categories" className="hover:text-zinc-900">Blocked categories</Link>
            <Link href="/admin/auto-fix" className="hover:text-zinc-900">Auto-fix</Link>
            <Link href="/admin/billing" className="hover:text-zinc-900">Billing</Link>
            <Link href="/admin/brands" className="hover:text-zinc-900">Brands sync</Link>
            <Link href="/admin/categories" className="hover:text-zinc-900">Categories sync</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
