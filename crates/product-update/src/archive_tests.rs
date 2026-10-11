use super::PackageFormat;
use super::UpdatePolicy;
use super::extract_package;
use flate2::write::GzEncoder;
use std::fs;
use std::io::Write;
use tempfile::TempDir;

#[test]
fn update_preference_ignores_unrelated_frontend_values() {
    let settings =
        serde_json::json!({ "autoUpdate": "stable", "screenMode": false, "language": 42 });
    assert_eq!(
        UpdatePolicy::from_setting(settings.get("autoUpdate")).unwrap(),
        UpdatePolicy::Stable
    );
    assert_eq!(
        UpdatePolicy::from_setting(None).unwrap(),
        UpdatePolicy::Latest
    );
    for invalid in [
        serde_json::json!(true),
        serde_json::json!("unknown"),
        serde_json::Value::Null,
    ] {
        assert!(UpdatePolicy::from_setting(Some(&invalid)).is_err());
    }
}

#[test]
fn tar_updates_reject_duplicate_entries_and_links() {
    for duplicate in [true, false] {
        let root = TempDir::new().unwrap();
        let archive = root.path().join("update.tar.gz");
        let output = root.path().join("output");
        fs::create_dir(&output).unwrap();
        let mut builder = tar::Builder::new(GzEncoder::new(
            fs::File::create(&archive).unwrap(),
            flate2::Compression::default(),
        ));
        let mut header = tar::Header::new_gnu();
        header.set_size(1);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, "file", &b"a"[..]).unwrap();
        if duplicate {
            builder.append_data(&mut header, "file", &b"b"[..]).unwrap();
        } else {
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_link_name("file").unwrap();
            header.set_cksum();
            builder.append_data(&mut header, "link", &b""[..]).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
        assert!(extract_package(&archive, PackageFormat::TarGz, &output).is_err());
    }
}

#[test]
fn zip_updates_reject_duplicate_entries() {
    let root = TempDir::new().unwrap();
    let archive = root.path().join("update.zip");
    let mut writer = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
    for (name, contents) in [("file-a", b"a"), ("file-b", b"b")] {
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(contents).unwrap();
    }
    writer.finish().unwrap();
    let mut bytes = fs::read(&archive).unwrap();
    // Patch equal-length names because the writer correctly rejects duplicate filenames itself.
    for index in 0..=bytes.len() - 6 {
        if &bytes[index..index + 6] == b"file-b" {
            bytes[index..index + 6].copy_from_slice(b"file-a");
        }
    }
    fs::write(&archive, bytes).unwrap();
    let output = root.path().join("output");
    fs::create_dir(&output).unwrap();
    assert!(extract_package(&archive, PackageFormat::Zip, &output).is_err());
}
