use super::TestBinary;

fn helper() -> TestBinary {
    TestBinary::test(module_path!(), "child").unwrap()
}

#[test]
#[ignore = "started by the parent process test"]
fn child() {
    helper().dispatch(|| -> Result<i32, std::io::Error> {
        let directory = std::env::var_os("TEST_BINARY_DIRECTORY").unwrap();
        std::fs::write(std::path::Path::new(&directory).join("ran"), "child")?;
        Ok(0)
    });
}

#[test]
fn selected_test_runs_in_a_child_with_its_own_environment() {
    let directory = tempfile::tempdir().unwrap();
    let previous = std::env::var_os("TEST_BINARY_DIRECTORY");
    let output = helper()
        .command()
        .env("TEST_BINARY_DIRECTORY", directory.path())
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        std::fs::read(directory.path().join("ran")).unwrap(),
        b"child"
    );
    assert_eq!(std::env::var_os("TEST_BINARY_DIRECTORY"), previous);
}

#[test]
fn ordinary_tests_do_not_dispatch_a_helper() {
    helper().dispatch(|| -> Result<i32, String> { panic!("helper ran in the parent") });
}
