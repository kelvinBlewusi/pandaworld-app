import { Upload } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function ImportsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900">Imports</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Bulk-import listings from a CSV spreadsheet.
        </p>
      </div>
      <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed bg-zinc-50 py-24 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100">
          <Upload className="h-6 w-6 text-zinc-400" />
        </div>
        <div>
          <p className="font-semibold text-zinc-700">Bulk CSV import</p>
          <p className="mt-1 text-sm text-zinc-400 max-w-sm">
            Upload a Jumia-compatible spreadsheet to create or update multiple
            listings at once. Coming in Phase 2.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/listings/new">Create a single listing instead</Link>
        </Button>
      </div>
    </div>
  );
}
