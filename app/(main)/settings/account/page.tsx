"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser, useClerk } from "@clerk/nextjs";
import { Unlink, RefreshCw, Bell, Shield, User, Loader2, Check, ShoppingBag, AlertTriangle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { getMyCredits, type MyCredits } from "@/lib/actions/credits";
import { CreditsBadge } from "@/components/billing/credits-badge";

export default function AccountSettingsPage() {
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();
  const router = useRouter();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [credits, setCredits] = useState<MyCredits | null>(null);

  // Danger-zone state — surfaced at the bottom of the page.
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirm,   setDeleteConfirm]   = useState("");
  const [deleting,        setDeleting]        = useState(false);
  const [deleteError,     setDeleteError]     = useState<string | null>(null);

  async function handleDeleteAccount() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch("/api/account/delete", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ confirm: "DELETE" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDeleteError(data.error ?? "Couldn't delete the account. Please contact support.");
        return;
      }
      // Sign out from Clerk's session (the server already deleted the
      // user, this just clears the local session cookie so we can
      // redirect home cleanly).
      await signOut(() => router.push("/"));
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setDeleting(false);
    }
  }
  const [storeConn, setStoreConn] = useState<{
    store_name: string | null;
    seller_email: string | null;
    status: string | null;
    connected_at: string | null;
    oauth_required?: boolean;
  } | null>(null);
  const [storesLoading, setStoresLoading] = useState(true);

  useEffect(() => {
    getMyCredits().then(setCredits);
  }, []);

  // Load connected store via authenticated API route
  useEffect(() => {
    fetch("/api/jumia/status")
      .then((r) => r.json())
      .then((d) => {
        // Only show if there's actually a connection record
        if (d.status) setStoreConn(d);
      })
      .catch(() => {})
      .finally(() => setStoresLoading(false));
  }, []);

  // Populate inputs once Clerk loads
  const firstNameValue = isLoaded && firstName === "" && !saving
    ? (user?.firstName ?? "")
    : firstName;
  const lastNameValue = isLoaded && lastName === "" && !saving
    ? (user?.lastName ?? "")
    : lastName;

  const [notifications, setNotifications] = useState({
    listingApproved: true,
    listingFailed: true,
    newFeatures: true,
  });

  async function handleSaveProfile() {
    if (!user) return;
    setSaving(true);
    setSaved(false);
    try {
      await user.update({ firstName: firstNameValue, lastName: lastNameValue });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  }

  // Derive display values
  const displayName = isLoaded
    ? [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.username || "—"
    : "…";
  const displayEmail = isLoaded
    ? user?.primaryEmailAddress?.emailAddress ?? "—"
    : "…";
  const initials = isLoaded
    ? (user?.firstName?.[0] ?? user?.username?.[0] ?? "?").toUpperCase()
    : "?";
  const memberSince = isLoaded && user?.createdAt
    ? new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" }).format(
        new Date(user.createdAt)
      )
    : null;

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900">Account settings</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Manage your profile, connected stores, and preferences.
        </p>
      </div>

      {/* Profile */}
      <section className="rounded-2xl border bg-white p-6 shadow-sm space-y-5">
        <div className="flex items-center gap-3">
          <User className="h-4 w-4 text-zinc-400" />
          <h2 className="text-sm font-semibold text-zinc-700">Profile</h2>
        </div>
        <Separator />
        <div className="flex items-center gap-4">
          {isLoaded && user?.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.imageUrl}
              alt={displayName}
              className="h-16 w-16 rounded-full object-cover shadow-sm"
            />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-orange-400 to-pink-500 text-2xl font-bold text-white shadow-sm">
              {initials}
            </div>
          )}
          <div>
            <p className="font-semibold text-zinc-800">{displayName}</p>
            <p className="text-sm text-zinc-400">{displayEmail}</p>
            {memberSince && (
              <p className="mt-0.5 text-xs text-zinc-400 flex items-center gap-1.5">
                {credits && <CreditsBadge credits={credits} size="sm" />}
                <span>· Member since {memberSince}</span>
              </p>
            )}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>First name</Label>
            <Input
              value={firstNameValue}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="First name"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Last name</Label>
            <Input
              value={lastNameValue}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Last name"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input
              defaultValue={displayEmail}
              type="email"
              disabled
              className="opacity-60 cursor-not-allowed"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Country</Label>
            <Input defaultValue="Ghana" />
          </div>
        </div>
        <Button onClick={handleSaveProfile} disabled={saving || !isLoaded} className="gap-2">
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : saved ? (
            <Check className="h-4 w-4" />
          ) : null}
          {saving ? "Saving…" : saved ? "Saved!" : "Save profile"}
        </Button>
      </section>

      {/* Connected stores */}
      <section className="rounded-2xl border bg-white p-6 shadow-sm space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className="h-4 w-4 text-zinc-400" />
            <h2 className="text-sm font-semibold text-zinc-700">Connected stores</h2>
          </div>
          <Button variant="outline" size="sm" asChild>
            <a href="/onboarding/connect">Add store</a>
          </Button>
        </div>
        <Separator />
        <div className="space-y-3">
          {storesLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading stores…
            </div>
          ) : !storeConn ? (
            <div className="rounded-xl border border-dashed p-6 text-center">
              <ShoppingBag className="mx-auto mb-2 h-8 w-8 text-zinc-300" />
              <p className="text-sm font-medium text-zinc-500">No stores connected yet</p>
              <p className="mt-0.5 text-xs text-zinc-400">Connect your first store to start publishing listings</p>
              <Button asChild size="sm" className="mt-4">
                <a href="/onboarding/connect">Add your first store</a>
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-4 rounded-xl border p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-orange-400 to-pink-500 text-base shrink-0">
                🛒
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-800 truncate">
                  {storeConn.store_name ?? "Jumia Store"}
                </p>
                <p className="text-xs text-zinc-400 truncate">{storeConn.seller_email ?? ""}</p>
                {storeConn.connected_at && (
                  <p className="text-xs text-zinc-400">
                    Connected {new Date(storeConn.connected_at).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-medium",
                  storeConn.oauth_required
                    ? "bg-blue-50 text-blue-600"
                    : storeConn.status === "active"
                    ? "bg-emerald-50 text-emerald-600"
                    : "bg-red-50 text-red-500"
                )}>
                  {storeConn.oauth_required ? "Authorise" : storeConn.status === "active" ? "Connected" : "Expired"}
                </span>
                {storeConn.oauth_required ? (
                  <Button variant="outline" size="sm" className="gap-1 h-7 text-xs" asChild>
                    <a href="/api/jumia/connect">
                      <RefreshCw className="h-3 w-3" />
                      Authorise
                    </a>
                  </Button>
                ) : storeConn.status !== "active" ? (
                  <Button variant="outline" size="sm" className="gap-1 h-7 text-xs" asChild>
                    <a href="/settings/integrations">
                      <RefreshCw className="h-3 w-3" />
                      Reconnect
                    </a>
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" className="gap-1 h-7 text-xs text-red-400 hover:text-red-600" asChild>
                    <a href="/settings/integrations">
                      <Unlink className="h-3 w-3" />
                      Manage
                    </a>
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Notifications */}
      <section className="rounded-2xl border bg-white p-6 shadow-sm space-y-5">
        <div className="flex items-center gap-3">
          <Bell className="h-4 w-4 text-zinc-400" />
          <h2 className="text-sm font-semibold text-zinc-700">Notifications</h2>
        </div>
        <Separator />
        <div className="space-y-4">
          {[
            {
              key: "listingApproved" as const,
              label: "Listing approved",
              desc: "When Jumia approves one of your listings",
            },
            {
              key: "listingFailed" as const,
              label: "Listing failed",
              desc: "When a listing fails review or publishing",
            },
            {
              key: "newFeatures" as const,
              label: "New PandaWorld features",
              desc: "Product updates and new capabilities",
            },
          ].map((item) => (
            <div key={item.key} className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-zinc-800">{item.label}</p>
                <p className="text-xs text-zinc-400">{item.desc}</p>
              </div>
              <Switch
                checked={notifications[item.key]}
                onCheckedChange={(v) =>
                  setNotifications((n) => ({ ...n, [item.key]: v }))
                }
              />
            </div>
          ))}
        </div>
      </section>

      {/* Danger zone — account deletion (right-to-erasure under
          Ghana DPA 2012 + GDPR Article 17). Hard delete: revokes
          Jumia tokens, cancels Paystack sub, wipes storage + DB rows,
          deletes the Clerk user. No undo. */}
      <section className="rounded-2xl border border-red-200 bg-red-50/40 p-6 shadow-sm space-y-5">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-4 w-4 text-red-500" />
          <h2 className="text-sm font-semibold text-red-700">Danger zone</h2>
        </div>
        <Separator className="bg-red-200" />
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-zinc-800">Delete account</p>
            <p className="mt-1 text-xs text-zinc-500 leading-relaxed">
              Permanently remove your account, listings, images, and Jumia
              connection, and any unused credits. This cannot be undone.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setDeleteConfirm("");
              setDeleteError(null);
              setShowDeleteModal(true);
            }}
            className="shrink-0 border-red-200 text-red-600 hover:bg-red-100 hover:text-red-700 gap-1.5"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete account
          </Button>
        </div>
      </section>

      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-bold text-zinc-900">Delete your account?</h3>
                <p className="mt-2 text-xs text-zinc-600 leading-relaxed">
                  This will permanently delete your profile, all listings,
                  product images, Jumia connection and any unused credits.
                  <strong> This cannot be undone.</strong>
                </p>
              </div>
            </div>

            <div className="mt-5 space-y-2">
              <Label htmlFor="delete-confirm" className="text-xs">
                Type <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px]">DELETE</code> to confirm:
              </Label>
              <Input
                id="delete-confirm"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder="DELETE"
                disabled={deleting}
                className="font-mono"
              />
            </div>

            {deleteError && (
              <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">
                {deleteError}
              </p>
            )}

            <div className="mt-6 flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowDeleteModal(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleDeleteAccount}
                disabled={deleting || deleteConfirm !== "DELETE"}
                className="bg-red-600 hover:bg-red-700 text-white gap-1.5"
              >
                {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {deleting ? "Deleting…" : "Delete account"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
