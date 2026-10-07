use ash_app_server_protocol::protocol::initialize::ProtocolVersion;
use ash_app_server_protocol::schema_hash;

#[test]
fn compiled_protocol_matches_generated_metadata_and_client() {
    let metadata: serde_json::Value =
        serde_json::from_str(include_str!("../../../.build/protocol/metadata.json")).unwrap();
    let version = ProtocolVersion::current();
    assert_eq!(
        metadata,
        serde_json::json!({
            "major": version.major,
            "schemaHash": schema_hash(),
        })
    );
    let typescript = include_str!("../../../.build/protocol/typescript/protocol.ts");
    let expected = format!(
        "export const APP_SERVER_SCHEMA_HASH = {:?} as const;",
        schema_hash()
    );
    assert!(typescript.lines().any(|line| line == expected));
}

#[cfg(feature = "export")]
#[test]
fn prepared_contract_matches_the_rust_generators() {
    use ash_app_server_protocol::json_schema;
    use ash_app_server_protocol::protocol_metadata;
    use ash_app_server_protocol::typescript_files;
    use std::path::Path;
    use std::path::PathBuf;

    fn generated_fixture_paths(root: &Path) -> Vec<PathBuf> {
        let mut paths = Vec::new();
        let mut pending_directories = vec![root.to_path_buf()];
        while let Some(directory) = pending_directories.pop() {
            for entry in std::fs::read_dir(directory).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                if entry.file_type().unwrap().is_dir() {
                    pending_directories.push(path);
                } else {
                    paths.push(path.strip_prefix(root).unwrap().to_path_buf());
                }
            }
        }
        paths.sort();
        paths
    }

    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.build/protocol");
    assert_eq!(
        std::fs::read_to_string(directory.join("json/schema.json"))
            .unwrap()
            .replace("\r\n", "\n"),
        json_schema()
    );
    assert_eq!(
        std::fs::read_to_string(directory.join("metadata.json"))
            .unwrap()
            .replace("\r\n", "\n"),
        protocol_metadata()
    );
    let typescript = directory.join("typescript");
    let files = typescript_files();
    let mut expected = files
        .iter()
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    expected.sort();
    assert_eq!(generated_fixture_paths(&typescript), expected);
    for (path, expected) in files {
        assert_eq!(
            std::fs::read_to_string(typescript.join(&path))
                .unwrap()
                .replace("\r\n", "\n"),
            expected.replace("\r\n", "\n"),
            "{}",
            path.display()
        );
    }
}
