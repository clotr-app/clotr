use std::path::PathBuf;

#[test]
fn release_build_embeds_the_namespaced_per_monitor_v2_manifest() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let manifest = std::fs::read_to_string(root.join("windows-app-manifest.xml")).expect("manifest reads");
    let build = std::fs::read_to_string(root.join("build.rs")).expect("build script reads");

    assert!(manifest.contains("xmlns=\"http://schemas.microsoft.com/SMI/2005/WindowsSettings\""));
    assert!(manifest.contains("<dpiAware>true/pm</dpiAware>"));
    assert!(manifest.contains(
        "<dpiAwareness xmlns=\"http://schemas.microsoft.com/SMI/2016/WindowsSettings\">PerMonitorV2</dpiAwareness>"
    ));
    assert!(build.contains("app_manifest(include_str!(\"windows-app-manifest.xml\"))"));
}
