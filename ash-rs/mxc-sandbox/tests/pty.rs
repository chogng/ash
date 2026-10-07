use libtest_mimic::Arguments;
#[cfg(windows)]
use libtest_mimic::Trial;
#[cfg(windows)]
use test_binary_support::TestBinary;

#[cfg(unix)]
#[path = "pty/cases.rs"]
mod cases;

#[cfg(windows)]
fn helper() -> TestBinary {
    TestBinary::role(mxc_sandbox::PTY_HELPER_ARGUMENT).unwrap()
}

fn main() {
    #[cfg(windows)]
    helper().dispatch(mxc_sandbox::run_pty_helper);
    #[cfg(windows)]
    let tests = vec![Trial::test("helper_requires_a_launch_request", || {
        let output = helper()
            .command()
            .env_remove("ASH_MXC_PTY_REQUEST")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains("missing PTY launch request")
        );
        Ok(())
    })];
    #[cfg(unix)]
    let tests = cases::trials();
    libtest_mimic::run(&Arguments::from_args(), tests).exit();
}
