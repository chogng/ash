use super::*;

#[test]
fn same_timestamp_directory_replacement_emits_a_root_identity_invalidation() {
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().canonicalize().unwrap().join("root");
    std::fs::create_dir(&root).unwrap();
    let modified = std::fs::metadata(&root).unwrap().modified().unwrap();
    let roots = Roots::from([(root.clone(), (RecursiveMode::Recursive, true))]);
    let mut previous = BTreeMap::from([(root.clone(), fingerprint(&root))]);
    std::fs::rename(&root, root.with_file_name("retired")).unwrap();
    std::fs::create_dir(&root).unwrap();
    std::fs::File::open(&root)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let (output, input) = UnixStream::pair().unwrap();
    input
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let output = Mutex::new(output);
    observe_root_identity(&roots, &mut previous, &output).unwrap();
    let mut input = BufReader::new(input);
    assert!(
        matches!(read_frame::<Reply>(&mut input).unwrap(), Some(Reply::Changed {
        kind: Change::Topology, paths,
    }) if paths == vec![root.as_os_str().as_bytes().to_vec()])
    );
    // The same identity does not continuously force another baseline scan.
    observe_root_identity(&roots, &mut previous, &output).unwrap();
    assert!(read_frame::<Reply>(&mut input).is_err());
}
