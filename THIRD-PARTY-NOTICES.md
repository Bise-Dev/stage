# Third-party notices

Stage is licensed under the [MIT License](./LICENSE). It depends on third-party
packages fetched at build time (Rust crates via `client/Cargo.lock`, npm packages
via `client/bun.lock`); each remains under its own license. As of the last audit,
every dependency is under a permissive license (MIT, Apache-2.0, BSD, ISC, Zlib,
Unicode, CC0, or similar), with the exceptions noted below. No GPL-, AGPL-, or
SSPL-licensed dependencies are used.

## MPL-2.0 dependencies

The following packages are licensed under the Mozilla Public License 2.0
(file-level copyleft; used unmodified, which the MPL permits in a work under a
different license):

- Rust crates: `cssparser`, `cssparser-macros`, `dtoa-short`, `selectors`
  (via Tauri), `option-ext` (via `directories`)
- npm packages: `lightningcss` (build-time CSS transformer used by Tailwind)

Source for each is available from its respective registry (crates.io / npm).

## libgit2

The `git2` crate statically links [libgit2](https://libgit2.org/), which is
licensed under **GPLv2 with a linking exception**. The linking exception
explicitly permits linking libgit2 into a program under different license terms.

## Regenerating the inventory

The license inventory can be re-checked with `cargo metadata` (the `license`
field of every resolved crate) or tooling such as `cargo deny check licenses` /
`cargo about`, and any npm license checker over `client/node_modules`.
