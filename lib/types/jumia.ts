// ─── Jumia OAuth / API types ─────────────────────────────────────────────────

export interface JumiaConnection {
  id: string;
  user_id: string;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null;
  seller_id: string | null;
  seller_name: string | null;
  seller_email: string | null;
  store_name: string | null;
  status: "active" | "expired" | "revoked";
  connected_at: string;
  updated_at: string;
}

/** Lightweight shape returned to the client (never exposes tokens) */
export interface JumiaConnectionPublic {
  connected: boolean;
  status: JumiaConnection["status"] | null;
  seller_name: string | null;
  seller_email: string | null;
  store_name: string | null;
  seller_id: string | null;
  connected_at: string | null;
  token_expires_at: string | null;
}

/** Response from Jumia /oauth2/token */
export interface JumiaTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;     // seconds
  refresh_token?: string;
  scope?: string;
}
