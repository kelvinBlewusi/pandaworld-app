import { improvementsAndVideosEmail } from "@/lib/email/templates";

const APP = "https://pandaworldai.site";

describe("improvementsAndVideosEmail", () => {
  const tpl = improvementsAndVideosEmail({ firstName: "Ama", appUrl: APP });

  it("links all five videos, as pictures and as text", () => {
    for (const id of ["kcmy3jnEFZk", "XDoao0IO7RM", "FTQmSdMNuNE", "YRoahiccZdI", "JKv7b81M7fE"]) {
      expect(tpl.html).toContain(`https://youtu.be/${id}`);
      expect(tpl.text).toContain(`https://youtu.be/${id}`);
    }
  });

  it("loads every picture from the site, over https", () => {
    const srcs = Array.from(tpl.html.matchAll(/<img[^>]+src="([^"]+)"/g), (m) => m[1]);
    expect(srcs).toHaveLength(6); // the logo and five videos
    for (const src of srcs) expect(src.startsWith(`${APP}/`)).toBe(true);
  });

  it("stays under Gmail's 102 KB cut-off, past which the rest is hidden behind a link", () => {
    expect(Buffer.byteLength(tpl.html, "utf8")).toBeLessThan(102 * 1024);
  });

  it("greets by name, escaped, and falls back when there's no name", () => {
    expect(improvementsAndVideosEmail({ firstName: "<b>Kofi</b>", appUrl: APP }).html).toContain("Hi &lt;b&gt;Kofi&lt;/b&gt;,");
    expect(improvementsAndVideosEmail({ firstName: "  ", appUrl: APP }).html).toContain("Hi there,");
  });

  it("states today's prices", () => {
    expect(tpl.html).toContain("A WhatsApp listing is 2 credits and an autofill is 1");
    expect(tpl.html).toContain("New accounts get 20 free credits");
  });
});
