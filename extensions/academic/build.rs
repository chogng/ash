use sha2::Digest;
use sha2::Sha256;
use std::path::Path;
use std::path::PathBuf;

fn sources(directory: &Path, files: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(directory).expect("Academy client sources") {
        let entry = entry.expect("Academy source entry");
        let kind = entry.file_type().expect("Academy source kind");
        if kind.is_dir() {
            sources(&entry.path(), files);
        } else if kind.is_file()
            && entry
                .path()
                .extension()
                .is_some_and(|ext| ext == "ts" || ext == "css")
        {
            files.push(entry.path());
        }
    }
}

fn main() {
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let mut files = Vec::new();
    for directory in ["browser", "common"] {
        println!("cargo:rerun-if-changed={directory}");
        sources(&root.join(directory), &mut files);
    }
    files.sort();
    let mut digest = Sha256::new();
    for file in files {
        let relative = file.strip_prefix(&root).expect("client source path");
        digest.update(relative.to_string_lossy().replace('\\', "/").as_bytes());
        digest.update(b"\0");
        digest.update(std::fs::read(file).expect("client source bytes"));
        digest.update(b"\0");
    }
    println!(
        "cargo:rustc-env=ASH_ACADEMY_CLIENT_DIGEST=sha256:{:x}",
        digest.finalize()
    );
}
