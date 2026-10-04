const sends: Record<string, unknown>[] = [];
jest.mock("resend", () => ({
  Resend: class {
    emails = { send: async (payload: Record<string, unknown>) => { sends.push(payload); return { data: { id: "em_1" }, error: null }; } };
  },
}));
jest.mock("@sentry/nextjs", () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));

import { sendEmail } from "@/lib/email/send";
import { SUPPORT_EMAIL } from "@/lib/constants/support";

describe("sendEmail", () => {
  beforeAll(() => { process.env.RESEND_API_KEY = "re_test"; });
  beforeEach(() => { sends.length = 0; });

  it("sends replies to the support inbox: the sending domain has no inbox of its own", async () => {
    await sendEmail({ to: "seller@example.com", subject: "Hi", html: "<p>Hi</p>" });
    expect(sends[0].replyTo).toBe(SUPPORT_EMAIL);
  });

  it("passes extra headers through, for a broadcast's List-Unsubscribe", async () => {
    const headers = { "List-Unsubscribe": `<mailto:${SUPPORT_EMAIL}?subject=unsubscribe>` };
    const result = await sendEmail({ to: "seller@example.com", subject: "Hi", html: "<p>Hi</p>", headers });
    expect(result).toEqual({ success: true, id: "em_1" });
    expect(sends[0].headers).toEqual(headers);
  });
});
