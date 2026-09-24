use std::num::NonZeroU64;

use ash_remote_connections::RemoteRuntimeDownloadDisposition;
use ash_remote_connections::RemoteRuntimeDownloadProgress;
use ash_remote_connections::RemoteRuntimeInstallDisposition;
use ash_remote_connections::RemoteRuntimeInstallProgress;

use crate::launch::AppLaunch;
use crate::launch::RemoteRuntimePreparationProgress;
#[cfg(unix)]
use crate::launch::RemoteRuntimeSource;
use crate::launch_progress::RemoteInstallProgressReporter;
use crate::launch_progress::RemoteLaunchProgressEvent;
use crate::launch_progress::RemoteLaunchProgressProjector;
use crate::launch_progress::prepare_remote_launch_with_outputs;
#[cfg(unix)]
use crate::launch_test_support::make_executable;
#[cfg(unix)]
use ash_remote::RemoteDirPath;
#[cfg(unix)]
use ash_remote::RemoteProfile;
#[cfg(unix)]
use ash_remote::RemoteRuntime;
#[cfg(unix)]
use ash_remote::SshHost;
#[cfg(unix)]
use ash_remote::SshTarget;

#[test]
fn reporter_projects_stable_phases_and_throttles_upload_to_deciles() {
    let mut reporter = RemoteInstallProgressReporter::default();
    let mut output = Vec::new();
    reporter
        .write(
            RemoteRuntimeInstallProgress::ValidatingArtifact,
            &mut output,
        )
        .unwrap();
    reporter
        .write(RemoteRuntimeInstallProgress::ProbingPlatform, &mut output)
        .unwrap();
    for transferred_bytes in [0, 1, 9, 10, 19, 20, 99, 100] {
        reporter
            .write(
                RemoteRuntimeInstallProgress::Uploading {
                    transferred_bytes,
                    total_bytes: NonZeroU64::new(100).unwrap(),
                },
                &mut output,
            )
            .unwrap();
    }
    reporter
        .write(
            RemoteRuntimeInstallProgress::FinalizingRemoteInstall,
            &mut output,
        )
        .unwrap();
    reporter
        .write(
            RemoteRuntimeInstallProgress::Complete {
                disposition: RemoteRuntimeInstallDisposition::Installed,
            },
            &mut output,
        )
        .unwrap();

    assert_eq!(
        String::from_utf8(output).unwrap(),
        "Remote runtime: validating local package\n\
         Remote runtime: probing server platform\n\
         Remote runtime: uploading 0% (0/100 bytes)\n\
         Remote runtime: uploading 10% (10/100 bytes)\n\
         Remote runtime: uploading 20% (20/100 bytes)\n\
         Remote runtime: uploading 90% (99/100 bytes)\n\
         Remote runtime: uploading 100% (100/100 bytes)\n\
         Remote runtime: validating and committing on server\n\
         Remote runtime: installation complete\n"
    );
}

#[test]
fn reporter_distinguishes_reused_immutable_runtime() {
    let mut reporter = RemoteInstallProgressReporter::default();
    let mut output = Vec::new();

    reporter
        .write(
            RemoteRuntimeInstallProgress::Complete {
                disposition: RemoteRuntimeInstallDisposition::Reused,
            },
            &mut output,
        )
        .unwrap();

    assert_eq!(
        String::from_utf8(output).unwrap(),
        "Remote runtime: verified existing installation\n"
    );
}

#[test]
fn reporter_projects_download_phases_and_throttles_them_separately() {
    let mut reporter = RemoteInstallProgressReporter::default();
    let mut output = Vec::new();

    reporter
        .write_preparation(
            RemoteRuntimePreparationProgress::Download(
                RemoteRuntimeDownloadProgress::DownloadingCatalog,
            ),
            &mut output,
        )
        .unwrap();
    for transferred_bytes in [0, 1, 10, 19, 100] {
        reporter
            .write_preparation(
                RemoteRuntimePreparationProgress::Download(
                    RemoteRuntimeDownloadProgress::DownloadingArtifact {
                        transferred_bytes,
                        total_bytes: 100,
                    },
                ),
                &mut output,
            )
            .unwrap();
    }
    reporter
        .write_preparation(
            RemoteRuntimePreparationProgress::Download(
                RemoteRuntimeDownloadProgress::ValidatingArtifact,
            ),
            &mut output,
        )
        .unwrap();
    reporter
        .write_preparation(
            RemoteRuntimePreparationProgress::Download(RemoteRuntimeDownloadProgress::Complete {
                disposition: RemoteRuntimeDownloadDisposition::Downloaded,
            }),
            &mut output,
        )
        .unwrap();

    assert_eq!(
        String::from_utf8(output).unwrap(),
        "Remote runtime: downloading authenticated catalog\n\
         Remote runtime: downloading 0% (0/100 bytes)\n\
         Remote runtime: downloading 10% (10/100 bytes)\n\
         Remote runtime: downloading 100% (100/100 bytes)\n\
         Remote runtime: validating downloaded package\n\
         Remote runtime: download complete\n"
    );
}

#[test]
fn child_progress_wire_round_trips_bounded_phases_and_ignores_regular_output() {
    let events = [
        RemoteLaunchProgressEvent::CheckingRuntime,
        RemoteLaunchProgressEvent::DownloadingArtifact {
            transferred_bytes: 21,
            total_bytes: 50,
        },
        RemoteLaunchProgressEvent::Uploading {
            transferred_bytes: 42,
            total_bytes: 100,
        },
        RemoteLaunchProgressEvent::Ready,
        RemoteLaunchProgressEvent::Failed("host unavailable".into()),
    ];
    for event in events {
        let mut output = Vec::new();
        event.write_wire(&mut output).unwrap();
        let line = String::from_utf8(output).unwrap();
        assert_eq!(
            RemoteLaunchProgressEvent::parse_wire(line.trim_end()).unwrap(),
            Some(event)
        );
    }
    assert_eq!(
        RemoteLaunchProgressEvent::parse_wire("ordinary child diagnostic").unwrap(),
        None
    );
    assert!(RemoteLaunchProgressEvent::parse_wire("__APP_REMOTE_LAUNCH__:{bad-json}").is_err());
}

#[test]
fn child_progress_wire_bounds_failure_messages_at_a_utf8_boundary() {
    let mut output = Vec::new();
    RemoteLaunchProgressEvent::Failed("é".repeat(3_000))
        .write_wire(&mut output)
        .unwrap();

    let line = String::from_utf8(output).unwrap();
    let Some(RemoteLaunchProgressEvent::Failed(message)) =
        RemoteLaunchProgressEvent::parse_wire(line.trim_end()).unwrap()
    else {
        panic!("expected a bounded failure event");
    };
    assert_eq!(message.len(), 4_096);
    assert!(message.is_char_boundary(message.len()));

    let oversized = format!(
        "__APP_REMOTE_LAUNCH__:{{\"phase\":\"failed\",\"message\":\"{}\"}}",
        "x".repeat(4_097)
    );
    assert!(RemoteLaunchProgressEvent::parse_wire(&oversized).is_err());
}

#[test]
fn upload_progress_projects_a_safe_percentage() {
    assert_eq!(
        RemoteLaunchProgressEvent::Uploading {
            transferred_bytes: 55,
            total_bytes: 100,
        }
        .message(),
        "Uploading Remote runtime… 55%"
    );
    assert_eq!(
        RemoteLaunchProgressEvent::Uploading {
            transferred_bytes: 10,
            total_bytes: 0,
        }
        .message(),
        "Uploading Remote runtime… 0%"
    );
}

#[test]
fn desktop_child_progress_throttles_upload_events_to_deciles() {
    let mut projector = RemoteLaunchProgressProjector::default();
    let events = [0, 1, 9, 10, 19, 20, 99, 100]
        .into_iter()
        .filter_map(|transferred_bytes| {
            projector.project(RemoteRuntimeInstallProgress::Uploading {
                transferred_bytes,
                total_bytes: NonZeroU64::new(100).unwrap(),
            })
        })
        .collect::<Vec<_>>();

    assert_eq!(
        events,
        vec![
            RemoteLaunchProgressEvent::Uploading {
                transferred_bytes: 0,
                total_bytes: 100,
            },
            RemoteLaunchProgressEvent::Uploading {
                transferred_bytes: 10,
                total_bytes: 100,
            },
            RemoteLaunchProgressEvent::Uploading {
                transferred_bytes: 20,
                total_bytes: 100,
            },
            RemoteLaunchProgressEvent::Uploading {
                transferred_bytes: 90,
                total_bytes: 100,
            },
            RemoteLaunchProgressEvent::Uploading {
                transferred_bytes: 100,
                total_bytes: 100,
            },
        ]
    );
}

#[test]
fn desktop_child_progress_throttles_download_events_to_deciles() {
    let mut projector = RemoteLaunchProgressProjector::default();
    let events = [0, 1, 9, 10, 19, 20, 99, 100]
        .into_iter()
        .filter_map(|transferred_bytes| {
            projector.project_preparation(RemoteRuntimePreparationProgress::Download(
                RemoteRuntimeDownloadProgress::DownloadingArtifact {
                    transferred_bytes,
                    total_bytes: 100,
                },
            ))
        })
        .collect::<Vec<_>>();

    assert_eq!(
        events,
        vec![
            RemoteLaunchProgressEvent::DownloadingArtifact {
                transferred_bytes: 0,
                total_bytes: 100,
            },
            RemoteLaunchProgressEvent::DownloadingArtifact {
                transferred_bytes: 10,
                total_bytes: 100,
            },
            RemoteLaunchProgressEvent::DownloadingArtifact {
                transferred_bytes: 20,
                total_bytes: 100,
            },
            RemoteLaunchProgressEvent::DownloadingArtifact {
                transferred_bytes: 90,
                total_bytes: 100,
            },
            RemoteLaunchProgressEvent::DownloadingArtifact {
                transferred_bytes: 100,
                total_bytes: 100,
            },
        ]
    );
}

#[test]
fn high_level_launch_stream_brackets_preparation_with_checking_and_ready() {
    let mut launch = AppLaunch::Local;
    let mut human = Vec::new();
    let mut wire = Vec::new();

    prepare_remote_launch_with_outputs(&mut launch, &mut human, Some(&mut wire)).unwrap();

    assert!(human.is_empty());
    let events = String::from_utf8(wire)
        .unwrap()
        .lines()
        .map(|line| {
            RemoteLaunchProgressEvent::parse_wire(line)
                .unwrap()
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        events,
        vec![
            RemoteLaunchProgressEvent::CheckingRuntime,
            RemoteLaunchProgressEvent::Ready,
        ]
    );
}

#[cfg(unix)]
#[test]
fn high_level_launch_stream_reports_preflight_failure_without_installing() {
    let directory = tempfile::tempdir().unwrap();
    let fake_ssh = directory.path().join("fake-ssh");
    std::fs::write(&fake_ssh, "#!/bin/sh\nexit 255\n").unwrap();
    make_executable(&fake_ssh);
    let mut launch = AppLaunch::Remote {
        profile: RemoteProfile::new(
            SshTarget::new(
                SshHost::parse("build").unwrap(),
                RemoteDirPath::parse("/srv/project").unwrap(),
            ),
            RemoteRuntime::new("/opt/ash/bin/ash-remote-server").unwrap(),
        ),
        ssh_executable: Some(fake_ssh),
        runtime_source: RemoteRuntimeSource::ExplicitRuntime,
    };
    let mut human = Vec::new();
    let mut wire = Vec::new();

    let error =
        prepare_remote_launch_with_outputs(&mut launch, &mut human, Some(&mut wire)).unwrap_err();

    assert!(error.contains("Remote runtime probe did not complete successfully"));
    let events = String::from_utf8(wire)
        .unwrap()
        .lines()
        .map(|line| {
            RemoteLaunchProgressEvent::parse_wire(line)
                .unwrap()
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(events[0], RemoteLaunchProgressEvent::CheckingRuntime);
    assert!(matches!(
        events.last(),
        Some(RemoteLaunchProgressEvent::Failed(message))
            if message.contains("Remote runtime probe did not complete successfully")
    ));
}
