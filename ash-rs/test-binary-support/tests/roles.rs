use libtest_mimic::Arguments;
use libtest_mimic::Trial;
use test_binary_support::TestBinary;

fn helper() -> TestBinary {
    TestBinary::role("--test-helper").unwrap()
}

fn main() {
    helper().dispatch(|| -> Result<i32, String> {
        let value = std::env::var("TEST_BINARY_VALUE").map_err(|error| error.to_string())?;
        std::fs::write("ran", &value).map_err(|error| error.to_string())?;
        print!("{value}");
        Ok(17)
    });
    libtest_mimic::run(
        &Arguments::from_args(),
        vec![
            Trial::test(
                "role_preserves_stdio_exit_code_and_child_environment",
                || {
                    let directory = tempfile::tempdir().unwrap();
                    let original = std::env::current_dir().unwrap();
                    let output = helper()
                        .command()
                        .current_dir(directory.path())
                        .env("TEST_BINARY_VALUE", "value")
                        .output()
                        .unwrap();
                    assert_eq!(output.status.code(), Some(17));
                    assert_eq!(output.stdout, b"value");
                    assert!(output.stderr.is_empty());
                    assert_eq!(
                        std::fs::read(directory.path().join("ran")).unwrap(),
                        b"value"
                    );
                    assert_eq!(std::env::current_dir().unwrap(), original);
                    Ok(())
                },
            ),
            Trial::test("malformed_role_fails_before_execution", || {
                let directory = tempfile::tempdir().unwrap();
                let output = helper()
                    .command()
                    .arg("unexpected")
                    .current_dir(directory.path())
                    .env("TEST_BINARY_VALUE", "value")
                    .output()
                    .unwrap();
                assert_eq!(output.status.code(), Some(2));
                assert!(!directory.path().join("ran").exists());
                Ok(())
            }),
            Trial::test("helper_error_is_a_failed_process", || {
                let output = helper()
                    .command()
                    .env_remove("TEST_BINARY_VALUE")
                    .output()
                    .unwrap();
                assert_eq!(output.status.code(), Some(1));
                assert!(output.stdout.is_empty());
                assert!(
                    String::from_utf8(output.stderr)
                        .unwrap()
                        .contains("test helper failed")
                );
                Ok(())
            }),
        ],
    )
    .exit();
}
