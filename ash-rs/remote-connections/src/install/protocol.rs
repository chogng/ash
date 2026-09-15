use ash_remote::RemoteArchitecture;
use ash_remote::RemoteLinuxLibc;
use ash_remote::RemotePlatform;
use ash_remote::RemoteRuntime;

use super::RemoteInstalledRuntime;
use super::RemoteRuntimeArtifact;
use super::RemoteRuntimeInstallDisposition;
use super::RemoteRuntimeInstallError;
use super::RemoteRuntimeInstallFailureKind;
use super::RemoteRuntimeInstallLocation;
use super::artifact_validation::is_canonical_absolute_posix_path;
use crate::ssh::quote_posix_shell_argument;

pub(super) const PLATFORM_UNSUPPORTED_MARKER: &str = "__ASH_REMOTE_PLATFORM_UNSUPPORTED__:";
const PLATFORM_MARKER: &str = "__ASH_REMOTE_PLATFORM__:";
const INSTALL_MARKER: &str = "__ASH_REMOTE_RUNTIME_INSTALLED__:";
const REUSED_MARKER: &str = "__ASH_REMOTE_RUNTIME_REUSED__:";
pub(super) const INSTALL_ERROR_MARKER: &str = "__ASH_REMOTE_RUNTIME_INSTALL_ERROR__:";

pub(crate) fn remote_platform_probe_command() -> String {
    format!(
        "os=$(uname -s 2>/dev/null) || {{ printf '%s%s\\n' {unsupported} 'uname-unavailable'; exit 64; }}; arch=$(uname -m 2>/dev/null) || {{ printf '%s%s\\n' {unsupported} 'architecture-unavailable'; exit 64; }}; case \"$arch\" in arm64|aarch64) arch=aarch64 ;; amd64|x86_64) arch=x86_64 ;; *) printf '%s%s/%s\\n' {unsupported} \"$os\" \"$arch\"; exit 64 ;; esac; case \"$os\" in Darwin) printf '%s%s\\n' {supported} \"macos:$arch:none\" ;; Linux) if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then libc=gnu; else ldd_output=$(ldd --version 2>&1 || true); case \"$ldd_output\" in *musl*) libc=musl ;; *) printf '%s%s/%s/%s\\n' {unsupported} \"$os\" \"$arch\" 'unknown-libc'; exit 64 ;; esac; fi; printf '%s%s\\n' {supported} \"linux:$arch:$libc\" ;; *) printf '%s%s/%s\\n' {unsupported} \"$os\" \"$arch\"; exit 64 ;; esac",
        supported = quote_posix_shell_argument(PLATFORM_MARKER),
        unsupported = quote_posix_shell_argument(PLATFORM_UNSUPPORTED_MARKER),
    )
}

pub(crate) fn parse_remote_platform(stdout: &str) -> Option<RemotePlatform> {
    let value = stdout
        .lines()
        .find_map(|line| line.strip_prefix(PLATFORM_MARKER))?
        .trim();
    match value {
        "linux:aarch64:gnu" => Some(RemotePlatform::linux(
            RemoteArchitecture::Aarch64,
            RemoteLinuxLibc::Gnu,
        )),
        "linux:aarch64:musl" => Some(RemotePlatform::linux(
            RemoteArchitecture::Aarch64,
            RemoteLinuxLibc::Musl,
        )),
        "linux:x86_64:gnu" => Some(RemotePlatform::linux(
            RemoteArchitecture::X86_64,
            RemoteLinuxLibc::Gnu,
        )),
        "linux:x86_64:musl" => Some(RemotePlatform::linux(
            RemoteArchitecture::X86_64,
            RemoteLinuxLibc::Musl,
        )),
        "macos:aarch64:none" => Some(RemotePlatform::mac_os(RemoteArchitecture::Aarch64)),
        "macos:x86_64:none" => Some(RemotePlatform::mac_os(RemoteArchitecture::X86_64)),
        _ => None,
    }
}

pub(crate) fn remote_runtime_install_command(
    artifact: &RemoteRuntimeArtifact,
    location: &RemoteRuntimeInstallLocation,
) -> String {
    let root_selection = match location {
        RemoteRuntimeInstallLocation::UserData => concat!(
            "if [ -n \"${XDG_DATA_HOME:-}\" ]; then install_root=\"${XDG_DATA_HOME}/ash/remote\"; ",
            "elif [ -n \"${HOME:-}\" ]; then install_root=\"${HOME}/.local/share/ash/remote\"; ",
            "else fail 'install-root-unavailable' 73; fi"
        )
        .to_owned(),
        RemoteRuntimeInstallLocation::Absolute(root) => {
            format!("install_root={}", quote_posix_shell_argument(root.as_str()))
        }
    };
    let target = quote_posix_shell_argument(artifact.platform.target_triple());
    let version = quote_posix_shell_argument(artifact.version.as_str());
    let digest = quote_posix_shell_argument(&artifact.integrity.sha256);
    let archive_size = artifact.integrity.archive_size;
    let installed_marker = quote_posix_shell_argument(INSTALL_MARKER);
    let reused_marker = quote_posix_shell_argument(REUSED_MARKER);
    let error_marker = quote_posix_shell_argument(INSTALL_ERROR_MARKER);
    format!(
        concat!(
            "set -u; umask 077; ",
            "fail() {{ printf '%s%s\\n' {error_marker} \"$1\"; exit \"$2\"; }}; ",
            "{root_selection}; ",
            "case \"$install_root\" in /*) ;; *) fail 'install-root-not-absolute' 73 ;; esac; ",
            "case \"$install_root\" in */|*//*|*/./*|*/../*|*/.|*/..) fail 'install-root-not-canonical' 73 ;; esac; ",
            "target={target}; version={version}; digest={digest}; expected_size={archive_size}; ",
            "runtime_parent=\"$install_root/runtimes/$target/$version\"; runtime_dir=\"$runtime_parent/$digest\"; ",
            "executable=\"$runtime_dir/bin/ash-remote-server\"; receipt=\"$runtime_dir/.ash-remote-runtime-sha256\"; ",
            "report() {{ printf '%s%s:%s\\n' \"$1\" \"$digest\" \"$executable\"; exit 0; }}; ",
            "if [ -x \"$executable\" ] && [ -f \"$receipt\" ] && [ \"$(cat \"$receipt\")\" = \"$digest\" ]; then report {reused_marker}; fi; ",
            "command -v tar >/dev/null 2>&1 || fail 'tar-unavailable' 69; ",
            "if command -v sha256sum >/dev/null 2>&1; then hash_kind=sha256sum; ",
            "elif command -v shasum >/dev/null 2>&1; then hash_kind=shasum; ",
            "else fail 'sha256-unavailable' 69; fi; ",
            "mkdir -p \"$runtime_parent\" || fail 'install-root-unwritable' 73; ",
            "lock=\"$runtime_dir.installing\"; lock_owned=0; staging=''; ",
            "cleanup() {{ if [ -n \"$staging\" ] && [ -d \"$staging\" ]; then rm -rf \"$staging\"; fi; if [ \"$lock_owned\" = 1 ] && [ -d \"$lock\" ]; then rm -rf \"$lock\"; fi; }}; ",
            "trap cleanup EXIT; trap 'exit 130' HUP INT TERM; ",
            "if ! mkdir \"$lock\" 2>/dev/null; then lock_pid=''; [ -f \"$lock/pid\" ] && lock_pid=$(cat \"$lock/pid\" 2>/dev/null || true); ",
            "case \"$lock_pid\" in ''|*[!0-9]*) lock_live=0 ;; *) if kill -0 \"$lock_pid\" 2>/dev/null; then lock_live=1; else lock_live=0; fi ;; esac; ",
            "if [ \"$lock_live\" = 1 ]; then fail 'install-in-progress' 75; fi; rm -rf \"$lock\" || fail 'stale-lock-unremovable' 73; mkdir \"$lock\" || fail 'install-lock-unavailable' 75; fi; ",
            "lock_owned=1; printf '%s\\n' \"$$\" > \"$lock/pid\" || fail 'install-lock-unwritable' 73; ",
            "if [ -x \"$executable\" ] && [ -f \"$receipt\" ] && [ \"$(cat \"$receipt\")\" = \"$digest\" ]; then report {reused_marker}; fi; ",
            "if [ -e \"$runtime_dir\" ]; then rm -rf \"$runtime_dir\" || fail 'incomplete-runtime-unremovable' 73; fi; ",
            "staging=$(mktemp -d \"$runtime_parent/.staging.XXXXXX\") || fail 'staging-unavailable' 73; ",
            "archive=\"$staging/ash-package.tar.gz\"; package=\"$staging/package\"; mkdir \"$package\" || fail 'staging-unwritable' 73; ",
            "cat > \"$archive\" || fail 'upload-write-failed' 74; observed_size=$(wc -c < \"$archive\" | tr -d '[:space:]'); ",
            "[ \"$observed_size\" = \"$expected_size\" ] || fail 'archive-size-mismatch' 65; ",
            "if [ \"$hash_kind\" = sha256sum ]; then observed_hash=$(sha256sum \"$archive\"); else observed_hash=$(shasum -a 256 \"$archive\"); fi; observed_hash=${{observed_hash%% *}}; ",
            "[ \"$observed_hash\" = \"$digest\" ] || fail 'archive-sha256-mismatch' 65; ",
            "tar -xzf \"$archive\" -C \"$package\" || fail 'archive-extraction-failed' 65; ",
            "[ -f \"$package/ash-package.json\" ] || fail 'package-metadata-missing' 65; ",
            "[ -f \"$package/bin/ash-remote-server\" ] || fail 'package-entrypoint-missing' 65; ",
            "[ -f \"$package/bin/ash-app-server-daemon\" ] || fail 'package-app-server-daemon-missing' 65; ",
            "[ -f \"$package/ash-path/rg\" ] || fail 'package-ripgrep-missing' 65; ",
            "[ -f \"$package/ash-resources/node/bin/node\" ] || fail 'package-node-missing' 65; ",
            "chmod 700 \"$package/bin/ash-remote-server\" \"$package/bin/ash-app-server-daemon\" \"$package/ash-path/rg\" \"$package/ash-resources/node/bin/node\" || fail 'package-executable-permissions-failed' 73; ",
            "printf '%s\\n' \"$digest\" > \"$package/.ash-remote-runtime-sha256\" || fail 'receipt-write-failed' 73; ",
            "mv \"$package\" \"$runtime_dir\" || fail 'runtime-commit-failed' 73; report {installed_marker}"
        ),
        error_marker = error_marker,
        root_selection = root_selection,
        target = target,
        version = version,
        digest = digest,
        archive_size = archive_size,
        installed_marker = installed_marker,
        reused_marker = reused_marker,
    )
}

pub(super) fn parse_install_receipt(
    stdout: &str,
    artifact: &RemoteRuntimeArtifact,
) -> Result<Option<RemoteInstalledRuntime>, RemoteRuntimeInstallError> {
    let receipt = stdout.lines().find_map(|line| {
        line.strip_prefix(INSTALL_MARKER)
            .map(|value| (RemoteRuntimeInstallDisposition::Installed, value))
            .or_else(|| {
                line.strip_prefix(REUSED_MARKER)
                    .map(|value| (RemoteRuntimeInstallDisposition::Reused, value))
            })
    });
    let Some((disposition, value)) = receipt else {
        return Ok(None);
    };
    let Some((digest, executable)) = value.split_once(':') else {
        return Err(RemoteRuntimeInstallError::new(
            RemoteRuntimeInstallFailureKind::RemoteRejected,
            "Remote installer returned a malformed receipt",
        ));
    };
    if digest != artifact.integrity.sha256
        || !is_canonical_absolute_posix_path(executable)
        || !executable.ends_with("/bin/ash-remote-server")
    {
        return Err(RemoteRuntimeInstallError::new(
            RemoteRuntimeInstallFailureKind::RemoteRejected,
            "Remote installer receipt did not identify the requested immutable runtime",
        ));
    }
    let runtime = RemoteRuntime::new(executable).map_err(|error| {
        RemoteRuntimeInstallError::new(
            RemoteRuntimeInstallFailureKind::RemoteRejected,
            error.to_string(),
        )
    })?;
    Ok(Some(RemoteInstalledRuntime {
        runtime,
        version: artifact.version.clone(),
        platform: artifact.platform,
        archive_sha256: artifact.integrity.sha256.clone(),
        disposition,
    }))
}

pub(super) fn remote_install_failure(code: &str) -> RemoteRuntimeInstallError {
    let kind = match code {
        "tar-unavailable" | "sha256-unavailable" => {
            RemoteRuntimeInstallFailureKind::RemotePrerequisite
        }
        "install-in-progress" | "install-lock-unavailable" => {
            RemoteRuntimeInstallFailureKind::ConcurrentInstall
        }
        "archive-size-mismatch" | "archive-sha256-mismatch" => {
            RemoteRuntimeInstallFailureKind::ArtifactIntegrity
        }
        _ => RemoteRuntimeInstallFailureKind::RemoteRejected,
    };
    RemoteRuntimeInstallError::new(
        kind,
        format!("Remote installer rejected the package: {code}"),
    )
}
