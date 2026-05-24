/**
 * PandaworldAi MVP Feedback Form Generator
 *
 * HOW TO USE:
 * 1. Go to https://script.google.com
 * 2. Create a new project
 * 3. Paste this entire script
 * 4. Click Run → createFeedbackForm
 * 5. Grant permissions when prompted
 * 6. The form URL will be logged in the Execution Log
 */

function createFeedbackForm() {
  const form = FormApp.create("PandaworldAi – MVP Feedback Survey");

  form.setDescription(
    "Hey! Thanks for taking a few minutes to share your thoughts on PandaworldAi " +
    "(pandaworldai.site) — an AI tool that turns a single product photo into a " +
    "ready-to-publish Jumia listing in seconds.\n\n" +
    "Your honest feedback (5–8 min) helps us build something people actually need. " +
    "All responses are anonymous."
  );

  form.setConfirmationMessage(
    "Thank you! Your feedback means a lot and will directly shape the next version of PandaworldAi. 🐼"
  );

  form.setAllowResponseEdits(false);
  form.setLimitOneResponsePerUser(false);
  form.setProgressBar(true);

  // ─────────────────────────────────────────────
  // SECTION 1: About You
  // ─────────────────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle("Section 1: About You")
    .setHelpText("Help us understand who you are so we can build for the right people.");

  form.addMultipleChoiceItem()
    .setTitle("Are you currently selling products online?")
    .setChoiceValues([
      "Yes, actively selling",
      "I've sold before but not currently",
      "No, but I'm planning to",
      "No, and I'm not planning to"
    ])
    .setRequired(true);

  form.addCheckboxItem()
    .setTitle("Which platforms do you sell on (or plan to sell on)?")
    .setChoiceValues([
      "Jumia",
      "Shopify",
      "eBay",
      "Amazon",
      "Instagram / Facebook",
      "My own website",
      "Physical store only",
      "Other"
    ]);

  form.addMultipleChoiceItem()
    .setTitle("How many products do you list per month (on average)?")
    .setChoiceValues([
      "1–10",
      "11–30",
      "31–100",
      "100+",
      "I don't list products yet"
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle("How do you currently create product listings?")
    .setChoiceValues([
      "I write them manually, one by one",
      "I copy-paste from another platform or spreadsheet",
      "I hire someone to do it",
      "I use another tool or software",
      "I don't create listings yet"
    ])
    .setRequired(true);

  // ─────────────────────────────────────────────
  // SECTION 2: The Problem
  // ─────────────────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle("Section 2: The Problem We're Solving")
    .setHelpText("We want to know if this pain point is real for you.");

  form.addMultipleChoiceItem()
    .setTitle("How much time do you spend creating a single product listing from scratch?")
    .setChoiceValues([
      "Less than 5 minutes",
      "5–15 minutes",
      "15–30 minutes",
      "More than 30 minutes",
      "Not applicable"
    ])
    .setRequired(true);

  const painScale = form.addScaleItem();
  painScale.setTitle("How frustrating is the process of manually creating marketplace listings?")
    .setBounds(1, 5)
    .setLabels("Not frustrating at all", "Extremely frustrating")
    .setRequired(true);

  form.addCheckboxItem()
    .setTitle("What are the biggest pain points when listing products? (Select all that apply)")
    .setChoiceValues([
      "Writing good product descriptions takes too long",
      "Picking the right category is confusing",
      "Filling in all required attributes is tedious",
      "Photos are hard to make look professional",
      "Getting rejected by the platform for errors",
      "Managing listings across multiple platforms",
      "I don't have major pain points"
    ]);

  // ─────────────────────────────────────────────
  // SECTION 3: Product Clarity & First Impressions
  // ─────────────────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle("Section 3: First Impressions")
    .setHelpText("Based on what you've seen so far about PandaworldAi.");

  form.addMultipleChoiceItem()
    .setTitle("How clearly did you understand what PandaworldAi does after visiting the site?")
    .setChoiceValues([
      "Immediately understood it",
      "Understood it after reading a bit",
      "It was somewhat confusing",
      "I still don't fully understand it"
    ])
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle("In your own words, what does PandaworldAi do?")
    .setHelpText("There's no wrong answer — this helps us check if our message is clear.");

  const excitementScale = form.addScaleItem();
  excitementScale.setTitle("How excited are you about PandaworldAi after seeing it?")
    .setBounds(1, 5)
    .setLabels("Not excited", "Very excited")
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle("What was your first reaction when you saw PandaworldAi?")
    .setHelpText("E.g. 'I need this', 'Not for me', 'I'm curious', etc.");

  // ─────────────────────────────────────────────
  // SECTION 4: Features
  // ─────────────────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle("Section 4: Features")
    .setHelpText("Tell us what matters most to you.");

  const featureGrid = form.addGridItem();
  featureGrid.setTitle("How valuable is each feature to you?")
    .setRows([
      "Upload a photo → AI generates full listing",
      "AI-written product descriptions",
      "Auto category & attribute selection",
      "One-click push to Jumia",
      "Image enhancement / polish",
      "Bulk CSV export",
      "Price calculator with fee breakdown"
    ])
    .setColumns(["Not valuable", "Slightly valuable", "Valuable", "Very valuable", "Must-have"])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle("Which single feature would make you sign up immediately if it worked perfectly?")
    .setChoiceValues([
      "Photo → full listing in seconds",
      "One-click publish to Jumia",
      "AI-written descriptions",
      "Auto category selection",
      "Image polishing",
      "Bulk listing (many products at once)",
      "Price calculator"
    ])
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle("Is there a feature you expected to see but didn't?")
    .setHelpText("What's missing that would make this a must-have for you?");

  // ─────────────────────────────────────────────
  // SECTION 5: Pricing
  // ─────────────────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle("Section 5: Pricing")
    .setHelpText("We price in GHS (Ghanaian Cedis). Current plans: Free (GHS 0) → Starter (GHS 30/mo) → Pro (GHS 65/mo) → Business (GHS 120/mo).");

  form.addMultipleChoiceItem()
    .setTitle("Which plan would you most likely choose?")
    .setChoiceValues([
      "Free (5 uploads/month) — GHS 0",
      "Starter (30 uploads + 10 image polishes) — GHS 30/mo",
      "Pro (100 uploads + 30 polishes, bulk Jumia push) — GHS 65/mo",
      "Business (500 uploads + 150 polishes, analytics) — GHS 120/mo",
      "None — I wouldn't pay for this"
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle("Does the pricing feel fair for what PandaworldAi offers?")
    .setChoiceValues([
      "Very affordable — I'd pay more",
      "Fair — seems reasonable",
      "A bit expensive — I'd need to see it working first",
      "Too expensive for what it offers",
      "I can't tell without trying it"
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle("What would you expect to pay per month for a tool that saves you 2–3 hours of listing work?")
    .setChoiceValues([
      "Nothing — tools like this should be free",
      "GHS 1–20/month",
      "GHS 21–50/month",
      "GHS 51–100/month",
      "GHS 100+/month",
      "I'd pay per listing instead of a monthly fee"
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle("Would a free trial (no credit card required) make you more likely to sign up?")
    .setChoiceValues([
      "Yes, definitely",
      "Probably",
      "Unlikely",
      "No — I need social proof first"
    ])
    .setRequired(true);

  // ─────────────────────────────────────────────
  // SECTION 6: Trust & Barriers
  // ─────────────────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle("Section 6: Trust & Barriers")
    .setHelpText("Help us understand what might stop someone from using PandaworldAi.");

  form.addCheckboxItem()
    .setTitle("What concerns, if any, do you have about using PandaworldAi? (Select all that apply)")
    .setChoiceValues([
      "I'm not sure the AI-generated listings will be good quality",
      "I don't trust giving access to my Jumia account",
      "I'm worried about data privacy",
      "I think it will be too complicated to set up",
      "I'm not sure it will save me much time",
      "I prefer doing listings manually",
      "I have no concerns",
      "Other"
    ]);

  form.addMultipleChoiceItem()
    .setTitle("How important is it that PandaworldAi is built specifically for Jumia sellers in Africa?")
    .setChoiceValues([
      "Very important — that's why I'm interested",
      "Somewhat important",
      "Neutral — I'd use it regardless of the focus",
      "Not important — I want multi-platform support"
    ])
    .setRequired(true);

  // ─────────────────────────────────────────────
  // SECTION 7: Likelihood to Use & Recommend
  // ─────────────────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle("Section 7: Likelihood to Use & Recommend");

  form.addMultipleChoiceItem()
    .setTitle("How likely are you to sign up for PandaworldAi?")
    .setChoiceValues([
      "I'll sign up immediately",
      "Very likely — once I see it working",
      "Maybe — I need to see reviews/results first",
      "Unlikely",
      "Definitely not"
    ])
    .setRequired(true);

  const npsScale = form.addScaleItem();
  npsScale.setTitle("On a scale of 0–10, how likely are you to recommend PandaworldAi to another seller?")
    .setBounds(0, 10)
    .setLabels("Would not recommend", "Would definitely recommend")
    .setRequired(true);

  // ─────────────────────────────────────────────
  // SECTION 8: Open Feedback
  // ─────────────────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle("Section 8: Open Feedback")
    .setHelpText("Your words matter most here.");

  form.addParagraphTextItem()
    .setTitle("What is the ONE thing that would make PandaworldAi a must-have for you?");

  form.addParagraphTextItem()
    .setTitle("What is the ONE thing you'd change or improve right now?");

  form.addMultipleChoiceItem()
    .setTitle("Overall, how would you rate PandaworldAi as a product idea?")
    .setChoiceValues([
      "⭐⭐⭐⭐⭐ — Great idea, well executed",
      "⭐⭐⭐⭐ — Good idea, needs some polish",
      "⭐⭐⭐ — Decent idea, significant improvements needed",
      "⭐⭐ — Weak idea, major rethink needed",
      "⭐ — Not something I'd use"
    ])
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle("Any other thoughts, suggestions, or feedback?")
    .setHelpText("Anything at all — we read every response.");

  // Optional: leave contact for follow-up
  form.addTextItem()
    .setTitle("Would you be open to a 10-minute follow-up call? If yes, drop your WhatsApp or email.")
    .setHelpText("Completely optional — we'd love to chat with real users.");

  // ─────────────────────────────────────────────
  // Log the output URLs
  // ─────────────────────────────────────────────
  Logger.log("✅ Form created successfully!");
  Logger.log("📋 Edit URL (share with respondents): " + form.getPublishedUrl());
  Logger.log("📊 Response sheet: open the form editor → Responses → Link to Sheets");
  Logger.log("🔗 Form ID: " + form.getId());
}
