/**
 * Ship-scope flags — what the current version of Stage actually supports.
 *
 * Stage today ships exactly one feature: the author's local **Self-Review**,
 * with the coding agent's **Debrief** folded into it. Everything downstream of
 * **Ready to share** — the Review artifact, Storyline composition, Publish,
 * reviewer entry, and Verdicts (see `CONTEXT.md`) — is built and tested but
 * **not supported yet**, so its UI is hidden behind this flag rather than
 * deleted (ADR-0028).
 *
 * Flip to `true` to bring the whole review surface back; no other change is
 * needed. The Rust engine, the local store, and the `.stage` folder format are
 * untouched by this flag — it gates the webview's entry points only.
 *
 * Typed as `boolean` (not the `false` literal) on purpose: the gated branches
 * must stay type-checked and reachable to the compiler, so they can't rot while
 * they're switched off.
 */
export const REVIEW_SURFACE_ENABLED: boolean = false;
