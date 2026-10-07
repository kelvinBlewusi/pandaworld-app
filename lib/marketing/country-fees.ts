/**
 * Jumia's commission and per-item fee tables for every market, for the
 * public calculators on /sell-on-jumia/<country>.
 *
 * Copied from each country's official VendorHub commissions and fees pages
 * (linked from lib/marketing/countries.ts), read 2026-10-01. Most publish
 * the tables as images; the numbers below were read off them, current
 * column only. Commission is a percentage of the price with VAT included,
 * and every fee is per item, VAT included, in the local currency. Jumia
 * changes these, so re-read the source before editing a number.
 */

import { mockCategories } from "@/lib/mock/categories";
import { listingPriceFor } from "@/lib/marketing/jumia-fees";
import type { JumiaCountryCode } from "@/lib/marketing/countries";

/** Jumia Express (stock in Jumia's warehouse) or drop shipping (the seller's own). */
export type Fulfilment = "je" | "ds";

export interface FeeCategory {
  name:       string;
  /** Percent of the price, VAT included. */
  commission: number;
  /** The per-item fee, when it depends on the category. */
  fee?:       { ds: number; je: number };
}

export interface SizeFee {
  id:    string;
  label: string;
  /** null: not offered with that fulfilment. */
  ds:    number | null;
  je:    number | null;
}

/** How the per-item fee is set: by category, by the item's size, or typed in. */
export type ItemFee =
  | { by: "category" }
  | { by: "size"; sizes: SizeFee[] }
  | { by: "manual"; hint: string };

export interface CountryFees {
  code:      JumiaCountryCode;
  /** When these rates took effect, as Jumia states it. */
  effective: string;
  /** What Jumia calls the per-item fee there. */
  feeName:   string;
  itemFee:   ItemFee;
  /** Least commission Jumia takes on an item the seller ships from their own warehouse. */
  minCommissionDs?: number;
  categories: FeeCategory[];
}

export const COUNTRY_FEES: Record<JumiaCountryCode, CountryFees> = {
  // Ghana's table (lib/mock/categories) also carries its shipping
  // contributions; the Ghana-only calculator and rates pages read it too.
  GH: {
    code: "GH",
    effective: "2026",
    feeName: "shipping contribution",
    itemFee: { by: "category" },
    categories: mockCategories.map((c) => ({ name: c.name, commission: c.commissionRate, fee: { ds: c.shippingDS, je: c.shippingJE } })),
  },

  NG: {
    code: "NG",
    effective: "15 January 2026",
    feeName: "shipping contribution",
    itemFee: {
      by: "size",
      sizes: [
        { id: "xs",     label: "Extra small (fashion, beauty, home)", ds: 650,  je: 400 },
        { id: "small",  label: "Small",                               ds: 1000, je: 600 },
        { id: "medium", label: "Medium",                              ds: 1700, je: 900 },
        { id: "large",  label: "Large",                               ds: 3800, je: 4300 },
      ],
    },
    categories: [
      { name: "Audio & Hifi", commission: 14 },
      { name: "Beauty Appliances", commission: 12 },
      { name: "Cameras", commission: 11 },
      { name: "Desktop & Peripherals", commission: 11 },
      { name: "Diapers", commission: 19 },
      { name: "Electronics Accessories", commission: 16 },
      { name: "Fashion", commission: 17 },
      { name: "Gaming Consoles", commission: 11 },
      { name: "Generators", commission: 11 },
      { name: "Grocery", commission: 22 },
      { name: "Health & Beauty", commission: 19 },
      { name: "Hifi & Stereo", commission: 14 },
      { name: "Home", commission: 20 },
      { name: "Kids & Baby", commission: 16 },
      { name: "Kitchen & Dining", commission: 19.4 },
      { name: "Laptops", commission: 8 },
      { name: "Large Appliances", commission: 11 },
      { name: "Lighting & Home Fixture", commission: 19.1 },
      { name: "Luggage & Travel Gear", commission: 16 },
      { name: "Mobile Accessories", commission: 16 },
      { name: "Mobile Phones", commission: 7 },
      { name: "Musical Instruments", commission: 16 },
      { name: "Others", commission: 15.9 },
      { name: "Small Appliances", commission: 13 },
      { name: "Sporting Goods", commission: 16 },
      { name: "Tablets", commission: 11 },
      { name: "Televisions", commission: 8 },
      { name: "Tobacco", commission: 16 },
      { name: "Video Games", commission: 16 },
    ],
  },

  // VendorHub Kenya's fees page is gone (404); its commissions page gives
  // one shipping contribution, in its worked example.
  KE: {
    code: "KE",
    effective: "15 January 2026",
    feeName: "shipping contribution",
    itemFee: { by: "manual", hint: "Jumia Kenya's own example uses KSh 120 for a phone. Vendor Center shows yours." },
    categories: [
      { name: "Audio & Hifi", commission: 12 },
      { name: "Automotive", commission: 18 },
      { name: "Bedding", commission: 15 },
      { name: "Bulky Sporting Goods", commission: 16 },
      { name: "Camera", commission: 10 },
      { name: "Computers", commission: 8 },
      { name: "Computing Accessories", commission: 15 },
      { name: "Cooktops", commission: 10 },
      { name: "Cookware", commission: 15 },
      { name: "Data Storage", commission: 15 },
      { name: "Desktops & Monitors", commission: 8 },
      { name: "Diapers", commission: 15 },
      { name: "Electronics Accessories", commission: 15 },
      { name: "Fashion", commission: 15 },
      { name: "Fragrances", commission: 20 },
      { name: "Furniture", commission: 16 },
      { name: "Furniture Bulky", commission: 16 },
      { name: "Gaming Consoles", commission: 12 },
      { name: "Grocery", commission: 20 },
      { name: "Hair Extensions", commission: 18 },
      { name: "Hair tools & beauty appliances", commission: 15 },
      { name: "Health & Beauty", commission: 18 },
      { name: "Home", commission: 18 },
      { name: "Kids & Baby", commission: 16 },
      { name: "Large Appliances", commission: 10 },
      { name: "Lighting", commission: 15 },
      { name: "Livestock", commission: 20 },
      { name: "Luggage & Travel Gear, Bags", commission: 15 },
      { name: "Make up", commission: 18 },
      { name: "Make up tools & Nail care tools", commission: 15 },
      { name: "Mobile Phones", commission: 6 },
      { name: "Musical Instruments", commission: 20 },
      { name: "Printers & Scanners", commission: 10 },
      { name: "Rugs & Carpets", commission: 18 },
      { name: "Small Appliances", commission: 12 },
      { name: "Solar Power", commission: 12 },
      { name: "Sporting Goods", commission: 18 },
      { name: "Storage & Organisation", commission: 16 },
      { name: "Tablets", commission: 10 },
      { name: "Televisions", commission: 8 },
      { name: "Toys & Games", commission: 18 },
      { name: "TV Accessories", commission: 15 },
      { name: "TV Stands", commission: 15 },
      { name: "Vacuum", commission: 12 },
      { name: "Video Games", commission: 15 },
      { name: "Water Dispensers", commission: 10 },
    ],
  },

  EG: {
    code: "EG",
    effective: "15 January 2026",
    feeName: "order preparation fee",
    itemFee: {
      by: "size",
      sizes: [
        { id: "fashion", label: "Fashion item",                                  ds: 15,   je: 12 },
        { id: "small",   label: "Small",                                         ds: 15,   je: 12 },
        { id: "medium",  label: "Medium",                                        ds: 25,   je: 20 },
        { id: "large",   label: "Large",                                         ds: 60,   je: 50 },
        { id: "xl",      label: "Extra large (fridges, washing machines)",       ds: 120,  je: 110 },
        { id: "under50", label: "Any item under 50 EGP",                         ds: null, je: 2 },
      ],
    },
    minCommissionDs: 10,
    categories: [
      { name: "Fashion", commission: 15 },
      { name: "Fashion › Jewelry/Gold", commission: 15 },
      { name: "Health and Beauty", commission: 13 },
      { name: "Watches", commission: 12 },
      { name: "Sunglasses", commission: 13 },
      { name: "Mobiles and Tablets › Mobiles", commission: 3.9 },
      { name: "Mobiles and Tablets › Smart Watches", commission: 7 },
      { name: "Mobiles and Tablets › Tablets", commission: 3.9 },
      { name: "Mobiles and Tablets › Accessories", commission: 15 },
      { name: "Mobiles and Tablets › Home Phones", commission: 4 },
      { name: "Computers › Laptops", commission: 4.5 },
      { name: "Computers › Computers and Monitors", commission: 6 },
      { name: "Computers › Accessories", commission: 14 },
      { name: "Computers › Spare Parts", commission: 11.4 },
      { name: "Computers › External Hard Drives and Storage", commission: 10 },
      { name: "Computers › Networking Products", commission: 14 },
      { name: "Computers › Programming", commission: 11.4 },
      { name: "Computers › Projectors", commission: 17.1 },
      { name: "Printers and Scanners (incl. ink cartridges)", commission: 6 },
      { name: "Home Supplies › Home, Kitchen and Bathroom Supplies", commission: 13 },
      { name: "Home Supplies › Tools", commission: 12 },
      { name: "Home Supplies › Lighting", commission: 13 },
      { name: "Home Supplies › Small Home Appliances", commission: 7 },
      { name: "Home Supplies › Home Appliances", commission: 4.2 },
      { name: "Home Supplies › Home Furniture and Decor", commission: 13 },
      { name: "Home Supplies › Pet Supplies", commission: 11 },
      { name: "Garden Supplies", commission: 13 },
      { name: "TVs and Audio › Televisions", commission: 3.8 },
      { name: "TVs and Audio › Wearable Technology", commission: 7 },
      { name: "TVs and Audio › TV Receivers", commission: 6 },
      { name: "TVs and Audio › Accessories", commission: 15 },
      { name: "TVs and Audio › GPS and Car Audio", commission: 11.4 },
      { name: "TVs and Audio › DVD Players", commission: 11.4 },
      { name: "TVs and Audio › iPod and MP3 Players", commission: 11.4 },
      { name: "TVs and Audio › Headphones", commission: 10.3 },
      { name: "TVs and Audio › Home Theaters, Hi-Fi and Stereo", commission: 5 },
      { name: "Gaming › Gaming Consoles", commission: 3.5 },
      { name: "Gaming › Gaming CDs", commission: 11.4 },
      { name: "Gaming › Accessories", commission: 17.1 },
      { name: "Gaming › Board and Card Games", commission: 13 },
      { name: "Cameras › Cameras", commission: 6 },
      { name: "Cameras › Camera Lenses", commission: 10.3 },
      { name: "Cameras › Accessories", commission: 17.1 },
      { name: "Kids › Diapers", commission: 9 },
      { name: "Kids › Strollers and Kids Supplies", commission: 9 },
      { name: "Kids › Toys", commission: 10 },
      { name: "Sporting › Sportswear", commission: 15 },
      { name: "Sporting › Sports Equipment", commission: 12.5 },
      { name: "Grocery", commission: 5 },
      { name: "Grocery › Pet Food and Supplies", commission: 11 },
      { name: "Cars and Tools › Tires", commission: 12 },
      { name: "Cars and Tools › Audio and Video", commission: 12.5 },
      { name: "Cars and Tools › Oil and Fluids", commission: 11.4 },
      { name: "Cars and Tools › Batteries", commission: 11.4 },
      { name: "Cars and Tools › Other", commission: 12.5 },
      { name: "Stationery", commission: 11 },
      { name: "Books", commission: 8 },
      { name: "Books › Ebook Readers", commission: 17.1 },
      { name: "Music Equipment", commission: 11.4 },
      { name: "Beauty Appliances", commission: 11 },
    ],
  },

  MA: {
    code: "MA",
    effective: "15 January 2026",
    feeName: "order processing fee",
    itemFee: { by: "category" },
    categories: [
      { name: "Automotive", commission: 15, fee: { ds: 6, je: 4 } },
      { name: "Baby Products", commission: 10, fee: { ds: 6, je: 4 } },
      { name: "Books & Movies", commission: 15, fee: { ds: 6, je: 4 } },
      { name: "Camera Accessories", commission: 15, fee: { ds: 6, je: 4 } },
      { name: "Cameras", commission: 7, fee: { ds: 10, je: 5 } },
      { name: "Computer Accessories", commission: 15, fee: { ds: 6, je: 4 } },
      { name: "Cooling", commission: 8, fee: { ds: 24, je: 20 } },
      { name: "Desktops, Monitors", commission: 7, fee: { ds: 20, je: 10 } },
      { name: "Electric Scooters", commission: 9, fee: { ds: 24, je: 20 } },
      { name: "Electronics Accessories", commission: 15, fee: { ds: 6, je: 4 } },
      { name: "Fashion", commission: 17, fee: { ds: 6, je: 4 } },
      { name: "Fashion Accessories", commission: 17, fee: { ds: 4, je: 2 } },
      { name: "Furniture", commission: 15, fee: { ds: 24, je: 20 } },
      { name: "Gaming Consoles", commission: 7, fee: { ds: 10, je: 4 } },
      { name: "Grocery", commission: 20, fee: { ds: 6, je: 4 } },
      { name: "Grocery Bulky", commission: 20, fee: { ds: 24, je: 20 } },
      { name: "Health & Beauty", commission: 15, fee: { ds: 6, je: 4 } },
      { name: "Home", commission: 15, fee: { ds: 6, je: 4 } },
      { name: "Home Audio", commission: 9, fee: { ds: 10, je: 11 } },
      { name: "Home Fixture", commission: 15, fee: { ds: 6, je: 4 } },
      { name: "Jewelry", commission: 19, fee: { ds: 4, je: 2 } },
      { name: "Kitchen & Dining", commission: 15, fee: { ds: 6, je: 4 } },
      { name: "Land Line", commission: 6, fee: { ds: 6, je: 4 } },
      { name: "Laptops", commission: 6, fee: { ds: 20, je: 10 } },
      { name: "Large Appliances", commission: 8, fee: { ds: 24, je: 23 } },
      { name: "Large Fitness Machines", commission: 15, fee: { ds: 24, je: 20 } },
      { name: "Makeup", commission: 15, fee: { ds: 4, je: 2 } },
      { name: "Mobile Phones", commission: 6, fee: { ds: 10, je: 5 } },
      { name: "Other", commission: 15, fee: { ds: 6, je: 4 } },
      { name: "Outdoor", commission: 15, fee: { ds: 6, je: 6 } },
      { name: "Printer Consumables", commission: 7, fee: { ds: 10, je: 5 } },
      { name: "Printers & Scanners", commission: 7, fee: { ds: 24, je: 20 } },
      { name: "Receivers", commission: 15, fee: { ds: 10, je: 5 } },
      { name: "Rugs & Mattresses", commission: 15, fee: { ds: 24, je: 20 } },
      { name: "Skin Care", commission: 15, fee: { ds: 4, je: 2 } },
      { name: "Small Appliances", commission: 9, fee: { ds: 10, je: 5 } },
      { name: "Smart Watches", commission: 12, fee: { ds: 10, je: 5 } },
      { name: "Sport Equipment", commission: 15, fee: { ds: 6, je: 4 } },
      { name: "Tablets", commission: 6, fee: { ds: 10, je: 5 } },
      { name: "Televisions", commission: 6, fee: { ds: 20, je: 10 } },
      { name: "Video Games", commission: 15, fee: { ds: 6, je: 4 } },
      { name: "Watches", commission: 17, fee: { ds: 6, je: 4 } },
    ],
  },

  // The fixed fee per item is on a separate VendorHub page; Jumia's worked
  // example on the commissions page uses 500 FCFA for fashion.
  CI: {
    code: "CI",
    effective: "8 June 2026",
    feeName: "fixed fee",
    itemFee: { by: "manual", hint: "Jumia's own example uses a 500 FCFA fixed fee for a fashion item. Vendor Center shows yours." },
    categories: [
      { name: "Audio & Hifi", commission: 15 },
      { name: "Books & Stationery", commission: 15 },
      { name: "Computing Accessories", commission: 16 },
      { name: "Electronics Accessories", commission: 15 },
      { name: "Fashion", commission: 17 },
      { name: "Feature Phones", commission: 8 },
      { name: "Furniture", commission: 20 },
      { name: "Gaming Consoles", commission: 8 },
      { name: "Grocery", commission: 18 },
      { name: "Grocery Bulky", commission: 18 },
      { name: "Hair Tools & Appliances", commission: 15 },
      { name: "Health & Beauty", commission: 16 },
      { name: "Home", commission: 20 },
      { name: "Kid & Baby Fashion", commission: 15 },
      { name: "Kids & Baby", commission: 18 },
      { name: "Laptops & Desktops", commission: 7 },
      { name: "Large Appliances", commission: 15 },
      { name: "Large Screen TV", commission: 10 },
      { name: "Mattress", commission: 20 },
      { name: "Mobile Accessories", commission: 17 },
      { name: "Mobile Phones", commission: 4 },
      { name: "Musical Instruments", commission: 15 },
      { name: "Outdoor & Garden", commission: 20 },
      { name: "Pet Supplies", commission: 15 },
      { name: "Power Protection", commission: 20 },
      { name: "Printers & Scanners", commission: 9 },
      { name: "Small Appliances", commission: 17 },
      { name: "Sporting Goods", commission: 16 },
      { name: "Sportswear", commission: 15 },
      { name: "Tablets", commission: 10 },
      { name: "Televisions", commission: 7 },
      { name: "Tobacco", commission: 10 },
      { name: "Toys & Games", commission: 18 },
      { name: "Video Games", commission: 9 },
    ],
  },

  // VendorHub Senegal also shows an older HTML table (smartphones at 9%);
  // this is its "2026, effective Jan 15th" table.
  SN: {
    code: "SN",
    effective: "15 January 2026",
    feeName: "shipping contribution",
    itemFee: { by: "category" },
    categories: [
      { name: "Audio & Hifi", commission: 15, fee: { ds: 1200, je: 800 } },
      { name: "Automotive", commission: 20, fee: { ds: 500, je: 300 } },
      { name: "Cameras", commission: 10, fee: { ds: 500, je: 300 } },
      { name: "Computing Accessories", commission: 15, fee: { ds: 300, je: 200 } },
      { name: "Cooling", commission: 12, fee: { ds: 2000, je: 2000 } },
      { name: "Desktop & Peripherals", commission: 10, fee: { ds: 1200, je: 800 } },
      { name: "Electronics Accessories", commission: 15, fee: { ds: 300, je: 200 } },
      { name: "Fashion", commission: 20, fee: { ds: 300, je: 200 } },
      { name: "Feature Phones", commission: 12, fee: { ds: 500, je: 300 } },
      { name: "Furniture", commission: 20, fee: { ds: 500, je: 300 } },
      { name: "Gaming Consoles", commission: 10, fee: { ds: 1200, je: 800 } },
      { name: "Grocery", commission: 20, fee: { ds: 1500, je: 100 } },
      { name: "Health & Beauty", commission: 18, fee: { ds: 300, je: 200 } },
      { name: "Home", commission: 20, fee: { ds: 500, je: 300 } },
      { name: "Kids & Baby", commission: 15, fee: { ds: 300, je: 200 } },
      { name: "Kitchen, Bedding & Decor", commission: 20, fee: { ds: 300, je: 200 } },
      { name: "Laptops", commission: 8, fee: { ds: 1200, je: 800 } },
      { name: "Large Appliances", commission: 12, fee: { ds: 2000, je: 2000 } },
      { name: "Mattress", commission: 20, fee: { ds: 1700, je: 1700 } },
      { name: "Mobile Accessories", commission: 15, fee: { ds: 300, je: 200 } },
      { name: "Mobile Phones", commission: 6, fee: { ds: 500, je: 300 } },
      { name: "Others", commission: 20, fee: { ds: 500, je: 300 } },
      { name: "Printers & Scanners", commission: 11, fee: { ds: 1200, je: 800 } },
      { name: "Small Appliances", commission: 15, fee: { ds: 800, je: 700 } },
      { name: "Sport & Fitness", commission: 20, fee: { ds: 500, je: 300 } },
      { name: "Sportswear", commission: 20, fee: { ds: 300, je: 200 } },
      { name: "Tablets", commission: 15, fee: { ds: 500, je: 300 } },
      { name: "Televisions", commission: 9, fee: { ds: 1200, je: 800 } },
      { name: "Toys & Games", commission: 15, fee: { ds: 300, je: 200 } },
      { name: "TV Accessories", commission: 15, fee: { ds: 500, je: 300 } },
      { name: "Video Games", commission: 15, fee: { ds: 500, je: 300 } },
    ],
  },

  UG: {
    code: "UG",
    effective: "15 January 2026",
    feeName: "shipping contribution",
    itemFee: { by: "category" },
    categories: [
      { name: "Audio & Hifi", commission: 13, fee: { ds: 5000, je: 3500 } },
      { name: "Automotive", commission: 20, fee: { ds: 2700, je: 2000 } },
      { name: "Beauty Appliances", commission: 15, fee: { ds: 2000, je: 1750 } },
      { name: "Bulky Furniture", commission: 20, fee: { ds: 9000, je: 5000 } },
      { name: "Bulky Sporting Goods", commission: 20, fee: { ds: 9000, je: 5000 } },
      { name: "Cameras", commission: 10, fee: { ds: 2700, je: 2000 } },
      { name: "Computing Accessories", commission: 16, fee: { ds: 2700, je: 2000 } },
      { name: "Cookware", commission: 18, fee: { ds: 5000, je: 3500 } },
      { name: "Desktops & Monitors", commission: 14, fee: { ds: 5000, je: 3500 } },
      { name: "Diapers", commission: 15, fee: { ds: 5000, je: 3500 } },
      { name: "Electronics Accessories", commission: 16, fee: { ds: 2700, je: 2000 } },
      { name: "Fashion", commission: 20, fee: { ds: 2000, je: 1500 } },
      { name: "Feature Phones", commission: 9, fee: { ds: 2700, je: 2000 } },
      { name: "Furniture", commission: 20, fee: { ds: 5000, je: 3500 } },
      { name: "Gaming Consoles", commission: 10, fee: { ds: 5000, je: 3500 } },
      { name: "Gas", commission: 10, fee: { ds: 2700, je: 2000 } },
      { name: "Gear & Stroller", commission: 15, fee: { ds: 5000, je: 3500 } },
      { name: "Grocery", commission: 20, fee: { ds: 2700, je: 2000 } },
      { name: "Grocery Bulky", commission: 20, fee: { ds: 9000, je: 5000 } },
      { name: "Health & Beauty", commission: 18, fee: { ds: 2000, je: 1500 } },
      { name: "Home", commission: 19, fee: { ds: 2700, je: 2000 } },
      { name: "Kettles & Irons", commission: 12, fee: { ds: 3500, je: 2500 } },
      { name: "Kids & Baby", commission: 15, fee: { ds: 2700, je: 2000 } },
      { name: "Laptops", commission: 10, fee: { ds: 5000, je: 3500 } },
      { name: "Large Appliances", commission: 10, fee: { ds: 9000, je: 5000 } },
      { name: "Luggage & Travel Gear", commission: 20, fee: { ds: 5000, je: 3500 } },
      { name: "Mattresses", commission: 20, fee: { ds: 9000, je: 5000 } },
      { name: "Mobile Accessories", commission: 16, fee: { ds: 2700, je: 2000 } },
      { name: "Mobile Phones", commission: 6, fee: { ds: 2700, je: 2000 } },
      { name: "Outdoor & Garden", commission: 20, fee: { ds: 2700, je: 2000 } },
      { name: "Printers & Scanners", commission: 10, fee: { ds: 5000, je: 3500 } },
      { name: "Rugs & Carpets", commission: 20, fee: { ds: 5000, je: 3500 } },
      { name: "Small Appliances", commission: 12, fee: { ds: 5000, je: 3500 } },
      { name: "Sporting Goods", commission: 20, fee: { ds: 2700, je: 2000 } },
      { name: "Tablets", commission: 11, fee: { ds: 2700, je: 2000 } },
      { name: "Televisions", commission: 8, fee: { ds: 8000, je: 5500 } },
      { name: "Toys & Games", commission: 17, fee: { ds: 2700, je: 2000 } },
      { name: "TV Accessories", commission: 12, fee: { ds: 5000, je: 3500 } },
      { name: "Video Games", commission: 18, fee: { ds: 5000, je: 3500 } },
    ],
  },
};

/** The per-item fee for this choice, or null when it must be typed in or isn't offered. */
export function itemFeeFor(
  fees:       CountryFees,
  category:   FeeCategory | null,
  fulfilment: Fulfilment,
  sizeId:     string | null,
): number | null {
  const how = fees.itemFee;
  if (how.by === "category") return category?.fee ? category.fee[fulfilment] : null;
  if (how.by === "size") return how.sizes.find((s) => s.id === sizeId)?.[fulfilment] ?? null;
  return null;
}

/** Commission on an item sold at `price`, with Egypt's own-warehouse minimum. */
export function commissionOn(fees: CountryFees, price: number, commissionPct: number, fulfilment: Fulfilment): number {
  const pct = price * (commissionPct / 100);
  return fees.minCommissionDs != null && fulfilment === "ds" ? Math.max(pct, fees.minCommissionDs) : pct;
}

/**
 * The price to list at so the seller receives `payout`: Jumia's formula,
 * (payout + fee) ÷ (1 − commission), rounded up to the currency's step, or
 * enough to cover a minimum commission when that's more.
 */
export function listPriceFor(
  fees:          CountryFees,
  payout:        number,
  fee:           number,
  commissionPct: number,
  fulfilment:    Fulfilment,
  step:          number,
): number {
  const price = listingPriceFor(payout, fee, commissionPct, step);
  if (fees.minCommissionDs == null || fulfilment !== "ds") return price;
  return Math.max(price, listingPriceFor(payout + fees.minCommissionDs, fee, 0, step));
}

/** What the seller receives for an item sold at `price`. */
export function payoutAt(fees: CountryFees, price: number, fee: number, commissionPct: number, fulfilment: Fulfilment): number {
  return price - commissionOn(fees, price, commissionPct, fulfilment) - fee;
}

const feeWords = (s: string) =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && w !== "and").map((w) => (w.length > 3 ? w.replace(/s$/, "") : w));

/**
 * The fee table's category for a product in this Jumia category ("Home &
 * Office > Home & Kitchen > Kitchen & Dining > Small Appliances > … > Electric
 * Kettles"): the deepest part of the path that holds every word of a table
 * name ("Kettles", else "Small Appliances", else "Home"), the longer name
 * first. Null when no part fits: the seller is sent to the calculator.
 */
export function feeCategoryForPath(fees: CountryFees, path: string | null | undefined): FeeCategory | null {
  if (!path) return null;
  const parts = path.split(/\s*[>/]\s*/).filter(Boolean).reverse();
  const named = fees.categories
    .map((c) => ({ c, words: feeWords(c.name) }))
    .filter((x) => x.words.length > 0 && x.c.name.toLowerCase() !== "others")
    .sort((a, b) => b.words.length - a.words.length);
  for (const part of parts) {
    const have = new Set(feeWords(part));
    const hit = named.find((x) => x.words.every((w) => have.has(w)));
    if (hit) return hit.c;
  }
  return null;
}

/** Lowest and highest commission in a country's table, for copy. */
export function commissionSpan(fees: CountryFees): { min: number; max: number } {
  const rates = fees.categories.map((c) => c.commission);
  return { min: Math.min(...rates), max: Math.max(...rates) };
}
