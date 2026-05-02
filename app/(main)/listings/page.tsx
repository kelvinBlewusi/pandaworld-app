import { getListings } from "@/lib/actions/listings";
import { toListingDisplay } from "@/lib/types";
import { ListingsClient } from "./listings-client";

export default async function ListingsPage() {
  const rows = await getListings();
  const listings = rows.map(toListingDisplay);

  // Build unique category list from real data
  const categories = Array.from(
    new Set(listings.map((l) => l.category).filter(Boolean))
  ).sort();

  return <ListingsClient listings={listings} categories={categories} />;
}
