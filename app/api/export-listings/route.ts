import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import * as XLSX from "xlsx";
import type { ListingRow, VariantRow } from "@/lib/supabase/types";

// ─── Jumia Upload Template columns (exact order) ──────────────────────────────
const JUMIA_HEADERS = [
  "Name",
  "Name_AR",
  "Name_FR",
  "Description",
  "Description_AR",
  "Description_FR",
  "SellerSKU",
  "ParentSKU",
  "Brand",
  "PrimaryCategory",
  "AdditionalCategory",
  "GTIN_Barcode",
  "Price_GHS",
  "Sale_Price_GHS",
  "Sale_Price_Start_At",
  "Sale_Price_End_At",
  "Stock",
  "variation",
  "certifications",
  "color",
  "color_AR",
  "color_FR",
  "color_family",
  "main_material",
  "manufacturer_txt",
  "material_family",
  "model",
  "note",
  "package_content",
  "package_content_AR",
  "package_content_FR",
  "product_line",
  "product_measures",
  "product_warranty",
  "product_weight",
  "production_country",
  "short_description",
  "short_description_AR",
  "short_description_FR",
  "warranty_address",
  "warranty_duration",
  "warranty_type",
  "youtube_id",
  "MainImage",
  "Image2",
  "Image3",
  "Image4",
  "Image5",
  "Image6",
  "Image7",
  "Image8",
];

// ─── Map a ListingRow (+ optional variants) to one or more Jumia rows ─────────

function buildProductMeasures(l: ListingRow): string {
  const parts = [
    l.size_l != null ? `L: ${l.size_l} cm` : null,
    l.size_w != null ? `W: ${l.size_w} cm` : null,
    l.size_h != null ? `H: ${l.size_h} cm` : null,
  ].filter(Boolean);
  return parts.join(" × ");
}

function mapListingToRows(
  listing: ListingRow,
  variants: VariantRow[]
): Record<string, string | number | null>[] {
  const base = {
    Name: listing.title ?? "",
    Name_AR: "",
    Name_FR: "",
    Description: listing.description ?? "",
    Description_AR: "",
    Description_FR: "",
    SellerSKU: listing.sku,
    ParentSKU: listing.sku,
    Brand: listing.brand ?? "",
    // PrimaryCategory: use category_code if available, else category_path
    PrimaryCategory: listing.category_path ?? listing.category_id ?? "",
    AdditionalCategory: "",
    GTIN_Barcode: "",
    Price_GHS: listing.selling_price ?? "",
    Sale_Price_GHS: "",
    Sale_Price_Start_At: "",
    Sale_Price_End_At: "",
    Stock: "",
    variation: "",
    certifications: Array.isArray(listing.certifications)
      ? listing.certifications.join(", ")
      : "",
    color: listing.color ?? "",
    color_AR: "",
    color_FR: "",
    color_family: listing.color_family ?? "",
    main_material: listing.main_material ?? "",
    manufacturer_txt: listing.brand ?? "",
    material_family: listing.material_family ?? "",
    model: listing.model ?? "",
    note: "",
    package_content: "",
    package_content_AR: "",
    package_content_FR: "",
    product_line: listing.product_line ?? "",
    product_measures: buildProductMeasures(listing),
    product_warranty: listing.warranty_text ?? "",
    product_weight: listing.weight_kg != null ? `${listing.weight_kg} kg` : "",
    production_country: listing.production_country ?? "",
    short_description: listing.highlights ?? "",
    short_description_AR: "",
    short_description_FR: "",
    warranty_address: listing.warranty_address ?? "",
    warranty_duration: listing.warranty_duration ?? "",
    warranty_type: listing.warranty_type ?? "",
    youtube_id: listing.youtube_id ?? "",
    MainImage: listing.images?.[0] ?? "",
    Image2: listing.images?.[1] ?? "",
    Image3: listing.images?.[2] ?? "",
    Image4: listing.images?.[3] ?? "",
    Image5: listing.images?.[4] ?? "",
    Image6: listing.images?.[5] ?? "",
    Image7: listing.images?.[6] ?? "",
    Image8: listing.images?.[7] ?? "",
  };

  // If no variants, return single row
  if (!variants.length) return [base];

  // With variants: one row per variant, share ParentSKU = listing.sku
  return variants.map((v) => ({
    ...base,
    SellerSKU: v.seller_sku ?? `${listing.sku}-${v.id.slice(0, 4)}`,
    ParentSKU: listing.sku,
    variation: v.variation ?? "",
    GTIN_Barcode: v.gtin ?? "",
    Price_GHS: v.global_price ?? listing.selling_price ?? "",
    Sale_Price_GHS: v.sale_price ?? "",
    Sale_Price_Start_At: v.sale_start_date ?? "",
    Sale_Price_End_At: v.sale_end_date ?? "",
    Stock: v.quantity ?? "",
  }));
}

// ─── Route handler ─────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // Parse optional status filter from query string
  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get("status"); // e.g. "pending_approval"

  const db = createServerClient();

  // Fetch listings
  let query = db
    .from("listings")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (statusFilter) {
    query = query.eq("status", statusFilter);
  }

  const { data: listings, error } = await query;
  if (error) {
    return new NextResponse("Failed to fetch listings", { status: 500 });
  }

  const rows = listings as ListingRow[];

  // Fetch variants for all listings
  const listingIds = rows.map((l) => l.id);
  const { data: allVariants } = listingIds.length
    ? await db.from("variants").select("*").in("listing_id", listingIds)
    : { data: [] };

  const variantsByListing: Record<string, VariantRow[]> = {};
  for (const v of (allVariants ?? []) as VariantRow[]) {
    if (!variantsByListing[v.listing_id]) variantsByListing[v.listing_id] = [];
    variantsByListing[v.listing_id].push(v);
  }

  // Build sheet data
  const sheetData: Record<string, string | number | null>[] = [];
  for (const listing of rows) {
    const variants = variantsByListing[listing.id] ?? [];
    sheetData.push(...mapListingToRows(listing, variants));
  }

  // Create workbook matching Jumia template structure
  const wb = XLSX.utils.book_new();

  // ── Upload Template sheet ──
  const uploadWs = XLSX.utils.json_to_sheet(sheetData, {
    header: JUMIA_HEADERS,
  });

  // Set column widths
  uploadWs["!cols"] = JUMIA_HEADERS.map((h) => ({
    wch: Math.max(h.length + 2, 16),
  }));

  // Style header row (bold, background) — SheetJS CE doesn't support full styles,
  // but we can set the header cells as a special row
  const headerRange = XLSX.utils.decode_range(uploadWs["!ref"] ?? "A1");
  for (let c = headerRange.s.c; c <= headerRange.e.c; c++) {
    const cellAddr = XLSX.utils.encode_cell({ r: 0, c });
    if (!uploadWs[cellAddr]) continue;
    uploadWs[cellAddr].s = {
      font: { bold: true, color: { rgb: "FFFFFF" } },
      fill: { fgColor: { rgb: "E63900" } }, // Jumia orange
      alignment: { wrapText: true },
    };
  }

  XLSX.utils.book_append_sheet(wb, uploadWs, "Upload Template");

  // ── Introduction sheet ──
  const introData = [
    ["PandaWorld — Jumia GH Export"],
    [""],
    [
      `Exported on: ${new Date().toISOString().slice(0, 10)} · ${rows.length} listing(s)`,
    ],
    [""],
    [
      "Instructions:",
    ],
    [
      "1. Review all rows in the 'Upload Template' tab before uploading.",
    ],
    [
      "2. Fill in any missing fields (Stock, GTIN, Sale prices) if needed.",
    ],
    [
      "3. Upload this file via Jumia VendorHub → Products → Add Products → Upload Template.",
    ],
    [
      "4. Jumia will validate and notify you of any errors.",
    ],
  ];
  const introWs = XLSX.utils.aoa_to_sheet(introData);
  introWs["!cols"] = [{ wch: 80 }];
  XLSX.utils.book_append_sheet(wb, introWs, "Introduction");

  // Generate buffer
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  const date = new Date().toISOString().slice(0, 10);
  const filename = `jumia-listings-${date}.xlsx`;

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
