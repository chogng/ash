//! Shared signed product-update contract and verification.

use base64::Engine;
use ed25519_dalek::Signature;
#[cfg(feature = "signing")]
use ed25519_dalek::Signer;
#[cfg(feature = "signing")]
use ed25519_dalek::SigningKey;
use ed25519_dalek::VerifyingKey;
use semver::Version;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::error::Error;
use std::fmt;
use std::fs;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Write;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

const SCHEMA_VERSION: u8 = 1;
const MAX_PACKAGE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Automatic update selection shared by product hosts.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePolicy {
    /// Follow every published release for the product.
    Latest,
    /// Follow only releases explicitly promoted by the release system.
    Stable,
    /// Do not check automatically; explicit manual updates remain allowed.
    Never,
}

impl Default for UpdatePolicy {
    fn default() -> Self {
        Self::Latest
    }
}

/// Public product identity bound into a signed release.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateProduct {
    ElectronDesktop,
    RustDesktop,
    AshCode,
}

/// Package serialization selected by a product installation adapter.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PackageFormat {
    TarGz,
    Zip,
    MacOsPackage,
    LinuxAppImage,
    WindowsMsi,
    WindowsExe,
}

/// Ed25519 public key trusted by one installed product generation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UpdatePublicKey([u8; 32]);

impl UpdatePublicKey {
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn from_hex(value: &str) -> Result<Self, UpdateError> {
        decode_hex_32(value, "update public key").map(Self)
    }

    pub const fn as_bytes(self) -> [u8; 32] {
        self.0
    }
}

/// Exact identity a product host expects before trusting a release description.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExpectedRelease {
    pub product: UpdateProduct,
    pub policy: UpdatePolicy,
    pub target: String,
}

/// One signed and validated package selected for a product and target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedRelease {
    pub product: UpdateProduct,
    pub policy: UpdatePolicy,
    pub version: Version,
    pub release_identity: String,
    pub target: String,
    pub package: VerifiedPackage,
}

/// Download metadata trusted only after signature and release validation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedPackage {
    pub url: String,
    pub file_name: String,
    pub format: PackageFormat,
    pub size: u64,
    pub sha256: [u8; 32],
}

/// Downloads one signed package into a new file after checking its exact size and digest.
pub fn stage_verified_package(
    package: &VerifiedPackage,
    directory: &Path,
) -> Result<PathBuf, UpdateError> {
    let response = ureq::get(&package.url)
        .set("User-Agent", "Ash-Product-Update")
        .set("Accept", "application/octet-stream")
        .timeout(Duration::from_secs(900))
        .call()
        .map_err(|error| UpdateError::new(format!("could not download signed update: {error}")))?;
    stage_package_reader(package, directory, response.into_reader())
}

fn stage_package_reader(
    package: &VerifiedPackage,
    directory: &Path,
    mut reader: impl Read,
) -> Result<PathBuf, UpdateError> {
    if package.size == 0 || package.size > MAX_PACKAGE_BYTES {
        return Err(UpdateError::new("signed update package size is unsupported"));
    }
    let name = Path::new(&package.file_name);
    if name.components().count() != 1
        || !matches!(name.components().next(), Some(Component::Normal(_)))
    {
        return Err(UpdateError::new("signed update file name is invalid"));
    }
    fs::create_dir_all(directory)
        .map_err(|error| UpdateError::new(format!("could not create update staging: {error}")))?;
    let destination = directory.join(name);
    if destination.exists() {
        return Err(UpdateError::new("staged update already exists"));
    }
    let temporary = directory.join(format!(".{}.part", package.file_name));
    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| UpdateError::new(format!("could not create update file: {error}")))?;
        let mut digest = Sha256::new();
        let mut size = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = reader
                .read(&mut buffer)
                .map_err(|error| UpdateError::new(format!("could not read update package: {error}")))?;
            if count == 0 {
                break;
            }
            size += count as u64;
            if size > package.size {
                return Err(UpdateError::new("downloaded update exceeds signed size"));
            }
            digest.update(&buffer[..count]);
            output
                .write_all(&buffer[..count])
                .map_err(|error| UpdateError::new(format!("could not stage update package: {error}")))?;
        }
        let actual_digest: [u8; 32] = digest.finalize().into();
        if size != package.size || actual_digest != package.sha256 {
            return Err(UpdateError::new("downloaded update does not match signed size and SHA-256"));
        }
        output
            .sync_all()
            .map_err(|error| UpdateError::new(format!("could not sync update package: {error}")))?;
        fs::rename(&temporary, &destination)
            .map_err(|error| UpdateError::new(format!("could not publish staged update: {error}")))?;
        Ok(destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Serializable release input used by the release signer.
#[cfg(feature = "signing")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleaseInput {
    pub product: UpdateProduct,
    pub policy: UpdatePolicy,
    pub version: Version,
    pub release_identity: String,
    pub target: String,
    pub package: ReleasePackageInput,
}

/// Serializable package input used by the release signer.
#[cfg(feature = "signing")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleasePackageInput {
    pub url: String,
    pub file_name: String,
    pub format: PackageFormat,
    pub size: u64,
    pub sha256: String,
}

#[derive(Deserialize, Serialize)]
struct SignedEnvelope {
    payload: String,
    signature: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleasePayload {
    schema_version: u8,
    product: UpdateProduct,
    channel: UpdatePolicy,
    version: Version,
    release_identity: String,
    target: String,
    package: ReleasePackage,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleasePackage {
    url: String,
    file_name: String,
    format: PackageFormat,
    size: u64,
    sha256: String,
}

/// Verifies an encoded signed release and all identity fields needed by one product host.
pub fn verify_release(
    bytes: &[u8],
    public_key: UpdatePublicKey,
    expected: &ExpectedRelease,
) -> Result<VerifiedRelease, UpdateError> {
    let envelope: SignedEnvelope = serde_json::from_slice(bytes)
        .map_err(|error| UpdateError::new(format!("signed update envelope is invalid: {error}")))?;
    let signature = base64::engine::general_purpose::STANDARD
        .decode(envelope.signature)
        .map_err(|_| UpdateError::new("signed update signature is not valid base64"))?;
    let signature = Signature::try_from(signature.as_slice())
        .map_err(|_| UpdateError::new("signed update signature must contain exactly 64 bytes"))?;
    let key = VerifyingKey::from_bytes(&public_key.0)
        .map_err(|_| UpdateError::new("installed update public key is invalid"))?;
    key.verify_strict(envelope.payload.as_bytes(), &signature)
        .map_err(|_| UpdateError::new("signed update signature verification failed"))?;
    let payload: ReleasePayload = serde_json::from_str(&envelope.payload)
        .map_err(|error| UpdateError::new(format!("signed update payload is invalid: {error}")))?;
    validate_payload(payload, expected)
}

#[cfg(feature = "signing")]
pub fn sign_release(input: ReleaseInput, signing_key: &SigningKey) -> Result<Vec<u8>, UpdateError> {
    let payload = ReleasePayload {
        schema_version: SCHEMA_VERSION,
        product: input.product,
        channel: input.policy,
        version: input.version,
        release_identity: input.release_identity,
        target: input.target,
        package: ReleasePackage {
            url: input.package.url,
            file_name: input.package.file_name,
            format: input.package.format,
            size: input.package.size,
            sha256: input.package.sha256,
        },
    };
    let expected = ExpectedRelease {
        product: payload.product,
        policy: payload.channel,
        target: payload.target.clone(),
    };
    validate_payload(payload_for_validation(&payload)?, &expected)?;
    let payload = serde_json::to_string(&payload)
        .map_err(|error| UpdateError::new(format!("could not encode update payload: {error}")))?;
    let signature = signing_key.sign(payload.as_bytes());
    serde_json::to_vec_pretty(&SignedEnvelope {
        payload,
        signature: base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
    })
    .map_err(|error| UpdateError::new(format!("could not encode signed update: {error}")))
}

#[cfg(feature = "signing")]
fn payload_for_validation(payload: &ReleasePayload) -> Result<ReleasePayload, UpdateError> {
    serde_json::from_value(
        serde_json::to_value(payload).map_err(|error| {
            UpdateError::new(format!("could not encode update payload: {error}"))
        })?,
    )
    .map_err(|error| UpdateError::new(format!("could not decode update payload: {error}")))
}

fn validate_payload(
    payload: ReleasePayload,
    expected: &ExpectedRelease,
) -> Result<VerifiedRelease, UpdateError> {
    if payload.schema_version != SCHEMA_VERSION {
        return Err(UpdateError::new(
            "signed update schema version is unsupported",
        ));
    }
    if payload.product != expected.product
        || payload.channel != expected.policy
        || payload.target != expected.target
    {
        return Err(UpdateError::new(
            "signed update identity does not match this product",
        ));
    }
    if payload.channel == UpdatePolicy::Never {
        return Err(UpdateError::new(
            "the never policy cannot identify a release",
        ));
    }
    if payload.release_identity != format!("v{}", payload.version) {
        return Err(UpdateError::new(
            "release identity must match the semantic version",
        ));
    }
    if payload.package.size == 0 {
        return Err(UpdateError::new(
            "signed update package size must be positive",
        ));
    }
    let path = Path::new(&payload.package.file_name);
    if path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return Err(UpdateError::new(
            "signed update file name must be one normal path component",
        ));
    }
    let url = url::Url::parse(&payload.package.url)
        .map_err(|error| UpdateError::new(format!("signed update URL is invalid: {error}")))?;
    if url.scheme() != "https" || url.username() != "" || url.password().is_some() {
        return Err(UpdateError::new(
            "signed update URL must be credential-free HTTPS",
        ));
    }
    let sha256 = decode_hex_32(&payload.package.sha256, "package SHA-256")?;
    Ok(VerifiedRelease {
        product: payload.product,
        policy: payload.channel,
        version: payload.version,
        release_identity: payload.release_identity,
        target: payload.target,
        package: VerifiedPackage {
            url: payload.package.url,
            file_name: payload.package.file_name,
            format: payload.package.format,
            size: payload.package.size,
            sha256,
        },
    })
}

fn decode_hex_32(value: &str, field: &str) -> Result<[u8; 32], UpdateError> {
    if value.len() != 64 {
        return Err(UpdateError::new(format!(
            "{field} must contain 64 hexadecimal characters"
        )));
    }
    let mut decoded = [0u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let pair = std::str::from_utf8(pair)
            .map_err(|_| UpdateError::new(format!("{field} is not UTF-8")))?;
        decoded[index] = u8::from_str_radix(pair, 16)
            .map_err(|_| UpdateError::new(format!("{field} is not hexadecimal")))?;
    }
    Ok(decoded)
}

/// Validation failure for an untrusted release description.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateError(String);

impl UpdateError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for UpdateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for UpdateError {}

#[cfg(all(test, feature = "signing"))]
#[path = "product_update_tests.rs"]
mod tests;
