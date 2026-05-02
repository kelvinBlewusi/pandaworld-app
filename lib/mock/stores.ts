export interface ConnectedStore {
  id: string;
  platform: string;
  storeName: string;
  email: string;
  status: "connected" | "expired" | "error";
  connectedAt: string;
  listingsCount: number;
  avatarColor: string;
}

export const mockStores: ConnectedStore[] = [
  {
    id: "store-001",
    platform: "jumia",
    storeName: "Kelvin Tech Hub",
    email: "kelvinblewu@gmail.com",
    status: "connected",
    connectedAt: "2026-01-15",
    listingsCount: 18,
    avatarColor: "from-orange-400 to-pink-500",
  },
  {
    id: "store-002",
    platform: "jumia",
    storeName: "AfriGoods Store",
    email: "afrigoods@gmail.com",
    status: "connected",
    connectedAt: "2026-02-20",
    listingsCount: 6,
    avatarColor: "from-blue-500 to-purple-600",
  },
  {
    id: "store-003",
    platform: "jumia",
    storeName: "GH Deals Online",
    email: "ghdeals@outlook.com",
    status: "expired",
    connectedAt: "2025-11-08",
    listingsCount: 0,
    avatarColor: "from-violet-400 to-purple-500",
  },
];
