fn main() {
    // The `e2e` capability (`capabilities/e2e.json`) grants `wdio-webdriver:default`,
    // a permission that only exists when the optional `tauri-plugin-wdio-webdriver`
    // dependency is actually compiled in (see Cargo.toml's `e2e` feature). tauri-build
    // validates every capability file it scans against the permissions of the plugins
    // that are actually linked, so scanning `e2e.json` on a non-e2e build would fail
    // with "permission not found". Restrict the glob to `default.json` alone unless
    // the `e2e` feature is enabled, in which case widen it to pick up both files.
    let capabilities_pattern = if cfg!(feature = "e2e") {
        "./capabilities/**/*"
    } else {
        "./capabilities/default.json"
    };
    // Required by `capabilities_path_pattern`'s contract since tauri-build no longer
    // emits this itself for a custom pattern.
    println!("cargo:rerun-if-changed=capabilities");

    let attributes = tauri_build::Attributes::new().capabilities_path_pattern(capabilities_pattern);

    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("{error:#}");
    }
}
