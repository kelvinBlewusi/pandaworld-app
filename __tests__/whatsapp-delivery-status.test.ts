/**
 * WhatsApp answers 200 for a message it later fails to deliver; the failure
 * arrives as a webhook status update and is recorded rather than lost.
 */
import { failedDeliveries } from "@/lib/whatsapp/delivery-status";

const payload = (statuses: unknown[]) => ({ entry: [{ changes: [{ value: { statuses } }] }] });

describe("failedDeliveries", () => {
  it("picks out failed statuses with Meta's error", () => {
    expect(failedDeliveries(payload([
      { id: "wamid.A", status: "delivered", recipient_id: "233200000000" },
      {
        id: "wamid.B", status: "failed", recipient_id: "233200000001",
        errors: [{ code: 131047, title: "Re-engagement message", error_data: { details: "Message failed to send because more than 24 hours have passed" } }],
      },
    ]))).toEqual([{
      wamid: "wamid.B", recipient: "233200000001", code: 131047, title: "Re-engagement message",
      details: "Message failed to send because more than 24 hours have passed",
    }]);
  });

  it("ignores message-only payloads and malformed bodies", () => {
    expect(failedDeliveries({ entry: [{ changes: [{ value: { messages: [{ id: "x" }] } }] }] })).toEqual([]);
    expect(failedDeliveries(null)).toEqual([]);
    expect(failedDeliveries(payload([{ status: "failed" }]))).toEqual([
      { wamid: "", recipient: "", code: null, title: "unknown error", details: null },
    ]);
  });
});
