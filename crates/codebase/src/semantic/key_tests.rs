use crate::EmbeddingIndexKey;

#[test]
fn embedding_index_key_is_stable_and_changes_with_runtime_identity() {
    let first =
        EmbeddingIndexKey::for_device_model("ollama", "embed-v1", "runtime-a").expect("key");
    let same =
        EmbeddingIndexKey::for_device_model("ollama", "embed-v1", "runtime-a").expect("same key");
    let changed = EmbeddingIndexKey::for_device_model("ollama", "embed-v1", "runtime-b")
        .expect("changed key");

    assert_eq!(first, same);
    assert_ne!(first, changed);
    assert!(first.as_str().starts_with("semantic:sha256:"));
}
