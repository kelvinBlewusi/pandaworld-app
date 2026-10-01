/**
 * A small in-memory stand-in for the Supabase client, covering exactly the
 * query shapes lib/whatsapp/intake.ts uses.
 *
 * WHY THIS EXISTS: every WhatsApp bug this project has shipped lived in
 * the SEAMS between units, not inside them — one listing per photo, two of
 * three photos lost, a note dropped because it overtook its own image, six
 * confirmations for one album, a batch wedged in "analyzing". The suite had
 * 469 passing unit tests while all of those were live, because none of them
 * ran the state machine end to end.
 *
 * Deliberately NOT a general Supabase mock. It supports the calls intake.ts
 * actually makes and throws loudly on anything else, so a test can never
 * quietly pass against a query shape this does not really model.
 *
 * It models the two properties that matter for those bugs:
 *   - rows are shared mutable state, so a handler reading after another
 *     handler wrote sees the write
 *   - the partial unique index on (whatsapp_batch_id, whatsapp_seq) is
 *     enforced, so the album race is reproducible
 */

export interface FakeRow { [k: string]: unknown }

type Filter = { col: string; val: unknown; op: "eq" | "not-is-null" | "in" | "lt" | "gt" | "like" };

/** Postgres LIKE: % is any run, _ is any one character. */
function likeToRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${body}$`, "s");
}

export class FakeDb {
  tables: Record<string, FakeRow[]> = {
    listings:          [],
    whatsapp_sessions: [],
    analysis_jobs:     [],
  };

  /** Every rpc call made, in order — asserted on directly by tests. */
  rpcCalls: { name: string; args: Record<string, unknown> }[] = [];

  private seq = 0;
  nextId(prefix = "id"): string { return `${prefix}-${++this.seq}`; }

  private match(row: FakeRow, filters: Filter[]): boolean {
    return filters.every((f) => {
      if (f.op === "not-is-null") return row[f.col] != null;
      if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
      if (f.op === "like") return typeof row[f.col] === "string" && likeToRegExp(f.val as string).test(row[f.col] as string);
      if (f.op === "lt" || f.op === "gt") {
        const v = row[f.col];
        const [a, b] = typeof v === "number" && typeof f.val === "number" ? [v, f.val] : [String(v ?? ""), String(f.val)];
        return f.op === "lt" ? a < b : a > b;
      }
      return row[f.col] === f.val;
    });
  }

  from(table: string) {
    if (!this.tables[table]) this.tables[table] = [];
    const rows = () => this.tables[table];
    const db = this;

    const selectBuilder = (filters: Filter[]) => ({
      eq(col: string, val: unknown) { return selectBuilder([...filters, { col, val, op: "eq" }]); },
      in(col: string, val: unknown[]) { return selectBuilder([...filters, { col, val, op: "in" }]); },
      lt(col: string, val: unknown) { return selectBuilder([...filters, { col, val, op: "lt" }]); },
      gt(col: string, val: unknown) { return selectBuilder([...filters, { col, val, op: "gt" }]); },
      like(col: string, val: string) { return selectBuilder([...filters, { col, val, op: "like" }]); },
      not(col: string, _op: string, _val: unknown) {
        return selectBuilder([...filters, { col, val: null, op: "not-is-null" }]);
      },
      order() { return selectBuilder(filters); },
      limit() { return selectBuilder(filters); },
      async maybeSingle() {
        const hit = rows().find((r) => db.match(r, filters));
        return { data: hit ? { ...hit } : null, error: null };
      },
      async single() {
        const hit = rows().find((r) => db.match(r, filters));
        return hit
          ? { data: { ...hit }, error: null }
          : { data: null, error: { message: "no rows", code: "PGRST116" } };
      },
      then(resolve: (v: { data: FakeRow[]; error: null }) => unknown) {
        return Promise.resolve({ data: rows().filter((r) => db.match(r, filters)).map((r) => ({ ...r })), error: null })
          .then(resolve);
      },
    });

    return {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.head) {
          const countBuilder = (filters: Filter[]) => ({
            eq(col: string, val: unknown) { return countBuilder([...filters, { col, val, op: "eq" }]); },
            in(col: string, val: unknown[]) { return countBuilder([...filters, { col, val, op: "in" }]); },
            lt(col: string, val: unknown) { return countBuilder([...filters, { col, val, op: "lt" }]); },
            not(col: string, _o: string, _v: unknown) { return countBuilder([...filters, { col, val: null, op: "not-is-null" }]); },
            then(resolve: (v: { count: number; error: null }) => unknown) {
              return Promise.resolve({ count: rows().filter((r) => db.match(r, filters)).length, error: null }).then(resolve);
            },
          });
          return countBuilder([]);
        }
        return selectBuilder([]);
      },

      insert(payload: FakeRow | FakeRow[]) {
        const incoming = Array.isArray(payload) ? payload : [payload];
        return {
          select() {
            return {
              async single() {
                const r = db.insertRows(table, incoming);
                return "error" in r ? r : { data: { ...r.data[0] }, error: null };
              },
              then(resolve: (v: unknown) => unknown) {
                const r = db.insertRows(table, incoming);
                return Promise.resolve("error" in r ? r : { data: r.data.map((x) => ({ ...x })), error: null }).then(resolve);
              },
            };
          },
          then(resolve: (v: unknown) => unknown) {
            const r = db.insertRows(table, incoming);
            return Promise.resolve("error" in r ? r : { data: null, error: null }).then(resolve);
          },
        };
      },

      update(patch: FakeRow) {
        const updateBuilder = (filters: Filter[]) => ({
          eq(col: string, val: unknown) { return updateBuilder([...filters, { col, val, op: "eq" }]); },
          in(col: string, val: unknown[]) { return updateBuilder([...filters, { col, val, op: "in" }]); },
          select() {
            const hits = rows().filter((r) => db.match(r, filters));
            for (const r of hits) Object.assign(r, patch);
            return {
              then(resolve: (v: unknown) => unknown) {
                return Promise.resolve({ data: hits.map((r) => ({ ...r })), error: null }).then(resolve);
              },
            };
          },
          then(resolve: (v: unknown) => unknown) {
            const hits = rows().filter((r) => db.match(r, filters));
            for (const r of hits) Object.assign(r, patch);
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        });
        return updateBuilder([]);
      },

      upsert(payload: FakeRow | FakeRow[], opts: { onConflict: string }) {
        // onConflict may name several columns ("category_code,name").
        const keys = opts.onConflict.split(",").map((k) => k.trim());
        for (const row of Array.isArray(payload) ? payload : [payload]) {
          const existing = rows().find((r) => keys.every((k) => r[k] === row[k]));
          if (existing) Object.assign(existing, row);
          else db.insertRows(table, [row]);
        }
        return {
          then(resolve: (v: unknown) => unknown) {
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        };
      },

      delete() {
        const deleteBuilder = (filters: Filter[]) => ({
          eq(col: string, val: unknown) { return deleteBuilder([...filters, { col, val, op: "eq" }]); },
          in(col: string, val: unknown[]) { return deleteBuilder([...filters, { col, val, op: "in" }]); },
          then(resolve: (v: unknown) => unknown) {
            db.tables[table] = rows().filter((r) => !db.match(r, filters));
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        });
        return deleteBuilder([]);
      },
    };
  }

  /** Enforces the partial unique index from
   *  2026-09-14_one-listing-per-batch-slot.sql, which is the whole reason
   *  the album race is fixable. */
  private insertRows(table: string, incoming: FakeRow[]): { data: FakeRow[] } | { data: null; error: { message: string; code: string } } {
    // Primary key / unique index of the credit ledger
    // (2026-08-24_extension-credits.sql): one balance row per seller, one
    // transaction per Paystack reference — the dedupe creditPurchase
    // relies on.
    const unique: Record<string, string> = { extension_credits: "user_id", extension_credit_transactions: "reference" };
    const uniqueCol = unique[table];
    if (uniqueCol) {
      for (const row of incoming) {
        if (row[uniqueCol] != null && this.tables[table].some((r) => r[uniqueCol] === row[uniqueCol])) {
          return { data: null, error: { message: `duplicate key value violates unique constraint on ${table}.${uniqueCol}`, code: "23505" } };
        }
      }
    }
    if (table === "listings") {
      for (const row of incoming) {
        const clash = row.whatsapp_batch_id != null && this.tables.listings.some(
          (r) => r.whatsapp_batch_id === row.whatsapp_batch_id && r.whatsapp_seq === row.whatsapp_seq,
        );
        if (clash) {
          return { data: null, error: { message: 'duplicate key value violates unique constraint "listings_batch_slot_idx"', code: "23505" } };
        }
      }
    }
    const created = incoming.map((row) => {
      const full: FakeRow = { id: this.nextId(table), created_at: new Date().toISOString(), ...row };
      this.tables[table].push(full);
      return full;
    });
    return { data: created };
  }

  async rpc(name: string, args: Record<string, unknown> = {}) {
    this.rpcCalls.push({ name, args });

    if (name === "append_listing_image") {
      const row = this.tables.listings.find((r) => r.id === args.p_listing_id);
      if (!row) return { data: null, error: { message: "listing not found" } };
      const images = ((row.images ?? []) as string[]).slice();
      // Atomic append, exactly as the real function behaves: re-reads under
      // the row lock rather than writing back a list read earlier.
      if (images.length < (args.p_max as number)) images.push(args.p_url as string);
      row.images = images;
      // The real function stamps updated_at (see
      // 2026-09-15_atomic-image-append.sql), and intake.ts reads it to tell
      // whether an album is still landing. A double that skipped it would
      // let that logic pass a test it would fail in production.
      row.updated_at = new Date().toISOString();
      return { data: [{ image_count: images.length }], error: null };
    }

    if (name === "append_qc_photo") {
      // Mirrors append_qc_photo (2026-10-01_qc-remedies.sql): atomic append
      // to the replacement photos, capped, ignoring a redelivered URL.
      const row = this.tables.listings.find((r) => r.id === args.p_listing_id);
      if (!row) return { data: [{ image_count: 0 }], error: null };
      const photos = ((row.qc_new_images ?? []) as string[]).slice();
      if (photos.length < (args.p_max as number) && !photos.includes(args.p_url as string)) photos.push(args.p_url as string);
      row.qc_new_images = photos;
      return { data: [{ image_count: photos.length }], error: null };
    }

    if (name === "claim_photo_confirmation") {
      const row = this.tables.whatsapp_sessions.find((r) => r.phone_number === args.p_phone);
      if (!row) return { data: false, error: null };
      const last = row.last_image_at ? Date.parse(row.last_image_at as string) : 0;
      const windowMs = 8_000;
      if (last && Date.now() - last < windowMs) return { data: false, error: null };
      row.last_image_at = new Date().toISOString();
      return { data: true, error: null };
    }

    if (name === "claim_message_id") {
      // Mirrors claim_message_id (2026-09-19_atomic-message-id-claim.sql):
      // a conditional update that only wins when last_message_id isn't
      // already this exact id.
      const row = this.tables.whatsapp_sessions.find((r) => r.phone_number === args.p_phone);
      if (!row) return { data: false, error: null };
      if (row.last_message_id === args.p_message_id) return { data: false, error: null };
      row.last_message_id = args.p_message_id;
      return { data: true, error: null };
    }

    throw new Error(`FakeDb: unmodelled rpc "${name}" — add it deliberately rather than letting a test pass against a stub.`);
  }
}
