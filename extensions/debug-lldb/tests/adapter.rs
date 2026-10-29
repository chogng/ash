#![cfg(windows)]

use serde_json::json;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;

fn powershell() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe")
}

#[test]
fn tcp_adapter_keeps_target_output_framed_and_reaps_its_process_on_eof_or_kill() {
    enum Shutdown {
        InputEof,
        KillBridge,
    }
    for shutdown in [Shutdown::InputEof, Shutdown::KillBridge] {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("peer.ps1");
        std::fs::write(
            &script,
            r#"
$ErrorActionPreference = 'Stop'
$client = [Net.Sockets.TcpClient]::new('127.0.0.1', [int]$args[-1])
[IO.File]::WriteAllText((Join-Path $env:ASH_LLDB_TEST_DIRECTORY 'peer.pid'), [string]$PID)
[Console]::Out.WriteLine('target-stdout-probe')
[Console]::Error.WriteLine('target-stderr-probe')
$stream = $client.GetStream()
$buffer = [byte[]]::new(8192)
while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
    $stream.Write($buffer, 0, $count)
    $stream.Flush()
}
$client.Close()
"#,
        )
        .unwrap();
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_ash-debug-lldb"))
            .args(["--stdio-adapter", "无法连接 CodeLLDB 调试适配器"])
            .arg(powershell())
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
            .arg(format!("& {{ {} }}", std::fs::read_to_string(&script).unwrap()))
            .env("ASH_LLDB_TEST_DIRECTORY", root.path())
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .creation_flags(0x08000000).kill_on_drop(true).spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let request = json!({"seq":7,"type":"request","command":"initialize","arguments":{"probe":"unchanged"}});
        stdin.write_all(&ash_debug_adapter::encode_message(&request).unwrap()).await.unwrap();
        let mut echo = false;
        let mut out = String::new();
        let mut err = String::new();
        tokio::time::timeout(Duration::from_secs(20), async {
            while !echo || !out.contains("target-stdout-probe") || !err.contains("target-stderr-probe") {
                let Some(message) = ash_debug_adapter::read_message(&mut stdout).await.unwrap() else {
                    let mut error = String::new();
                    child.stderr.take().unwrap().read_to_string(&mut error).await.unwrap();
                    panic!("adapter bridge closed early: {error}; output={out:?}; stderr={err:?}");
                };
                if message == request { echo = true; }
                else {
                    assert_eq!(message["event"], "output");
                    match message["body"]["category"].as_str().unwrap() {
                        "stdout" => out.push_str(message["body"]["output"].as_str().unwrap()),
                        "stderr" => err.push_str(message["body"]["output"].as_str().unwrap()),
                        value => panic!("unexpected output category {value}"),
                    }
                }
            }
        }).await.unwrap();
        match shutdown {
            Shutdown::InputEof => drop(stdin),
            Shutdown::KillBridge => child.start_kill().unwrap(),
        }
        let result = tokio::time::timeout(Duration::from_secs(10), child.wait()).await.unwrap().unwrap();
        if matches!(shutdown, Shutdown::InputEof) { assert!(result.success()); }
    });
        let pid = std::fs::read_to_string(root.path().join("peer.pid")).unwrap();
        let status = std::process::Command::new(powershell())
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!("if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 1 }}"),
            ])
            .output()
            .unwrap();
        assert!(status.status.success(), "adapter survived its bridge");
    }
}

#[test]
fn tcp_adapter_rejects_competing_transport_arguments_with_localized_context() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_ash-debug-lldb"))
        .args([
            "--stdio-adapter",
            "无法连接 CodeLLDB 调试适配器",
            "unused",
            "--port=1",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("无法连接 CodeLLDB 调试适配器")
    );
    assert!(output.stdout.is_empty());
}
