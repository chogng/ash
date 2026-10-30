//! Exercises the default missing-runtime branch through the packaged Provider and SDK transport.
//! Only the Dev Container CLI is controlled; catalog, archive and receipt validation are real.

use super::host;
use super::readiness;
use super::tool;
use ash_async_utils::CancellationSource;
use ash_core_plugins::EditorExtensionPolicy;
use ash_protocol::SessionRuntimeRequest;
use ash_protocol::SessionRuntimeResult;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

#[derive(Clone, Copy, Debug)]
enum Installation {
    Verified,
    Unauthorized,
    WrongCatalogDigest,
    WrongArchiveDigest,
    WrongReceiptDigest,
    MissingReceipt,
}

struct Fixture {
    runtime: Arc<host::SessionRuntimeProvider>,
    workspace: PathBuf,
    archive: Vec<u8>,
    upload: PathBuf,
    selected: PathBuf,
    stage: PathBuf,
    executable: String,
    // The supervisor must reap the copied executable before its package directory is removed.
    _directory: tempfile::TempDir,
}

impl Fixture {
    fn new(installation: Installation) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let workspace = root.join("project");
        std::fs::create_dir_all(workspace.join(".devcontainer")).unwrap();
        std::fs::write(workspace.join(".devcontainer/devcontainer.json"), "{}").unwrap();
        for path in ["bin", "ash-path", "ash-resources", "ash-remote-runtimes"] {
            std::fs::create_dir(root.join(path)).unwrap();
        }
        let provider = root.join("bin").join(format!(
            "ash-dev-container-provider{}",
            std::env::consts::EXE_SUFFIX
        ));
        std::fs::copy(env!("CARGO_BIN_EXE_ash-dev-container-provider"), &provider).unwrap();

        let payload = root.join("payload");
        std::fs::create_dir(&payload).unwrap();
        let metadata = serde_json::to_vec(&json!({
            "layoutVersion": 2, "version": "0.1.0", "target": "x86_64-unknown-linux-gnu",
            "entrypoint": "bin/ash-app-server", "pathDir": "ash-path", "resourcesDir": "ash-resources",
            "javascriptRuntime": {"kind": "packagedNode"}
        }))
        .unwrap();
        let files = [
            "ash-package.json",
            "bin/ash-app-server",
            "bin/ash-app-server-daemon",
            "bin/ash-remote-server",
            "ash-path/rg",
            "ash-resources/node/bin/node",
            "ash-resources/tgrep/tgrep",
        ];
        let mut unpacked_size = 0;
        for name in files {
            let file = payload.join(name);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            let bytes = if name == "ash-package.json" {
                metadata.as_slice()
            } else {
                b"fixture executable"
            };
            std::fs::write(file, bytes).unwrap();
            unpacked_size += bytes.len();
        }
        let archive_path = root.join("ash-remote-runtimes/runtime.tar.gz");
        let output = Command::new("tar")
            .args(["-czf"])
            .arg(&archive_path)
            .arg("-C")
            .arg(&payload)
            .args(files)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        let archive = std::fs::read(&archive_path).unwrap();
        let digest = format!("{:x}", Sha256::digest(&archive));
        let catalog = serde_json::to_vec(&json!({
            "formatVersion": 1,
            "artifacts": [{"version":"0.1.0", "target":"x86_64-unknown-linux-gnu",
                "archive":"runtime.tar.gz", "archiveSize":archive.len(),
                "unpackedSize":unpacked_size, "sha256":digest}]
        }))
        .unwrap();
        std::fs::write(root.join("ash-remote-runtimes/catalog.json"), &catalog).unwrap();
        let catalog_digest = if matches!(installation, Installation::WrongCatalogDigest) {
            "0".repeat(64)
        } else {
            format!("{:x}", Sha256::digest(&catalog))
        };
        let trust = if matches!(installation, Installation::Unauthorized) {
            "untrusted"
        } else {
            "signedProductPackage"
        };
        std::fs::write(
            root.join("ash-package.json"),
            serde_json::to_vec(&json!({"remoteRuntimeCatalog": {
                "path":"ash-remote-runtimes/catalog.json", "sha256":catalog_digest, "trustBinding":trust
            }}))
            .unwrap(),
        )
        .unwrap();
        if matches!(installation, Installation::WrongArchiveDigest) {
            let mut changed = archive.clone();
            changed[0] ^= 1;
            std::fs::write(&archive_path, changed).unwrap();
        }

        let executable =
            format!("/home/container/.local/share/ash/runtimes/{digest}/bin/ash-remote-server");
        let receipt = match installation {
            Installation::WrongReceiptDigest => {
                format!(
                    "__ASH_REMOTE_RUNTIME_INSTALLED__:{}:{executable}",
                    "0".repeat(64)
                )
            }
            Installation::MissingReceipt => "installer output without a receipt".into(),
            Installation::Verified
            | Installation::Unauthorized
            | Installation::WrongCatalogDigest
            | Installation::WrongArchiveDigest => {
                format!("__ASH_REMOTE_RUNTIME_INSTALLED__:{digest}:{executable}")
            }
        };
        let stage = root.join("stage");
        let upload = root.join("uploaded.tar.gz");
        let selected = root.join("selected-runtime");
        std::fs::write(&stage, "0").unwrap();
        // A staged CLI makes bypassing bootstrap observable. Binary stdin is captured independently
        // of the receipt, and only the final invocation can select the verified executable.
        let script = if cfg!(windows) {
            format!(
                "@echo off\r\nset /p stage=<\"{stage}\"\r\nset /a stage+=1 >nul\r\necho %stage% > \"{stage}\"\r\nif %stage%==1 (echo {{\"outcome\":\"success\",\"containerId\":\"0123456789abcdef\",\"remoteWorkspaceFolder\":\"/workspace\"}} & exit /b 0)\r\nif %stage%==2 exit /b 127\r\nif %stage%==3 (echo __ASH_REMOTE_PLATFORM__:linux:x86_64:gnu & exit /b 0)\r\nif %stage%==4 (\r\npowershell.exe -NoLogo -NoProfile -NonInteractive -Command \"$stream=[Console]::OpenStandardInput(); $file=[IO.File]::Create('{upload}'); try {{$stream.CopyTo($file)}} finally {{$file.Dispose()}}\"\r\necho {receipt}\r\nexit /b 0\r\n)\r\nif %stage%==5 (echo %~8 > \"{selected}\" & exit /b 0)\r\nexit /b 99\r\n",
                stage = stage.display(),
                upload = upload.display(),
                selected = selected.display()
            )
        } else {
            format!(
                "#!/bin/sh\nset -eu\nstage=$(cat '{stage}'); stage=$((stage+1)); printf '%s\\n' \"$stage\" > '{stage}'\ncase $stage in\n1) printf '%s\\n' '{{\"outcome\":\"success\",\"containerId\":\"0123456789abcdef\",\"remoteWorkspaceFolder\":\"/workspace\"}}';;\n2) exit 127;;\n3) printf '%s\\n' '__ASH_REMOTE_PLATFORM__:linux:x86_64:gnu';;\n4) cat > '{upload}'; printf '%s\\n' '{receipt}';;\n5) printf '%s\\n' \"$8\" > '{selected}';;\n*) exit 99;;\nesac\n",
                stage = stage.display(),
                upload = upload.display(),
                selected = selected.display()
            )
        };
        let cli = tool(root, "devcontainer", &script);
        let mut environment = BTreeMap::new();
        for key in ["PATH", "SystemRoot", "COMSPEC", "TEMP"] {
            if let Some(value) = std::env::var_os(key) {
                environment.insert(key.into(), value);
            }
        }
        environment.insert("ASH_DEVCONTAINER_CLI".into(), cli.into_os_string());
        let policy = Arc::new(EditorExtensionPolicy::open(root.join("policy.json")).unwrap());
        let runtime = host::SessionRuntimeProvider::open(
            root,
            policy,
            Some(host::SessionRuntimeInstallation {
                executable: provider,
                environment,
            }),
            readiness,
        )
        .unwrap();
        Self {
            runtime,
            workspace,
            archive,
            upload,
            selected,
            stage,
            executable,
            _directory: directory,
        }
    }
}

#[test]
fn missing_runtime_bootstraps_from_the_product_catalog_before_target_admission() {
    let fixture = Fixture::new(Installation::Verified);
    let source = CancellationSource::new();
    let result = fixture.runtime.invoke(
        "ash.dev-containers",
        SessionRuntimeRequest::Prepare {
            workspace: fixture.workspace.clone(),
        },
        &source.token(),
    );
    let target = match result.unwrap() {
        SessionRuntimeResult::Target { target } => target,
        other => panic!("unexpected result: {other:?}"),
    };
    assert!(fixture.runtime.is_admitted(&target));
    assert_eq!(std::fs::read(&fixture.upload).unwrap(), fixture.archive);
    assert_eq!(
        std::fs::read_to_string(&fixture.selected).unwrap().trim(),
        fixture.executable
    );
    assert_eq!(std::fs::read_to_string(&fixture.stage).unwrap().trim(), "5");
}

#[test]
fn bootstrap_failures_never_select_a_runtime_or_admit_a_target() {
    for installation in [
        Installation::Unauthorized,
        Installation::WrongCatalogDigest,
        Installation::WrongArchiveDigest,
        Installation::WrongReceiptDigest,
        Installation::MissingReceipt,
    ] {
        let fixture = Fixture::new(installation);
        let source = CancellationSource::new();
        let result = fixture.runtime.invoke(
            "ash.dev-containers",
            SessionRuntimeRequest::Prepare {
                workspace: fixture.workspace.clone(),
            },
            &source.token(),
        );
        let (stage, error) = match installation {
            Installation::Unauthorized => ("3", "product authorization"),
            Installation::WrongCatalogDigest | Installation::WrongArchiveDigest => {
                ("3", "SHA-256 mismatch")
            }
            Installation::WrongReceiptDigest => ("4", "requested immutable runtime"),
            Installation::MissingReceipt => ("4", "no verified installation receipt"),
            Installation::Verified => unreachable!(),
        };
        assert!(result.unwrap_err().contains(error), "{installation:?}");
        assert!(fixture.runtime.targets().is_empty(), "{installation:?}");
        assert!(!fixture.selected.exists(), "{installation:?}");
        assert_eq!(
            std::fs::read_to_string(&fixture.stage).unwrap().trim(),
            stage,
            "{installation:?}"
        );
    }
}
