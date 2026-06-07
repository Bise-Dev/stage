# ADR-0017 · Onboarding rail removal + global auth-status chip (sign-in is a status, not a step)

**Status:** accepted
**Date:** 2026-06-07

## Context

ADR-0013 made **local-only mode** a first-class app state but kept `signIn` as the conceptual boot gate, and explicitly left one thing **owed**: a concrete in-app "upgrade local-only to signed-in" trigger. It could not attach yet because the signed-in surfaces were not reachable from the local-only Self-Review screen.

Two things in the live UI still contradict the glossary:

1. **The onboarding wizard rail.** `client/src/screens/onboarding/OpenRepository.tsx` renders `WizardRail.tsx`, a left panel framing "1 · Sign in / 2 · Open repository" as **mandatory sequential steps**. This reads as "you must sign in first", which is exactly what ADR-0013 and `CONTEXT.md` (**Local-only mode**, **Self-Review**) say is not true. The rail also carries a "Heads up" reassurance box.
2. **Identity lives in one corner.** Signed-in identity and Sign out exist only inside the Workspaces left-rail `RepoMenu`, invisible from the local-capable screens (repo picker, Repo home, Self-Review). There is no app-wide signal of whether you are signed in.

The auth model is single-axis (ADR-0001): the client holds only a Stage session token; "Continue with GitHub" is GitHub-as-IdP. So "signed in or not" is one boolean, well suited to one small global indicator.

## Decision

Keep ADR-0013's boot model untouched and change only **post-boot presentation** plus the **in-app auth affordance**.

1. **Remove the wizard rail** from `OpenRepository` (both the step list and the "Heads up" box, which live inside it). **Delete `WizardRail.tsx`** (used nowhere else). The repo content becomes full-width.

2. **Sign-in becomes a status, not a step:** a global **`AuthStatus`** chip in the `TitleBar` right slot, present on every screen from one TitleBar edit. It is backed by a small **`AuthContext`** exposing `{ user, localOnly, markAuthenticated, signOut }` so the TitleBar reads auth state without prop-drilling. `App.tsx` stays the source of truth and supplies the context value.
   - **Signed in** -> `Avatar` + login; a small menu offers **Sign out**.
   - **Local-only** -> a **"Sign in"** button runs the existing device/web flow (`lib/auth.ts::runWebFlow`) **inline** (idle, "Continue in your browser..." + Cancel, error/retry), calling `markAuthenticated` on success. No navigation, context preserved. This is the in-app upgrade trigger ADR-0013 left owed.
   - **Self-hidden** when `!user && !localOnly`, which is exactly the boot SignIn screen, so the chip never doubles up there. No extra prop needed.

3. **Sign-out lands in local-only in place:** clear the user, set `localOnly = true`, and redirect to Repo home only when leaving a signed-in-only screen (Workspaces / Storyline / Review); otherwise stay put and the chip flips to "Sign in". No bounce to the SignIn gate.

4. **Identity leaves Workspaces.** Remove the **Sign out** item (and its divider) from the Workspaces `RepoMenu`, and drop the now-unused `onSignOut` prop from `RepoMenu` and `Workspaces`. "Change repository..." and "Reveal in Finder" stay (they are repo actions, not identity). `App.tsx` stops passing `onSignOut` to `Workspaces`.

5. **Boot is unchanged, but Option A is now a cheap fast-follow.** ADR-0013's SignIn-first + "Stay offline" boot table stands verbatim here. ADR-0013 rejected "Option A" (boot into the repo picker, sign-in goes lazy at the backend boundary) partly because it would "spread the sign-in trigger across every backend call site". This ADR centralizes that trigger in one `AuthStatus` chip + `AuthContext` instead, which dissolves that specific objection. Flipping boot to the repo picker is therefore now low-cost. It is deferred from this change to keep the scope focused and to preserve the first-run SignIn screen's legibility, and would still want a short superseding note on ADR-0013 when undertaken. The same fast-follow should also consider making "Stay offline" **sticky** (persist the local-only choice so a committed local-only author skips the SignIn screen on later launches, and `stage open` lands straight in Self-Review). ADR-0013 made local-only non-sticky to avoid a stuck-offline trap, an objection the always-visible chip also dissolves. Persisted-local-only and boot-into-repo-picker are the same boot-table change, so they belong in one follow-up.

## Considered alternatives

- **Onboarding-only chip, or an inline content-header chip on the repo screen.** Rejected: a status that appears on one screen reads as incidental. `TitleBar` already has an unused `right` slot built for exactly this, gives one consistent home on every screen, and lets the global chip subsume the Workspaces sign-out (dedup).
- **Route to the SignIn screen for in-app sign-in.** Rejected: a full-screen context switch reintroduces the gate feel this change removes. The web flow opens the browser regardless, so keeping the trigger and its pending/error state in the chip is strictly more contextual.
- **Keep `signOut` routing to the SignIn screen (today's behavior).** Rejected: bouncing to the gate on sign-out contradicts "sign-in is not mandatory". In-place local-only keeps the author working; the chip is the way back in.

## Consequences

**Positive:**

- The UI finally honors the glossary: sign-in is a reversible status, not a sequential step; local-only is a non-degraded choice.
- Satisfies the inline-upgrade trigger ADR-0013 recorded as owed.
- One consistent identity surface app-wide, replacing the single-screen Workspaces menu.
- The repo screen is cleaner and full-width.
- Centralizing the sign-in trigger in the chip de-risks a later move to boot-into-repo-picker (ADR-0013 Option A): the reason it was rejected (a trigger spread across every backend call site) no longer applies. The always-visible chip likewise dissolves ADR-0013's reason for keeping local-only non-sticky (being stuck offline with no way out), so a future "remember Stay offline" rides the same fast-follow.

**Negative / notes:**

- `TitleBar` now depends on `AuthContext` and must render inside `AuthProvider` (App wraps its rendered view). `AuthStatus` self-hides before a choice is made, so the boot SignIn screen stays clean.
- Interactive controls inside the macOS drag-region title bar must opt out of dragging (`data-tauri-drag-region={false}` on the chip's buttons) so clicks are not swallowed.
- The "Heads up / reads from .git, never modifies your working tree" reassurance is dropped from the rail. Equivalent copy already exists on the SignIn screen ("Stage runs locally, your code never leaves your machine") and in the repo dropzone ("Stage reads from .git, it doesn't modify your working tree"), so the message is not lost.
- `CONTEXT.md` **Local-only mode** currently says the in-app upgrade button does not exist yet (carried over from ADR-0013). That caveat is now satisfied and the entry should be updated to point at the `AuthStatus` chip.

## Reference

- ADR-0013 (client session persistence + local-only mode; the owed inline-upgrade trigger), ADR-0001 (single Stage session; no GitHub credentials on the client), ADR-0016 (Repo home is the local-only home).
- New: `client/src/lib/authContext.tsx`, `client/src/components/AuthStatus.tsx`.
- Changed: `client/src/components/TitleBar.tsx`, `client/src/App.tsx`, `client/src/screens/onboarding/OpenRepository.tsx`, `client/src/screens/workspaces/Workspaces.tsx`.
- Deleted: `client/src/screens/onboarding/WizardRail.tsx`.
- `CONTEXT.md` **Local-only mode**, **Self-Review**.
