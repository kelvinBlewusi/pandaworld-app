import { getListing } from "@/lib/actions/listings";
import { notFound } from "next/navigation";
import { ReviewClient } from "./review-client";

export default async function ReviewPage({
  params,
}: {
  params: { id: string };
}) {
  const listing = await getListing(params.id);
  if (!listing) notFound();
  return <ReviewClient listing={listing} />;
}
