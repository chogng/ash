// Adapted from OpenAI Codex; modified for Ash. See THIRD_PARTY_NOTICES.md.
//! Exercises the public session actor against a separate framed-IPC helper, without platform audio.

#[path = "support/fixture.rs"]
mod common;

use anyhow::Result;
use futures::future::AbortHandle;
use pretty_assertions::assert_eq;
use realtime_webrtc::AudioControls;
use realtime_webrtc::MicrophoneState;
use realtime_webrtc::RealtimeWebrtcSession;
use realtime_webrtc::SpeakerState;
use std::fs;
use std::thread;

fn startup_controls_meters_and_helper_loss() -> Result<()> {
    let Some(root) = common::package("startup_controls_meters_and_helper_loss")? else {
        return Ok(());
    };
    #[cfg(target_os = "linux")]
    {
        assert!(!RealtimeWebrtcSession::is_supported());
        let libraries = root.join("ash-resources/voice/lib");
        fs::create_dir_all(&libraries)?;
        fs::write(libraries.join("libgstreamer-1.0.so.0"), b"fixture runtime")?;
        assert!(RealtimeWebrtcSession::is_supported());
    }
    let (_abort, registration) = AbortHandle::new_pair();
    let started = RealtimeWebrtcSession::start(registration)?;
    assert_eq!(started.offer_sdp, "synthetic-offer");
    let handle = started.handle;
    handle.set_microphone(MicrophoneState::Muted)?;
    let answer_handle = handle.clone();
    let answer = thread::spawn(move || answer_handle.apply_answer_sdp("synthetic-answer".into()));
    common::wait_for(|| root.join("answer").exists())?;
    handle.set_speaker(SpeakerState::Suppressed).unwrap();
    fs::write(root.join("release"), [])?;
    answer.join().expect("answer thread")?;
    let initial: Vec<AudioControls> = serde_json::from_slice(&fs::read(root.join("controls"))?)?;
    assert_eq!(
        initial,
        vec![AudioControls {
            microphone_muted: true,
            speaker_suppressed: true
        }]
    );
    handle.set_microphone(MicrophoneState::Active)?;
    handle.set_speaker(SpeakerState::Active).unwrap();
    let expected = serde_json::to_vec(&vec![
        AudioControls {
            microphone_muted: true,
            speaker_suppressed: true,
        },
        AudioControls {
            microphone_muted: false,
            speaker_suppressed: true,
        },
        AudioControls {
            microphone_muted: false,
            speaker_suppressed: false,
        },
    ])?;
    common::wait_for(|| fs::read(root.join("controls")).is_ok_and(|data| data == expected))?;
    common::wait_for(|| handle.take_microphone_peak() == 123)?;
    common::wait_for(|| handle.take_speaker_peak() == 456)?;
    fs::write(root.join("exit"), [])?;
    let mut error = None;
    common::wait_for(|| {
        error = handle.take_error();
        error.is_some()
    })?;
    assert_eq!(
        error.as_deref(),
        Some("voice audio session stopped unexpectedly")
    );
    assert_eq!(handle.take_error(), None);
    Ok(())
}

fn external_cancellation_interrupts_startup() -> Result<()> {
    let Some(root) = common::package("external_cancellation_interrupts_startup")? else {
        return Ok(());
    };
    fs::write(root.join("hold-initialization"), [])?;
    let (abort, registration) = AbortHandle::new_pair();
    let (result, received) = std::sync::mpsc::sync_channel(1);
    let startup = thread::spawn(move || {
        let _ = result.send(RealtimeWebrtcSession::start(registration));
    });
    common::wait_for(|| root.join("initializing").exists())?;
    abort.abort();
    assert!(
        received
            .recv_timeout(std::time::Duration::from_secs(2))?
            .is_err()
    );
    startup.join().expect("startup thread");
    #[cfg(unix)]
    common::wait_for_helper_reaped(&root)?;
    Ok(())
}

#[cfg(unix)]
fn last_owner_drop_reaps_helper() -> Result<()> {
    let Some(root) = common::package("last_owner_drop_reaps_helper")? else {
        return Ok(());
    };
    let (_abort, registration) = AbortHandle::new_pair();
    let started = RealtimeWebrtcSession::start(registration)?;
    drop(started);
    common::wait_for_helper_reaped(&root)
}

fn device_failure_reaches_startup_completion_without_duplicate_error() -> Result<()> {
    let Some(root) =
        common::package("device_failure_reaches_startup_completion_without_duplicate_error")?
    else {
        return Ok(());
    };
    fs::write(root.join("fail-devices"), [])?;
    fs::write(root.join("release"), [])?;
    let (_abort, registration) = AbortHandle::new_pair();
    let started = RealtimeWebrtcSession::start(registration)?;
    assert_eq!(
        started.handle.apply_answer_sdp("synthetic-answer".into()),
        Err(realtime_webrtc::ConnectionError::AudioDevices)
    );
    #[cfg(unix)]
    common::wait_for_helper_reaped(&root)?;
    assert_eq!(started.handle.take_error(), None);
    Ok(())
}

fn runtime_failure_reaches_offer_caller_without_platform_error_text() -> Result<()> {
    let Some(root) =
        common::package("runtime_failure_reaches_offer_caller_without_platform_error_text")?
    else {
        return Ok(());
    };
    fs::write(root.join("fail-initialization"), [])?;
    let (_abort, registration) = AbortHandle::new_pair();
    let error = RealtimeWebrtcSession::start(registration).unwrap_err();
    assert_eq!(
        error.downcast_ref::<realtime_webrtc::ConnectionError>(),
        Some(&realtime_webrtc::ConnectionError::RuntimeInitialization)
    );
    assert_eq!(
        format!("{error:#}"),
        "voice audio runtime could not initialize"
    );
    #[cfg(unix)]
    common::wait_for_helper_reaped(&root)?;
    Ok(())
}

#[cfg(unix)]
fn explicit_close_reaps_helper_while_clones_remain() -> Result<()> {
    let Some(root) = common::package("explicit_close_reaps_helper_while_clones_remain")? else {
        return Ok(());
    };
    let (_abort, registration) = AbortHandle::new_pair();
    let started = RealtimeWebrtcSession::start(registration)?;
    let clone = started.handle.clone();
    started.handle.close();
    common::wait_for_helper_reaped(&root)?;
    assert!(clone.set_microphone(MicrophoneState::Muted).is_err());
    Ok(())
}

#[cfg(unix)]
fn helper_symlink_is_rejected_before_spawn() -> Result<()> {
    let Some(root) = common::package("helper_symlink_is_rejected_before_spawn")? else {
        return Ok(());
    };
    let helper = root.join("ash-resources/voice/bin/ash-voice-host");
    fs::remove_file(&helper)?;
    std::os::unix::fs::symlink(root.join("bin/ash"), helper)?;
    let (_abort, registration) = AbortHandle::new_pair();
    let error = RealtimeWebrtcSession::start(registration).unwrap_err();
    assert_eq!(
        error.downcast_ref::<realtime_webrtc::ConnectionError>(),
        Some(&realtime_webrtc::ConnectionError::HelperStartup)
    );
    assert!(!root.join("helper-pid").exists());
    Ok(())
}

fn main() {
    common::dispatch_helper();
    let arguments = libtest_mimic::Arguments::from_args();
    let tests = vec![
        trial(
            "startup_controls_meters_and_helper_loss",
            startup_controls_meters_and_helper_loss,
        ),
        trial(
            "external_cancellation_interrupts_startup",
            external_cancellation_interrupts_startup,
        ),
        trial(
            "device_failure_reaches_startup_completion_without_duplicate_error",
            device_failure_reaches_startup_completion_without_duplicate_error,
        ),
        trial(
            "runtime_failure_reaches_offer_caller_without_platform_error_text",
            runtime_failure_reaches_offer_caller_without_platform_error_text,
        ),
        #[cfg(unix)]
        trial("last_owner_drop_reaps_helper", last_owner_drop_reaps_helper),
        #[cfg(unix)]
        trial(
            "explicit_close_reaps_helper_while_clones_remain",
            explicit_close_reaps_helper_while_clones_remain,
        ),
        #[cfg(unix)]
        trial(
            "helper_symlink_is_rejected_before_spawn",
            helper_symlink_is_rejected_before_spawn,
        ),
    ];
    libtest_mimic::run(&arguments, tests).exit();
}

fn trial(name: &str, test: fn() -> Result<()>) -> libtest_mimic::Trial {
    libtest_mimic::Trial::test(name, move || {
        test().map_err(|error| format!("{error:#}").into())
    })
}
