/**
 * Shared look for Clerk's <SignIn>/<SignUp> widgets on the split-panel
 * auth pages (components/marketing/auth-split-layout.tsx) — orange to
 * match the brand (bg-orange-500 elsewhere on the site) instead of
 * Clerk's default blue, and the card stripped down to borderless/
 * shadowless/full-width so it reads as part of the page rather than a
 * widget dropped onto it. AuthSplitLayout already renders its own
 * heading, so Clerk's own header text is hidden to avoid a second one.
 */
export const CLERK_APPEARANCE = {
  variables: {
    colorPrimary: "#f97316",
    fontFamily: "inherit",
    borderRadius: "0.5rem",
  },
  elements: {
    rootBox: "w-full",
    card: "w-full gap-6 rounded-none border-0 bg-transparent p-0 shadow-none",
    header: "hidden",
    footer: "bg-transparent px-0 shadow-none",
    footerAction: "text-center",
    socialButtonsBlockButton: "border-zinc-200 text-zinc-700 hover:bg-zinc-50",
    dividerLine: "bg-zinc-200",
    dividerText: "text-zinc-400",
    formFieldLabel: "text-zinc-700",
    formFieldInput: "border-zinc-200 focus:border-orange-500 focus:ring-orange-500",
    formButtonPrimary: "bg-orange-500 hover:bg-orange-600 focus:shadow-none text-sm normal-case",
    footerActionLink: "text-orange-600 hover:text-orange-700",
    identityPreviewEditButton: "text-orange-600 hover:text-orange-700",
  },
};
