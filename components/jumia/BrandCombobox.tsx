"use client";

/**
 * BrandCombobox — type-ahead lookup against Jumia's official brand catalog.
 *
 * Jumia REJECTS listings whose `brand` value isn't an exact match for an
 * entry in their brand catalog. Free-text input invites failure: an AI
 * outputting "Sony" when Jumia's catalog has "Sony Mobile" will get the
 * listing bounced. This component forces the seller to PICK from the
 * official list (debounced search against /api/jumia/brands), so the value
 * stored is always one Jumia knows.
 *
 * Typing without selecting is still allowed — sellers occasionally need a
 * brand Jumia hasn't catalogued yet — but the dropdown nudges them toward
 * the validated option whenever there's a match.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";

interface BrandComboboxProps {
  value:        string;
  onChange:     (v: string) => void;
  placeholder?: string;
}

export function BrandCombobox({
  value,
  onChange,
  placeholder = "Brand",
}: BrandComboboxProps) {
  const [query,   setQuery]   = useState(value);
  const [results, setResults] = useState<{ code: number; name: string }[]>([]);
  const [open,    setOpen]    = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setQuery(value); }, [value]);

  const search = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) { setResults([]); setOpen(false); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res  = await fetch(`/api/jumia/brands?q=${encodeURIComponent(q)}`);
        const data = await res.json() as { brands: { code: number; name: string }[] };
        setResults(data.brands ?? []);
        setOpen(true);
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 300);
  }, []);

  return (
    <div className="relative">
      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value);
          search(e.target.value);
        }}
        onFocus={() => { if (query.trim()) search(query); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        className="h-10 text-sm"
      />
      {loading && (
        <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-zinc-400" />
      )}
      {open && results.length > 0 && (
        <div className="absolute z-10 w-full mt-1 rounded-md border bg-white shadow-lg max-h-48 overflow-y-auto">
          {results.map((b) => (
            <button
              key={b.code}
              type="button"
              className="w-full px-3 py-2 text-left text-sm hover:bg-orange-50 border-b last:border-b-0"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(b.name);
                setQuery(b.name);
                setOpen(false);
              }}
            >
              {b.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
