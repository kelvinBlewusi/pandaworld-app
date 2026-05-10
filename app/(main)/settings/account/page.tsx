"use client";

import { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { Unlink, RefreshCw, Bell, Shield, User, Loader2, Check, Zap, Sparkles, ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { getSubscription } from "@/lib/actions/subscription";
import type { Plan } from "@/lib/types/subscription";

export default function AccountSettingsPage() {
  const { user, isLoaded } = useUser();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [plan, setPlan] = useState<Plan>("free");
  const [storeConn, setStoreConn] = useState<{
    store_name: string | null;
    seller_email: string | null;
    status: string | null;
    connected_at: string | null;
    oauth_required?: boolean;
  } | null>(null);
  const [storesLoading, setStoresLoading] = useState(true);

  // Load subscription plan
  useEffect(() => {
    getSubscription().then((sub) => {
      if (sub?.plan) setPlan(sub.plan as Plan);
    });
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
                {plan === "pro" ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-600">
                    <Zap className="h-2.5 w-2.5" />
                    Pro plan
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold text-zinc-500">
                    <Sparkles className="h-2.5 w-2.5" />
                    Free plan
                  </span>
                )}
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
            <a href="/onboarding/channel">Add store</a>
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
                <a href="/onboarding/channel">Add your first store</a>
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
    </div>
  );
}
