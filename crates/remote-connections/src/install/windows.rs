use std::io::Write;

use ash_remote::quote_powershell_argument;
use base64::Engine;
use flate2::Compression;
use flate2::write::GzEncoder;

use super::RemoteRuntimeArtifact;
use super::RemoteRuntimeInstallLocation;

pub(super) fn install_command(
    artifact: &RemoteRuntimeArtifact,
    location: &RemoteRuntimeInstallLocation,
) -> String {
    let root = match location {
        RemoteRuntimeInstallLocation::UserData => "$null".to_owned(),
        RemoteRuntimeInstallLocation::Absolute(root) => quote_powershell_argument(root.as_str()),
    };
    let script = format!(
        "$root={root}; $target={}; $version={}; $digest={}; $expectedSize={};\n{}",
        quote_powershell_argument(artifact.platform.target_triple()),
        quote_powershell_argument(artifact.version.as_str()),
        quote_powershell_argument(&artifact.integrity.sha256),
        artifact.integrity.archive_size,
        include_str!("windows-install.ps1"),
    );
    // cmd.exe limits command lines to 8191 characters. Compress the trusted script,
    // leaving stdin exclusively for the binary archive (including on PowerShell 5.1).
    let mut compressed = GzEncoder::new(Vec::new(), Compression::best());
    compressed
        .write_all(script.as_bytes())
        .expect("in-memory compression");
    let bytes = compressed.finish().expect("in-memory compression");
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    // The loader contains no variables, backticks, or percent expansions: either
    // cmd.exe or PowerShell can pass its double-quoted argument without expanding
    // it. User data is entirely inside base64. UTF-16 encoding this loader again
    // would exceed cmd.exe's limit for an ordinary installation path.
    format!(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"& ([scriptblock]::Create([IO.StreamReader]::new([IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('{data}')),[IO.Compression.CompressionMode]::Decompress)).ReadToEnd()))\""
    )
}
