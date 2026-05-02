"use client";

import { useState } from "react";
import { MoreHorizontal, ExternalLink } from "lucide-react";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusPill } from "@/components/ui/status-pill";
import { MarketplaceBadge } from "@/components/ui/marketplace-badge";
import { formatGHS, formatDate } from "@/lib/utils";
import type { Listing } from "@/lib/mock/listings";

interface ListingTableProps {
  listings: Listing[];
  compact?: boolean;
}

export function ListingTable({ listings, compact = false }: ListingTableProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleAll = () => {
    if (selected.size === listings.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(listings.map((l) => l.id)));
    }
  };

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const allSelected = selected.size === listings.length && listings.length > 0;

  return (
    <div className="overflow-hidden rounded-2xl border bg-white">
      {selected.size > 0 && (
        <div className="flex items-center gap-3 border-b bg-blue-50 px-4 py-2.5">
          <span className="text-sm font-medium text-blue-700">
            {selected.size} selected
          </span>
          <Button variant="outline" size="sm" className="h-7 text-xs">
            Publish selected
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs text-red-600 hover:text-red-700"
          >
            Delete
          </Button>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow className="bg-zinc-50/80 hover:bg-zinc-50/80">
            {!compact && (
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleAll}
                  aria-label="Select all"
                />
              </TableHead>
            )}
            <TableHead>Product</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Status</TableHead>
            {!compact && <TableHead>Marketplace</TableHead>}
            <TableHead className="text-right">Price</TableHead>
            {!compact && <TableHead>Last updated</TableHead>}
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {listings.map((listing) => (
            <TableRow
              key={listing.id}
              className={selected.has(listing.id) ? "bg-blue-50/30" : ""}
            >
              {!compact && (
                <TableCell>
                  <Checkbox
                    checked={selected.has(listing.id)}
                    onCheckedChange={() => toggle(listing.id)}
                    aria-label={`Select ${listing.title}`}
                  />
                </TableCell>
              )}
              <TableCell>
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-zinc-50 text-lg">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={listing.thumbnail}
                      alt={listing.title}
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <div className="min-w-0">
                    <Link
                      href={`/listings/${listing.id}/review`}
                      className="block truncate text-sm font-medium text-zinc-900 hover:text-blue-600 max-w-[220px]"
                    >
                      {listing.title}
                    </Link>
                    <p className="text-xs text-zinc-400">{listing.sku}</p>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <span className="text-sm text-zinc-600">{listing.category}</span>
              </TableCell>
              <TableCell>
                <StatusPill status={listing.status} />
              </TableCell>
              {!compact && (
                <TableCell>
                  <MarketplaceBadge marketplace={listing.marketplace} />
                </TableCell>
              )}
              <TableCell className="text-right">
                <span className="text-sm font-semibold text-zinc-800">
                  {formatGHS(listing.price)}
                </span>
              </TableCell>
              {!compact && (
                <TableCell>
                  <span className="text-xs text-zinc-400">
                    {formatDate(listing.lastUpdated)}
                  </span>
                </TableCell>
              )}
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-zinc-400"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    <DropdownMenuItem asChild>
                      <Link href={`/listings/${listing.id}/review`}>
                        <ExternalLink className="h-4 w-4" />
                        View / Edit
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem>Duplicate</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-red-600">
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {listings.length === 0 && (
        <div className="py-16 text-center">
          <p className="text-sm text-zinc-400">No listings found</p>
        </div>
      )}
    </div>
  );
}
