// Real Jumia GH commission rates — source: Commissions & Fees.xlsx (Jumia VendorHub GH)
// NB: Commission fees are inclusive of VAT
// shippingDS = Drop Shipping contribution (GHS)
// shippingJE = Jumia Express contribution (GHS)

export interface JumiaCategory {
  id: string;
  name: string;
  commissionRate: number; // percentage, e.g. 7 = 7%
  shippingDS: number;     // GHS shipping contribution for Drop Shipping
  shippingJE: number;     // GHS shipping contribution for Jumia Express
  path: string;           // display breadcrumb
  code: string;           // Jumia internal category code
  subcategories: string[];
}

export const mockCategories: JumiaCategory[] = [
  {
    id: "cat-mob",
    name: "Mobile Phones",
    commissionRate: 7,
    shippingDS: 10,
    shippingJE: 8,
    path: "Electronics / Mobile Phones & Tablets / Phones",
    code: "1000000",
    subcategories: ["Smartphones", "Feature Phones", "Refurbished Phones"],
  },
  {
    id: "cat-feature",
    name: "Feature Phones",
    commissionRate: 9,
    shippingDS: 10,
    shippingJE: 8,
    path: "Electronics / Mobile Phones & Tablets / Feature Phones",
    code: "1000050",
    subcategories: ["Basic Phones", "Dual SIM Phones"],
  },
  {
    id: "cat-laptop",
    name: "Laptops",
    commissionRate: 8,
    shippingDS: 18,
    shippingJE: 12,
    path: "Computing / Laptops & Accessories / Laptops",
    code: "1001000",
    subcategories: ["Windows Laptops", "MacBooks", "Chromebooks", "Gaming Laptops"],
  },
  {
    id: "cat-tablet",
    name: "Tablets",
    commissionRate: 11,
    shippingDS: 10,
    shippingJE: 8,
    path: "Electronics / Mobile Phones & Tablets / Tablets",
    code: "1000100",
    subcategories: ["Android Tablets", "iPads", "E-Readers"],
  },
  {
    id: "cat-tv",
    name: "Televisions",
    commissionRate: 8,
    shippingDS: 18,
    shippingJE: 12,
    path: "Electronics / Television / Televisions",
    code: "1002000",
    subcategories: ["Smart TVs", "LED TVs", "OLED TVs"],
  },
  {
    id: "cat-audio",
    name: "Audio & Hi-Fi",
    commissionRate: 15,
    shippingDS: 18,
    shippingJE: 12,
    path: "Electronics / Audio & Hifi / All Audio & Hifi",
    code: "1003000",
    subcategories: ["Headphones", "Speakers", "Home Theatre"],
  },
  {
    id: "cat-cam",
    name: "Cameras",
    commissionRate: 10,
    shippingDS: 10,
    shippingJE: 8,
    path: "Electronics / Cameras / All Cameras",
    code: "1004000",
    subcategories: ["DSLR & Mirrorless", "Action Cameras", "Camera Accessories"],
  },
  {
    id: "cat-comp-acc",
    name: "Computing Accessories",
    commissionRate: 16,
    shippingDS: 10,
    shippingJE: 8,
    path: "Computing / Accessories / All Computing Accessories",
    code: "1005000",
    subcategories: ["Keyboards", "Mice", "Monitors", "USB Hubs"],
  },
  {
    id: "cat-elec-acc",
    name: "Electronics Accessories",
    commissionRate: 16,
    shippingDS: 10,
    shippingJE: 8,
    path: "Electronics / Accessories / All Electronics Accessories",
    code: "1006000",
    subcategories: ["Phone Cases", "Chargers", "Cables", "Screen Protectors"],
  },
  {
    id: "cat-desktop",
    name: "Desktops, Monitors & Printers",
    commissionRate: 8,
    shippingDS: 15,
    shippingJE: 10,
    path: "Computing / Desktop Computers / All Desktops",
    code: "1007000",
    subcategories: ["Desktops", "Monitors", "Printers"],
  },
  {
    id: "cat-gaming",
    name: "Gaming Consoles",
    commissionRate: 10,
    shippingDS: 18,
    shippingJE: 12,
    path: "Gaming / Consoles / All Gaming Consoles",
    code: "1008000",
    subcategories: ["PlayStation", "Xbox", "Nintendo"],
  },
  {
    id: "cat-gaming-acc",
    name: "Gaming Accessories",
    commissionRate: 16,
    shippingDS: 15,
    shippingJE: 10,
    path: "Gaming / Accessories",
    code: "1008100",
    subcategories: ["Controllers", "Headsets", "Gaming Chairs"],
  },
  {
    id: "cat-video-games",
    name: "Video Games",
    commissionRate: 10,
    shippingDS: 15,
    shippingJE: 10,
    path: "Gaming / Video Games",
    code: "1008200",
    subcategories: ["PS5 Games", "Xbox Games", "Nintendo Games"],
  },
  {
    id: "cat-large-app",
    name: "Large Appliances",
    commissionRate: 11,
    shippingDS: 45,
    shippingJE: 35,
    path: "Home Appliances / Large Appliances / All",
    code: "1009000",
    subcategories: ["Refrigerators", "Washing Machines", "Air Conditioners"],
  },
  {
    id: "cat-small-app",
    name: "Small Appliances",
    commissionRate: 12,
    shippingDS: 18,
    shippingJE: 12,
    path: "Home Appliances / Small Appliances / All",
    code: "1010000",
    subcategories: ["Blenders", "Irons", "Kettles", "Microwaves"],
  },
  {
    id: "cat-iron",
    name: "Irons",
    commissionRate: 13,
    shippingDS: 18,
    shippingJE: 12,
    path: "Home Appliances / Small Appliances / Irons",
    code: "1010100",
    subcategories: ["Steam Irons", "Dry Irons", "Garment Steamers"],
  },
  {
    id: "cat-kettle",
    name: "Kettles",
    commissionRate: 13,
    shippingDS: 18,
    shippingJE: 12,
    path: "Home Appliances / Small Appliances / Kettles",
    code: "1010200",
    subcategories: ["Electric Kettles", "Gooseneck Kettles"],
  },
  {
    id: "cat-blend",
    name: "Mixing & Blending",
    commissionRate: 13,
    shippingDS: 18,
    shippingJE: 12,
    path: "Home Appliances / Small Appliances / Mixing & Blending",
    code: "1010300",
    subcategories: ["Blenders", "Mixers", "Food Processors"],
  },
  {
    id: "cat-hair-tools",
    name: "Beauty Appliances",
    commissionRate: 15,
    shippingDS: 10,
    shippingJE: 8,
    path: "Health & Beauty / Beauty & Personal Care / Hair Care / Hair Tools",
    code: "1001500",
    subcategories: ["Hair Dryers", "Straighteners", "Curling Irons"],
  },
  {
    id: "cat-hb",
    name: "Health & Beauty",
    commissionRate: 20,
    shippingDS: 8,
    shippingJE: 6,
    path: "Health & Beauty / All Health & Beauty",
    code: "1001000",
    subcategories: ["Skincare", "Hair Care", "Supplements", "Fragrances"],
  },
  {
    id: "cat-fashion",
    name: "Fashion",
    commissionRate: 20,
    shippingDS: 8,
    shippingJE: 6,
    path: "Fashion / All Fashion",
    code: "1011000",
    subcategories: ["Men's Clothing", "Women's Clothing", "Shoes", "Bags & Accessories"],
  },
  {
    id: "cat-home",
    name: "Home",
    commissionRate: 17,
    shippingDS: 10,
    shippingJE: 8,
    path: "Home & Kitchen / All Home",
    code: "1012000",
    subcategories: ["Decor", "Kitchenware", "Bedding", "Bath"],
  },
  {
    id: "cat-furniture",
    name: "Furniture",
    commissionRate: 15,
    shippingDS: 30,
    shippingJE: 30,
    path: "Home & Kitchen / Furniture / All Furniture",
    code: "1012100",
    subcategories: ["Chairs", "Tables", "Beds", "Shelving"],
  },
  {
    id: "cat-kids",
    name: "Kids & Baby",
    commissionRate: 15,
    shippingDS: 10,
    shippingJE: 8,
    path: "Baby Products / All Baby",
    code: "1013000",
    subcategories: ["Diapers", "Baby Food", "Toys", "Baby Gear"],
  },
  {
    id: "cat-toys",
    name: "Toys & Games",
    commissionRate: 15,
    shippingDS: 10,
    shippingJE: 8,
    path: "Toys & Games / All",
    code: "1013100",
    subcategories: ["Board Games", "Action Figures", "Puzzles", "Outdoor Toys"],
  },
  {
    id: "cat-grocery",
    name: "Grocery",
    commissionRate: 20,
    shippingDS: 8,
    shippingJE: 6,
    path: "Grocery / All Grocery",
    code: "1014000",
    subcategories: ["Beverages", "Snacks", "Cooking Oils", "Grains"],
  },
  {
    id: "cat-grocery-multi",
    name: "Grocery Multipacks",
    commissionRate: 20,
    shippingDS: 18,
    shippingJE: 12,
    path: "Grocery / Multipacks",
    code: "1014050",
    subcategories: ["Multipack Drinks", "Multipack Snacks"],
  },
  {
    id: "cat-grocery-bulk",
    name: "Grocery Bulky",
    commissionRate: 20,
    shippingDS: 30,
    shippingJE: 30,
    path: "Grocery / Bulky Grocery",
    code: "1014100",
    subcategories: ["Bulk Rice", "Bulk Flour", "Bulk Drinks"],
  },
  {
    id: "cat-sport",
    name: "Sporting Goods",
    commissionRate: 15,
    shippingDS: 10,
    shippingJE: 8,
    path: "Sporting Goods / All Sports",
    code: "1015000",
    subcategories: ["Fitness Equipment", "Sportswear", "Outdoor"],
  },
  {
    id: "cat-sport-bulk",
    name: "Bulky Sporting Goods",
    commissionRate: 5,
    shippingDS: 30,
    shippingJE: 30,
    path: "Sporting Goods / Bulky Sporting Goods",
    code: "1015100",
    subcategories: ["Treadmills", "Exercise Bikes", "Weight Benches"],
  },
  {
    id: "cat-auto",
    name: "Automotive",
    commissionRate: 15,
    shippingDS: 10,
    shippingJE: 8,
    path: "Automotive / All Automotive",
    code: "1016000",
    subcategories: ["Car Accessories", "Car Electronics", "Car Care"],
  },
  {
    id: "cat-auto-fluid",
    name: "Automotive Fluids & Maintenance",
    commissionRate: 10,
    shippingDS: 18,
    shippingJE: 12,
    path: "Automotive / Fluids & Maintenance",
    code: "1016100",
    subcategories: ["Engine Oil", "Coolants", "Brake Fluid"],
  },
  {
    id: "cat-auto-light",
    name: "Automotive Lighting",
    commissionRate: 15,
    shippingDS: 18,
    shippingJE: 12,
    path: "Automotive / Lighting",
    code: "1016200",
    subcategories: ["Headlights", "Interior Lights", "LED Kits"],
  },
  {
    id: "cat-auto-battery",
    name: "Automotive Power & Battery",
    commissionRate: 5,
    shippingDS: 30,
    shippingJE: 30,
    path: "Automotive / Power & Battery",
    code: "1016300",
    subcategories: ["Car Batteries", "Jump Starters", "Alternators"],
  },
  {
    id: "cat-net",
    name: "Networking",
    commissionRate: 8,
    shippingDS: 10,
    shippingJE: 8,
    path: "Computing / Networking / All Networking",
    code: "1017000",
    subcategories: ["Routers", "Switches", "Network Cables"],
  },
  {
    id: "cat-rv",
    name: "RV Parts & Accessories",
    commissionRate: 10,
    shippingDS: 18,
    shippingJE: 12,
    path: "Automotive / RV Parts & Accessories",
    code: "1018000",
    subcategories: ["RV Accessories", "Towing Equipment"],
  },
  {
    id: "cat-others",
    name: "Others",
    commissionRate: 20,
    shippingDS: 10,
    shippingJE: 8,
    path: "Others / All",
    code: "1099000",
    subcategories: ["Miscellaneous"],
  },
];

// Pricing formula from Jumia VendorHub GH:
// Listing price = (vendor price + shipping contribution) / (1 - commission rate)
export function calcListingPrice(
  vendorPrice: number,
  shippingContribution: number,
  commissionRate: number // as decimal e.g. 0.07
): number {
  return (vendorPrice + shippingContribution) / (1 - commissionRate);
}

export function calcNetPayout(
  sellingPrice: number,
  commissionRate: number // as decimal
): number {
  return sellingPrice * (1 - commissionRate);
}

// Color family options (Jumia standard)
export const colorFamilies = [
  "Black", "White", "Red", "Blue", "Green", "Yellow", "Orange",
  "Pink", "Purple", "Brown", "Grey", "Silver", "Gold", "Beige",
  "Multicolor", "Transparent", "Navy Blue", "Rose Gold",
];

// Production countries (Jumia standard)
export const productionCountries = [
  "China", "Ghana", "Nigeria", "South Africa", "USA", "Germany",
  "South Korea", "Japan", "India", "UK", "France", "Italy",
  "Turkey", "Vietnam", "Bangladesh", "Indonesia", "Malaysia",
];

// Warranty types (Jumia GH standard)
export const warrantyTypes = [
  "Seller Warranty",
  "Brand Warranty",
  "No Warranty",
  "Service Center",
  "International Manufacturer Warranty",
];

// Warranty durations
export const warrantyDurations = [
  "No Warranty",
  "1 Month",
  "3 Months",
  "6 Months",
  "12 Months",
  "18 Months",
  "24 Months",
  "36 Months",
  "5 Years",
  "Lifetime",
];

// Material families
export const materialFamilies = [
  "Metal", "Plastic", "Fabric", "Leather", "Wood", "Glass",
  "Rubber", "Ceramic", "Silicone", "Carbon Fibre", "Mixed",
];

// Certification options
export const certifications = [
  "ISO 9001", "ISO 14001", "CE", "FCC", "RoHS", "FDA",
  "GSA", "NAFDAC", "SON", "KEBS", "SONCAP",
];
