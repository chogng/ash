use super::source_digest;
use std::path::PathBuf;

struct Fixture(PathBuf);

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).expect("remove client fixture");
    }
}

#[test]
fn client_identity_matches_normalized_source_paths_and_rejects_stale_content() {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let fixture = Fixture(
        std::env::temp_dir().join(format!("ash-editor-client-{}-{nonce}", std::process::id())),
    );
    let root = &fixture.0;
    std::fs::create_dir_all(root.join("browser")).expect("browser sources");
    assert_eq!(
        source_digest(root),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    std::fs::write(root.join("browser/z.css"), ".z {}\n").expect("style");
    std::fs::write(root.join("browser/a.ts"), "export const a = 1;\n").expect("module");
    std::fs::create_dir(root.join("common")).expect("common sources");
    std::fs::write(root.join("common/m.ts"), "export {};\n").expect("common module");
    std::fs::write(root.join("browser/readme.md"), "Not executable source").expect("documentation");
    let before = source_digest(root);
    assert_eq!(
        before,
        "41fd4bce3e782b963b8ad93f0b63830890166b52327e99f4de8162f338f6dfe3"
    );
    std::fs::write(root.join("browser/readme.md"), "Updated documentation")
        .expect("documentation edit");
    assert_eq!(source_digest(root), before);
    std::fs::write(root.join("browser/a.ts"), "export const a = 2;\n").expect("client update");
    assert_ne!(source_digest(root), before);
}
