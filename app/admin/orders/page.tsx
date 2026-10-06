import { auth } from "@clerk/nextjs/server";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { listOrders, type JumiaOrder } from "@/lib/jumia/orders";
import { packAllowedNumbers } from "@/lib/jumia/pack-allowlist";

export const dynamic = "force-dynamic";

const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** Why an order has neither a label nor a Pack button. */
function noActionNote(o: JumiaOrder): string {
  if (o.hasItemsFulfilledByJumia) return "Fulfilled by Jumia: no label";
  if (o.packedItems <= 0) return "Not packed yet";
  return "";
}

export default async function AdminOrdersPage() {
  const { userId } = await auth();

  let store = "";
  let problem: string | null = null;
  let orders: JumiaOrder[] = [];
  const packAllowed = await packAllowedNumbers();
  try {
    const creds = await getValidJumiaCredentials(userId as string);
    const result = await listOrders(creds.accessToken, {
      createdAfter:  day(-30),
      createdBefore: day(1),
      size:          50,
      sort:          "DESC",
    });
    store = `Jumia ${creds.country}`;
    if (result.ok) orders = result.data.orders;
    else problem = result.message;
  } catch (e) {
    problem = `Jumia isn't connected for your account (${(e as Error).message}).`;
  }

  return (
    <div>
      <h1 className="text-lg font-bold">Orders and shipping labels</h1>
      <p className="mt-1 max-w-3xl text-sm text-zinc-500">
        Your own shop&apos;s orders from the last 30 days{store ? ` (${store})` : ""}, read from Jumia. This is a
        trial of the label flow. Get label asks Jumia for the label of an order that is already packed (it has a
        tracking number) and opens the PDF; it changes nothing. Pack &amp; get label… appears only on an order the owner
        has switched on for packing, one at a time, because packing commits the order to a shipping provider and
        can&apos;t be undone.
      </p>

      {problem && <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">{problem}</p>}

      {!problem && orders.length === 0 && <p className="mt-6 text-sm text-zinc-500">No orders in the last 30 days.</p>}

      {orders.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">Order</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Packed</th>
                <th className="px-3 py-2 font-medium">Delivery</th>
                <th className="px-3 py-2 font-medium">Total</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {orders.map((o) => {
                const canLabel = !o.hasItemsFulfilledByJumia && o.packedItems > 0;
                // Packing is switched on one order at a time by the owner (lib/jumia/pack-allowlist.ts).
                const canPack =
                  packAllowed.includes(o.number) && !o.hasItemsFulfilledByJumia &&
                  o.status.toUpperCase() !== "CANCELED" && o.packedItems < o.totalItems;
                return (
                  <tr key={o.id} className="align-top">
                    <td className="px-3 py-2">
                      <div className="font-medium text-zinc-900">#{o.number}</div>
                      <div className="text-xs text-zinc-400">{new Date(o.createdAt).toLocaleString()}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-700">
                      {o.status}
                      {o.pendingSince ? <div className="text-zinc-400">pending {o.pendingSince}</div> : null}
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-700">{o.packedItems} of {o.totalItems}</td>
                    <td className="px-3 py-2 text-xs text-zinc-600">{o.deliveryOption ?? ""}</td>
                    <td className="px-3 py-2 text-xs text-zinc-700">
                      {o.totalAmountLocal ? `${o.totalAmountLocal.currency} ${o.totalAmountLocal.value}` : ""}
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-600">
                      {[o.shippingAddress?.firstName, o.shippingAddress?.city].filter(Boolean).join(", ")}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col items-start gap-2">
                        {canLabel && (
                          <form method="post" action="/admin/orders/label" target="_blank">
                            <input type="hidden" name="orderId" value={o.id} />
                            <button type="submit" className="whitespace-nowrap rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700">
                              Get label
                            </button>
                          </form>
                        )}
                        {canPack && (
                          <a
                            href={`/admin/orders/pack?orderId=${o.id}`}
                            className="whitespace-nowrap rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
                          >
                            Pack &amp; get label…
                          </a>
                        )}
                        {!canLabel && !canPack && <span className="text-xs text-zinc-400">{noActionNote(o)}</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
