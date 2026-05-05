"use client";

import { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { Unlink, RefreshCw, Bell, Shield, User, Loader2, Check, Zap, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { mockStores } from "@/lib/mock/stores";
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

  // Load subscription plan
  useEffect(() => {
    getSubscription().then((sub) => {
      if (sub?.plan) setPlan(sub.plan as Plan);
    });
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
    weeklyReport: false,
    newFeatures: true,
  });

  const [warranty, setWarranty] = useState({
    defaultMonths: "12",
    type: "Seller warranty",
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
          {mockStores.map((store) => (
            <div
              key={store.id}
              className="flex items-center gap-4 rounded-xl border p-4"
            >
              <div
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br text-base shrink-0",
                  store.avatarColor
                )}
              >
                🛒
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-800 truncate">
                  {store.storeName}
                </p>
                <p className="text-xs text-zinc-400 truncate">{store.email}</p>
                <p className="text-xs text-zinc-400">
                  {store.listingsCount} listings · Connected {store.connectedAt}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs font-medium",
                    store.status === "connected"
                      ? "bg-emerald-50 text-emerald-600"
                      : "bg-red-50 text-red-500"
                  )}
                >
                  {store.status === "connected" ? "Connected" : "Expired"}
                </span>
                {store.status === "expired" ? (
                  <Button variant="outline" size="sm" className="gap-1 h-7 text-xs">
                    <RefreshCw className="h-3 w-3" />
                    Reconnect
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1 h-7 text-xs text-red-400 hover:text-red-600"
                  >
                    <Unlink className="h-3 w-3" />
                    Disconnect
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Default warranty */}
      <section className="rounded-2xl border bg-white p-6 shadow-sm space-y-5">
        <div className="flex items-center gap-3">
          <Shield className="h-4 w-4 text-zinc-400" />
          <h2 className="text-sm font-semibold text-zinc-700">Default warranty preferences</h2>
        </div>
        <Separator />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Default warranty period (months)</Label>
            <Input
              type="number"
              value={warranty.defaultMonths}
              onChange={(e) =>
                setWarranty((w) => ({ ...w, defaultMonths: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>Default warranty type</Label>
            <Input
              value={warranty.type}
              onChange={(e) =>
                setWarranty((w) => ({ ...w, type: e.target.value }))
              }
            />
          </div>
        </div>
        <p className="text-xs text-zinc-400">
          These defaults are pre-filled when you create a new listing.
        </p>
        <Button>Save defaults</Button>
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
              key: "weeklyReport" as const,
              label: "Weekly performance report",
              desc: "Summary of your listings and earnings every Monday",
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
