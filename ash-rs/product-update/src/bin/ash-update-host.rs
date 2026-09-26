use ash_product_update::ExpectedRelease;
use ash_product_update::PackageFormat;
use ash_product_update::UpdatePolicy;
use ash_product_update::UpdateProduct;
use ash_product_update::UpdatePublicKey;
use ash_product_update::VerifiedRelease;
use ash_product_update::stage_verified_package;
use ash_product_update::verify_release;
use semver::Version;
use serde::Deserialize;
use serde::Serialize;
use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

const REPOSITORY: &str = "chogng/ash";
const RELEASE_API: &str = "https://api.github.com/repos/chogng/ash/releases?per_page=20";
const MAX_RELEASE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckRequest {
    current_version: String,
    public_key: String,
    target: String,
    #[serde(default)]
    policy: UpdatePolicy,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
enum HostCommand {
    #[default]
    Check,
    Download,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostRequest {
    #[serde(flatten)]
    check: CheckRequest,
    #[serde(default)]
    command: HostCommand,
    staging_directory: Option<PathBuf>,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    size: u64,
    browser_download_url: String,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum CheckResult {
    Current {
        version: String,
    },
    Available {
        current_version: String,
        version: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadResult {
    version: String,
    file_path: PathBuf,
    size: u64,
    sha256: String,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut input = Vec::new();
    std::io::stdin()
        .take(4097)
        .read_to_end(&mut input)
        .map_err(|error| format!("could not read update request: {error}"))?;
    if input.len() > 4096 {
        return Err("update request is too large".into());
    }
    let request: HostRequest = serde_json::from_slice(&input)
        .map_err(|error| format!("invalid update request: {error}"))?;
    match request.command {
        HostCommand::Check => {
            if request.staging_directory.is_some() {
                return Err("update check must not specify a staging directory".into());
            }
            let result = check_release(&request.check, fetch)?;
            serde_json::to_writer(std::io::stdout(), &result)
                .map_err(|error| format!("could not write update result: {error}"))?;
        }
        HostCommand::Download => {
            let directory = request
                .staging_directory
                .as_deref()
                .ok_or("update download requires a staging directory")?;
            let release = resolve_release(&request.check, fetch)?;
            let current = Version::parse(&request.check.current_version)
                .map_err(|error| format!("invalid installed version: {error}"))?;
            if release.version <= current {
                return Err("no newer desktop update is available".into());
            }
            let path = stage_verified_package(&release.package, directory)
                .map_err(|error| error.to_string())?;
            serde_json::to_writer(
                std::io::stdout(),
                &DownloadResult {
                    version: release.version.to_string(),
                    file_path: path,
                    size: release.package.size,
                    sha256: release
                        .package
                        .sha256
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect(),
                },
            )
            .map_err(|error| format!("could not write update result: {error}"))?;
        }
    }
    Ok(())
}

fn check_release(
    request: &CheckRequest,
    transport: impl Fn(&str, u64) -> Result<Vec<u8>, String>,
) -> Result<CheckResult, String> {
    let current = Version::parse(&request.current_version)
        .map_err(|error| format!("invalid installed version: {error}"))?;
    let verified = resolve_release(request, transport)?;
    let result = if verified.version > current {
        CheckResult::Available {
            current_version: current.to_string(),
            version: verified.version.to_string(),
        }
    } else {
        CheckResult::Current {
            version: current.to_string(),
        }
    };
    Ok(result)
}

fn resolve_release(
    request: &CheckRequest,
    transport: impl Fn(&str, u64) -> Result<Vec<u8>, String>,
) -> Result<VerifiedRelease, String> {
    Version::parse(&request.current_version)
        .map_err(|error| format!("invalid installed version: {error}"))?;
    let key = UpdatePublicKey::from_hex(&request.public_key).map_err(|error| error.to_string())?;
    if request.policy == UpdatePolicy::Never {
        return Err("the never policy does not select a release".into());
    }
    if request.policy == UpdatePolicy::Stable {
        let descriptor_name = format!("ash-desktop-stable-{}.update.json", request.target);
        let descriptor_url = format!(
            "https://github.com/{REPOSITORY}/releases/download/ash-desktop-stable/{descriptor_name}"
        );
        let verified = verify_release(
            &transport(&descriptor_url, MAX_MANIFEST_BYTES)?,
            key,
            &ExpectedRelease {
                product: UpdateProduct::ElectronDesktop,
                policy: UpdatePolicy::Stable,
                target: request.target.clone(),
            },
        )
        .map_err(|error| error.to_string())?;
        if verified.package.format != package_format()
            || verified.package.url
                != format!(
                    "https://github.com/{REPOSITORY}/releases/download/{}/{}",
                    verified.release_identity, verified.package.file_name
                )
        {
            return Err("signed stable desktop release has an invalid package identity".into());
        }
        return Ok(verified);
    }
    let releases: Vec<GithubRelease> =
        serde_json::from_slice(&transport(RELEASE_API, MAX_RELEASE_BYTES)?)
            .map_err(|error| format!("invalid release response: {error}"))?;
    let descriptor_name = format!("ash-desktop-{}.update.json", request.target);
    let release = releases
        .iter()
        .find(|release| {
            !release.draft
                && !release.prerelease
                && release
                    .assets
                    .iter()
                    .any(|asset| asset.name == descriptor_name)
        })
        .ok_or("no Ash Desktop release is published for this platform")?;
    let descriptor = release
        .assets
        .iter()
        .find(|asset| asset.name == descriptor_name)
        .ok_or_else(|| {
            format!(
                "release {} has no Ash Desktop update for this platform",
                release.tag_name
            )
        })?;
    let expected_descriptor_url = format!(
        "https://github.com/{REPOSITORY}/releases/download/{}/{}",
        release.tag_name, descriptor_name
    );
    if descriptor.browser_download_url != expected_descriptor_url
        || descriptor.size > MAX_MANIFEST_BYTES
    {
        return Err("release descriptor identity is invalid".into());
    }
    let verified = verify_release(
        &transport(&expected_descriptor_url, MAX_MANIFEST_BYTES)?,
        key,
        &ExpectedRelease {
            product: UpdateProduct::ElectronDesktop,
            policy: UpdatePolicy::Latest,
            target: request.target.clone(),
        },
    )
    .map_err(|error| error.to_string())?;
    if verified.release_identity != release.tag_name
        || verified.package.format != package_format()
        || verified.package.url
            != format!(
                "https://github.com/{REPOSITORY}/releases/download/{}/{}",
                release.tag_name, verified.package.file_name
            )
    {
        return Err("signed desktop release does not match the published release".into());
    }
    let artifact = release
        .assets
        .iter()
        .find(|asset| asset.name == verified.package.file_name)
        .ok_or("signed desktop package is missing from the release")?;
    if artifact.size != verified.package.size
        || artifact.browser_download_url != verified.package.url
    {
        return Err("signed desktop package does not match the release asset".into());
    }
    Ok(verified)
}

fn fetch(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    let response = ureq::get(url)
        .set("User-Agent", "Ash-Desktop-Update")
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(15))
        .call()
        .map_err(|error| format!("could not fetch update release: {error}"))?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read update release: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err("update release response is too large".into());
    }
    Ok(bytes)
}

#[cfg(target_os = "windows")]
fn package_format() -> PackageFormat {
    PackageFormat::WindowsExe
}

#[cfg(target_os = "macos")]
fn package_format() -> PackageFormat {
    PackageFormat::Zip
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn package_format() -> PackageFormat {
    PackageFormat::LinuxAppImage
}

#[cfg(all(test, feature = "signing"))]
#[path = "ash-update-host/tests.rs"]
mod tests;
