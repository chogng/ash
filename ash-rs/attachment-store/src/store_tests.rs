use std::sync::Arc;

use ash_protocol::ContentDigest;

use crate::AttachmentStore;
use crate::AttachmentStoreError;
use crate::FileAttachmentStore;
use crate::MAX_ATTACHMENT_BYTES;
use crate::MemoryAttachmentStore;

#[test]
fn stores_enforce_byte_identity_and_size() {
    let root = tempfile::tempdir().unwrap();
    let stores: [Box<dyn AttachmentStore>; 2] = [
        Box::new(MemoryAttachmentStore::default()),
        Box::new(FileAttachmentStore::open(root.path()).unwrap()),
    ];
    let bytes: Arc<[u8]> = Arc::from(b"attachment bytes".as_slice());
    for store in stores {
        let digest = store.put(Arc::clone(&bytes)).unwrap();
        assert_eq!(digest, ContentDigest::sha256(&bytes));
        assert_eq!(store.put(Arc::clone(&bytes)).unwrap(), digest);
        assert_eq!(store.read(&digest, bytes.len() as u64).unwrap(), bytes);
        assert!(matches!(
            store.read(&digest, bytes.len() as u64 + 1),
            Err(AttachmentStoreError::Corrupt)
        ));
        assert!(matches!(
            store.read(&ContentDigest::sha256(b"missing"), 7),
            Err(AttachmentStoreError::NotFound)
        ));
        for invalid_size in [0, MAX_ATTACHMENT_BYTES + 1] {
            assert!(matches!(
                store.put(vec![0; invalid_size].into()),
                Err(AttachmentStoreError::TooLarge)
            ));
            assert!(matches!(
                store.read(&digest, invalid_size as u64),
                Err(AttachmentStoreError::TooLarge)
            ));
        }
    }
}

#[test]
fn file_store_reopens_existing_digest_layout() {
    let root = tempfile::tempdir().unwrap();
    let bytes: Arc<[u8]> = Arc::from(b"persisted attachment".as_slice());
    let digest = ContentDigest::sha256(&bytes);
    let hex = digest.as_str().strip_prefix("sha256:").unwrap();
    let directory = root.path().join("sha256").join(&hex[..2]);
    std::fs::create_dir_all(&directory).unwrap();
    let object = directory.join(hex);
    std::fs::write(&object, &bytes).unwrap();

    let store = FileAttachmentStore::open(root.path()).unwrap();
    assert_eq!(store.read(&digest, bytes.len() as u64).unwrap(), bytes);
    assert_eq!(store.put(Arc::clone(&bytes)).unwrap(), digest);
    assert_eq!(std::fs::read_dir(directory).unwrap().count(), 1);
    assert_eq!(std::fs::read(object).unwrap().as_slice(), bytes.as_ref());
}

#[test]
fn file_store_rejects_corruption_on_read_and_duplicate_write() {
    let root = tempfile::tempdir().unwrap();
    let store = FileAttachmentStore::open(root.path()).unwrap();
    let bytes: Arc<[u8]> = Arc::from(b"original".as_slice());
    let digest = store.put(Arc::clone(&bytes)).unwrap();
    let object = store.path_for(&digest);
    std::fs::write(&object, b"modified").unwrap();

    assert!(matches!(
        store.read(&digest, bytes.len() as u64),
        Err(AttachmentStoreError::Corrupt)
    ));
    assert!(matches!(
        store.put(bytes),
        Err(AttachmentStoreError::Corrupt)
    ));
    assert_eq!(std::fs::read(object).unwrap(), b"modified");
}

#[cfg(unix)]
#[test]
fn file_store_rejects_a_symlinked_digest_directory() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let store = FileAttachmentStore::open(root.path()).unwrap();
    let first = store.put(Arc::from(b"first".as_slice())).unwrap();
    std::fs::remove_dir_all(root.path().join("sha256")).unwrap();
    symlink(outside.path(), root.path().join("sha256")).unwrap();

    assert!(matches!(
        store.put(Arc::from(b"second".as_slice())),
        Err(AttachmentStoreError::Corrupt)
    ));
    assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none());
    assert!(matches!(
        store.read(&first, 5),
        Err(AttachmentStoreError::Corrupt)
    ));
}

#[cfg(unix)]
#[test]
fn file_store_rejects_a_symlinked_attachment_object() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let store = FileAttachmentStore::open(root.path()).unwrap();
    let bytes: Arc<[u8]> = Arc::from(b"attachment".as_slice());
    let digest = store.put(Arc::clone(&bytes)).unwrap();
    let object = store.path_for(&digest);
    let outside_object = outside.path().join("object");
    std::fs::write(&outside_object, &bytes).unwrap();
    std::fs::remove_file(&object).unwrap();
    symlink(&outside_object, &object).unwrap();

    assert!(matches!(
        store.read(&digest, bytes.len() as u64),
        Err(AttachmentStoreError::Corrupt)
    ));
    assert!(outside_object.is_file());
}
