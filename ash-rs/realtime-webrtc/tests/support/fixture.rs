// Adapted from OpenAI Codex; modified for Ash. See THIRD_PARTY_NOTICES.md.
//! Copies this test executable into a private package and dispatches its fake helper before libtest.
//! The fixture validates protocol order; it never loads platform libraries or opens audio devices.

use anyhow::Context;
use anyhow::Result;
use anyhow::ensure;
use realtime_webrtc::AudioState;
use realtime_webrtc::Message;
use realtime_webrtc::encode_frame;
use realtime_webrtc::read_message;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::thread;
use std::time::Duration;
use std::time::Instant;

pub const WAIT: Duration = Duration::from_secs(10);
const APP: &str = if cfg!(windows) { "ash.exe" } else { "ash" };
const HELPER: &str = if cfg!(windows) {
    "ash-voice-host.exe"
} else {
    "ash-voice-host"
};

pub fn wait_for(mut ready: impl FnMut() -> bool) -> Result<()> {
    let deadline = Instant::now() + WAIT;
    while !ready() {
        ensure!(Instant::now() < deadline, "fixture deadline expired");
        thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

#[cfg(unix)]
pub fn wait_for_helper_reaped(root: &std::path::Path) -> Result<()> {
    let pid = fs::read_to_string(root.join("helper-pid"))?.parse()?;
    let pid = rustix::process::Pid::from_raw(pid).context("invalid helper PID")?;
    // Permission errors do not prove that the process has exited.
    wait_for(|| rustix::process::test_kill_process(pid) == Err(rustix::io::Errno::SRCH))
}

// The child discovers its installation through current_exe, exactly as the public facade does.
pub fn package(test: &str) -> Result<Option<PathBuf>> {
    let source = std::env::current_exe()?;
    if source.file_name().is_some_and(|name| name == APP) {
        return Ok(Some(
            source
                .parent()
                .context("bin")?
                .parent()
                .context("package")?
                .to_owned(),
        ));
    }
    let package = tempfile::Builder::new().prefix("voice-actor-").tempdir()?;
    let root = package.path();
    fs::create_dir_all(root.join("bin"))?;
    fs::create_dir_all(root.join("ash-path"))?;
    fs::create_dir_all(root.join("ash-resources/voice/bin"))?;
    fs::write(root.join("ash-package.json"), "{}")?;
    fs::copy(&source, root.join("bin").join(APP))?;
    fs::copy(&source, root.join("ash-resources/voice/bin").join(HELPER))?;
    let mut child = Command::new(root.join("bin").join(APP))
        .args(["--exact", test, "--nocapture"])
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let deadline = Instant::now() + WAIT * 3;
    while child.try_wait()?.is_none() {
        if Instant::now() >= deadline {
            child.kill()?;
            child.wait()?;
            anyhow::bail!("packaged test timed out");
        }
        thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output()?;
    ensure!(
        output.status.success(),
        "packaged test failed: {}\n{}\nfixture: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
        fs::read_to_string(root.join("fixture-error")).unwrap_or_default()
    );
    Ok(None)
}

pub fn dispatch_helper() {
    if std::env::current_exe()
        .ok()
        .and_then(|path| path.file_name().map(std::ffi::OsStr::to_owned))
        .is_some_and(|name| name == HELPER)
    {
        if let Err(error) = helper() {
            let _ = fs::write("fixture-error", format!("{error:#}"));
            std::process::exit(1);
        }
        std::process::exit(0);
    }
}

#[derive(PartialEq)]
enum Stage {
    Hello,
    Initialize,
    Offer,
    Answer,
    Devices,
    Controls,
    Running,
}

fn helper() -> Result<()> {
    let root = std::env::current_dir()?;
    fs::write(root.join("helper-pid"), std::process::id().to_string())?;
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    let mut stage = Stage::Hello;
    let mut controls_history = Vec::new();
    while let Some(request) = read_message(&mut input)? {
        let response = match request {
            Message::Hello {
                protocol: 1,
                build_commit,
            } if stage == Stage::Hello => {
                ensure!(
                    Some(build_commit) == build_info::BuildInfo::current().commit,
                    "wrong executable build stamp"
                );
                stage = Stage::Initialize;
                Message::Ready {}
            }
            Message::InitializeRuntime {} if stage == Stage::Initialize => {
                fs::write(root.join("initializing"), [])?;
                if root.join("hold-initialization").exists() {
                    wait_for(|| root.join("release").exists())?;
                }
                if root.join("fail-initialization").exists() {
                    anyhow::bail!("synthetic private runtime diagnostic");
                }
                stage = Stage::Offer;
                Message::RuntimeReady {}
            }
            Message::StartTransport {} if stage == Stage::Offer => {
                stage = Stage::Answer;
                Message::Offer {
                    sdp: "synthetic-offer"
                        .to_owned()
                        .try_into()
                        .map_err(anyhow::Error::msg)?,
                }
            }
            Message::ApplyAnswer { sdp } if stage == Stage::Answer => {
                ensure!(
                    sdp.into_sdp() == "synthetic-answer",
                    "unexpected fixture answer"
                );
                fs::write(root.join("answer"), [])?;
                wait_for(|| root.join("release").exists())?;
                stage = Stage::Devices;
                Message::TransportReady {}
            }
            Message::OpenDevices {} if stage == Stage::Devices => {
                if root.join("fail-devices").exists() {
                    anyhow::bail!("synthetic private device diagnostic");
                }
                stage = Stage::Controls;
                Message::DevicesOpened {}
            }
            Message::SetAudioControls { controls }
                if stage == Stage::Controls || stage == Stage::Running =>
            {
                controls_history.push(controls);
                fs::write(
                    root.join("controls"),
                    serde_json::to_vec(&controls_history)?,
                )?;
                stage = Stage::Running;
                Message::AudioControlsApplied {}
            }
            Message::InspectAudio {} if stage == Stage::Answer || stage == Stage::Running => {
                if root.join("exit").exists() {
                    return Ok(());
                }
                Message::AudioState {
                    state: if stage == Stage::Running {
                        AudioState {
                            microphone_peak: 123,
                            speaker_peak: 456,
                        }
                    } else {
                        AudioState::default()
                    },
                }
            }
            Message::Close {} => {
                output.write_all(&encode_frame(&Message::Closed {})?)?;
                output.flush()?;
                return Ok(());
            }
            _ => anyhow::bail!("unexpected fixture protocol sequence"),
        };
        output.write_all(&encode_frame(&response)?)?;
        output.flush()?;
    }
    Ok(())
}
