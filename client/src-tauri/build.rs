use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    stamp_build_time();
    tauri_build::build()
}

/// Bake the moment this binary was compiled into it as `STAGE_BUILD_TIMESTAMP`
/// (Unix epoch seconds), so the app's About section can tell the user how fresh
/// their installed copy is.
///
/// `just build` / `just install-app` / `just install-cli` pass a fresh
/// `STAGE_BUILD_TIMESTAMP` on every packaged build; the paired
/// `rerun-if-env-changed` below is what keeps the stamp honest, forcing this
/// script to re-run rather than letting cargo bake a cached (stale) timestamp
/// into a freshly compiled binary. A plain `cargo build` sets no variable and
/// falls back to the moment this script ran.
fn stamp_build_time() {
    println!("cargo:rerun-if-env-changed=STAGE_BUILD_TIMESTAMP");

    let stamp = match std::env::var("STAGE_BUILD_TIMESTAMP") {
        Ok(raw) if !raw.trim().is_empty() => raw
            .trim()
            .parse::<i64>()
            // Fail loud: a malformed stamp would otherwise reach About as a
            // fabricated or blank build time.
            .unwrap_or_else(|e| {
                panic!("STAGE_BUILD_TIMESTAMP must be Unix epoch seconds, got {raw:?}: {e}")
            }),
        _ => SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is before the Unix epoch")
            .as_secs() as i64,
    };

    println!("cargo:rustc-env=STAGE_BUILD_TIMESTAMP={stamp}");
}
