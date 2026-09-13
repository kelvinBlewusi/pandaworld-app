import { pickStory } from "@/lib/whatsapp/waiting-stories";

describe("pickStory", () => {
  it("always returns a non-empty string short enough for a WhatsApp interactive body", () => {
    for (let i = 0; i < 20; i++) {
      const story = pickStory();
      expect(typeof story).toBe("string");
      expect(story.length).toBeGreaterThan(0);
      // WhatsApp's interactive message body cap is 1024 characters.
      expect(story.length).toBeLessThanOrEqual(1024);
    }
  });

  it("can return more than one distinct story across repeated calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(pickStory());
    expect(seen.size).toBeGreaterThan(1);
  });
});
