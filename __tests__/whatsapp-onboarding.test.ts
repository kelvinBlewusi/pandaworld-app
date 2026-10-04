import {
  BOT_COMMANDS,
  HOW_IT_WORKS_BUTTON,
  welcomeMessage,
  guideHowToListMessage,
  guideControlsMessage,
  helpMessage,
  unsupportedMediaMessage,
  walkthroughVideoMessage,
  WALKTHROUGH_VIDEO_MARK,
  notLinkedMessage,
  linkedMessagePrefix,
} from "@/lib/whatsapp/onboarding";
import { buildConnectInstructions, SELF_AUTH_STEPS } from "@/lib/whatsapp/jumia-connect";
import { parseGlobalCommand } from "@/lib/whatsapp/commands";
import { MAX_BATCH_SIZE } from "@/lib/whatsapp/batch";

describe("first-run welcome", () => {
  it("teaches the one rule that decides whether a listing can be pushed", () => {
    // A draft with no price cannot go to Jumia and this bot never invents
    // one, so if the welcome teaches nothing else it must teach this.
    expect(welcomeMessage()).toMatch(/price/i);
    expect(welcomeMessage()).toMatch(/never guess/i);
  });

  it("stays inside WhatsApp's interactive body cap", () => {
    // It ships as an interactive message (it carries a button), which caps
    // at ~1024 characters — past that Meta rejects the send and the
    // seller's first ever message from us silently fails.
    expect(welcomeMessage().length).toBeLessThan(1024);
  });

  it("is short enough to actually be read before the next step", () => {
    // The whole design rests on not competing with the seller's real next
    // action. A welcome that grows into a tutorial defeats the split.
    expect(welcomeMessage().split("\n").filter(Boolean).length).toBeLessThanOrEqual(8);
  });
});

describe("the guide", () => {
  it("fits WhatsApp's plain-text cap", () => {
    expect(guideHowToListMessage().length).toBeLessThan(4096);
    expect(guideControlsMessage().length).toBeLessThan(4096);
  });

  it("documents every command the bot understands", () => {
    // The no-drift guarantee: guide and help both render from
    // BOT_COMMANDS, so a command added in one place cannot go unmentioned
    // in the other — `retry` shipped and the help text didn't learn about
    // it for a while, which is the failure this prevents.
    const both = guideControlsMessage() + helpMessage();
    for (const cmd of BOT_COMMANDS) {
      expect(guideControlsMessage()).toContain(cmd.phrase);
      expect(helpMessage()).toContain(cmd.phrase);
      expect(both).toContain(cmd.meaning);
    }
  });

  it("names the real batch cap rather than a hardcoded number", () => {
    expect(guideHowToListMessage()).toContain(String(MAX_BATCH_SIZE));
    expect(guideControlsMessage()).toContain(String(MAX_BATCH_SIZE));
  });

  it("tells sellers the note shapes that are parsed deterministically", () => {
    // These are read by regex, not guessed by AI — knowing the shapes is
    // the difference between an exact value and an AI approximation.
    const guide = guideHowToListMessage();
    for (const shape of ["price", "stock", "sale price", "red, blue"]) {
      expect(guide.toLowerCase()).toContain(shape);
    }
  });

  it("is honest about what the bot cannot do", () => {
    const controls = guideControlsMessage();
    expect(controls).toMatch(/can't do/i);
    expect(controls).toMatch(/credits/i);
    expect(controls).toMatch(/photos only/i);
  });
});

describe("the How it works button", () => {
  it("has an id the global command parser actually recognises", () => {
    // Button ids ARE the typed phrases in this bot, so a tap and a typed
    // phrase run the identical path. If these ever disagree the button
    // silently does nothing.
    expect(parseGlobalCommand(HOW_IT_WORKS_BUTTON.id)).toEqual({ type: "how_it_works" });
  });

  it("fits WhatsApp's 20-character button title limit", () => {
    expect(HOW_IT_WORKS_BUTTON.title.length).toBeLessThanOrEqual(20);
  });

  it("is reachable by the words someone who doesn't know the bot would try", () => {
    for (const phrase of ["how it works", "how does this work", "guide", "how to use", "How It Works!"]) {
      expect(parseGlobalCommand(phrase)).toEqual({ type: "how_it_works" });
    }
  });

  it("does not swallow ordinary sentences that mention how things work", () => {
    expect(parseGlobalCommand("how it works for red ones")).toBeNull();
    expect(parseGlobalCommand("tell me how it works please")).toBeNull();
  });
});

describe("unsupported media reply", () => {
  it("names the right thing for each type", () => {
    expect(unsupportedMediaMessage("video")).toMatch(/videos/i);
    expect(unsupportedMediaMessage("audio")).toMatch(/voice notes/i);
    expect(unsupportedMediaMessage("document")).toMatch(/documents/i);
  });

  it("still says something useful for a type it has never seen", () => {
    const msg = unsupportedMediaMessage("some_future_type");
    expect(msg).toMatch(/can't read/i);
    expect(msg).toMatch(/photo/i);
  });

  it("always tells the seller what to do instead", () => {
    for (const kind of ["video", "audio", "document", "sticker", "location", "contacts", "unknown"]) {
      expect(unsupportedMediaMessage(kind)).toMatch(/photo/i);
    }
  });
});

describe("the walkthrough video and the messages under it", () => {
  it("sends the full walkthrough's YouTube link, and is found again by its mark", () => {
    expect(walkthroughVideoMessage()).toContain("https://youtu.be/kcmy3jnEFZk");
    expect(walkthroughVideoMessage()).toContain(WALKTHROUGH_VIDEO_MARK);
  });

  it("puts the link last, where WhatsApp's preview card belongs to it", () => {
    expect(walkthroughVideoMessage().trim().endsWith("https://youtu.be/kcmy3jnEFZk")).toBe(true);
  });

  it("points a number that isn't linked to the video and the Guide page", () => {
    expect(notLinkedMessage()).toMatch(/isn't linked to a PandaWorld account yet/);
    expect(notLinkedMessage()).toMatch(/learn how PandaWorld works from the video above or visit the Guide page/);
    expect(notLinkedMessage()).toMatch(/\/how-to$/);
  });

  it("starts the linked confirmation the same way", () => {
    expect(linkedMessagePrefix()).toMatch(/^✅ Your WhatsApp is now linked to PandaWorld!/);
    expect(linkedMessagePrefix()).toMatch(/from the video above or visit the Guide page/);
    expect(linkedMessagePrefix()).toMatch(/\n\n$/);
  });

  it("keeps every linked confirmation inside WhatsApp's interactive body cap", () => {
    // It rides on a message with buttons. The longest one is the expired
    // connection's: its own two sentences, then the setup steps.
    const expired =
      "Your Jumia connection expired: the kind of application you set up needs a new login about once a day.\n\n" +
      "Set up automatic access once and it won't happen again:\n" + SELF_AUTH_STEPS;
    expect((linkedMessagePrefix() + buildConnectInstructions()).length).toBeLessThan(1024);
    expect((linkedMessagePrefix() + expired).length).toBeLessThan(1024);
    expect(notLinkedMessage().length).toBeLessThan(1024);
  });
});
