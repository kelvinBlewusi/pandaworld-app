import { getListing, getVariantsForListing } from "@/lib/actions/listings";
import { notFound } from "next/navigation";
import { ReviewClient } from "./review-client";

export default async function ReviewPage({
  params,
}: {
  params: { id: string };
}) {
  // Load the listing AND any persisted variant rows in parallel. The
  // variants table is the source of truth for the variation label and
  // per-variant SKU / price / stock / dates — what we send to Jumia.
  // Hydrating the client with these prevents the "field shows empty,
  // becomes filled after push" hidden-fill bug.
  const [listing, variants] = await Promise.all([
    getListing(params.id),
    getVariantsForListing(params.id),
  ]);
  if (!listing) notFound();
  return <ReviewClient listing={listing} initialVariants={variants} />;
}
