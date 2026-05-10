import { getListings } from "@/lib/actions/listings";
import { toListingDisplay } from "@/lib/types";
import { ListingsClient } from "./listings-client";

export default async function ListingsPage() {
  const rows = await getListings();
  const listings = rows.map(toListingDisplay);

  // Build unique top-level (mother) categories from the full category path
  // e.g. "Electronics / Mobile Phones & Tablets / Phones" → "Electronics"
  const categories = Array.from(
    new Set(
      listings
        .map((l) => l.category?.split("/")[0]?.trim())
        .filter(Boolean)
    )
  ).sort() as string[];

  return <ListingsClient listings={listings} categories={categories} />;
}
