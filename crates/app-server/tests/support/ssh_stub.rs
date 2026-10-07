//! Map the simulated POSIX host's directory into the Windows test directory.
//! Request handling and persistence still run in the real App Server.

use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::process::Command;
use std::process::ExitCode;
use std::process::Stdio;
use std::thread;

fn main() -> io::Result<ExitCode> {
    let mut child = Command::new(std::env::var_os("ASH_TEST_SERVER").unwrap())
        .args(["--listen", "stdio://"])
        .env(
            "ASH_HOME",
            std::env::var_os("ASH_TEST_REMOTE_HOME").unwrap(),
        )
        .env(
            "ASH_WORKSPACE_ROOT",
            std::env::var_os("ASH_TEST_REMOTE_DIR").unwrap(),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let local_root = std::env::var("ASH_TEST_LOCAL_ROOT_JSON").unwrap();
    let input_root = local_root.clone();
    thread::spawn(move || -> io::Result<()> {
        for line in io::stdin().lock().lines() {
            writeln!(
                input,
                "{}",
                line?.replace("\"/remote/project\"", &input_root)
            )?;
            input.flush()?;
        }
        Ok(())
    });
    println!("{{\"jsonrpc\":\"2.0\",\"method\":\"queue/changed\",\"params\":{{}}}}");
    for line in BufReader::new(output).lines() {
        println!("{}", line?.replace(&local_root, "\"/remote/project\""));
    }
    let status = child.wait()?;
    Ok(if status.success() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}
