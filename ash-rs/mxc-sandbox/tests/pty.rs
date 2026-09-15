use libtest_mimic::Arguments;
use libtest_mimic::Trial;
use test_binary_support::TestBinary;

#[cfg(target_os = "macos")]
#[path = "pty/cases.rs"]
mod cases;

fn helper() -> TestBinary {
    TestBinary::role(mxc_sandbox::PTY_HELPER_ARGUMENT).unwrap()
}

fn main() {
    helper().dispatch(mxc_sandbox::run_pty_helper);
    let mut tests = vec![Trial::test("helper_requires_a_launch_request", || {
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
    // These scenarios exercise Seatbelt. Linux and Windows require their respective
    // sandbox backends on a real host; compiling this target does not validate them.
    if cfg!(target_os = "macos") {
        #[cfg(target_os = "macos")]
        tests.extend(cases::trials());
    } else {
        tests.push(
            Trial::test("pty_process_scenarios_require_macos", || Ok(())).with_ignored_flag(true),
        );
    }
    libtest_mimic::run(&Arguments::from_args(), tests).exit();
}
