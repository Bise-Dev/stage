# Review comments draft locally and submit as one GitHub review

**Status:** accepted — supersedes ADR-0003's write-through principle for *composing* a review
**Date:** 2026-08-19

When reviewing a PR, inline comments no longer post to GitHub one by one. They accumulate in the local store as drafts — each tagged with a severity (**blocking / suggestion / nit**) — together with an overall comment and a verdict chosen on the Finish-review summary. Submission is a single GitHub "create review" call: `body` = overall comment, `event` = verdict, `comments[]` = the inline drafts, severity rendered as a bold prefix in each body (GitHub has no severity field). This matches reviewer etiquette (one notification, one coherent review), lets drafting work offline, and gives Stage a place to hang severities and the summary screen.

Write-through survives where it belongs: replies inside an existing GitHub thread, thread resolve/reopen, and verdicts on already-submitted reviews still hit GitHub immediately. GitHub's native server-side PENDING review was considered and rejected — it forces auth+network on every keystroke and a heavier GraphQL surface for no user-visible gain.
