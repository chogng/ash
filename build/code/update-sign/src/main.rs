use base64::Engine;
use ed25519_dalek::SigningKey;
use semver::Version;
use sha2::Digest;
use sha2::Sha256;
use std::env;
use std::fs;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use zeroize::Zeroizing;

const SIGNING_KEY_ENVIRONMENT: &str = "ASH_UPDATE_SIGNING_KEY";

fn main() {
    if let Err(error) = process_hardening::initialize() {
        eprintln!("ash-update-sign: process hardening failed: {error}");
        std::process::exit(1);
    }
    if let Err(error) = run(env::args().skip(1).collect()) {
        eprintln!("ash-update-sign: {error}");
        std::process::exit(1);
    }
}

fn run(arguments: Vec<String>) -> Result<(), String> {
    let encoded_key = Zeroizing::new(
        env::var(SIGNING_KEY_ENVIRONMENT)
            .map_err(|_| format!("{SIGNING_KEY_ENVIRONMENT} is required"))?,
    );
    if arguments.as_slice() == ["public-key"] {
        println!("{}", public_key(&encoded_key)?);
        return Ok(());
    }
    let arguments = Arguments::parse(arguments)?;
    sign_release(arguments, &encoded_key)
}

fn public_key(encoded_key: &str) -> Result<String, String> {
    Ok(decode_signing_key(encoded_key)?
        .verifying_key()
        .to_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn sign_release(arguments: Arguments, encoded_key: &str) -> Result<(), String> {
    let version = Version::parse(&arguments.version)
        .map_err(|error| format!("update version is invalid: {error}"))?;
    if arguments.release_tag != format!("v{version}") {
        return Err("release tag must be v followed by the exact semantic version".into());
    }
    if !matches!(arguments.channel.as_str(), "latest" | "stable") {
        return Err("update channel must be latest or stable".into());
    }
    let signing_key = decode_signing_key(encoded_key)?;
    let expected_public_key = decode_hex_32(&arguments.public_key)?;
    if signing_key.verifying_key().to_bytes() != expected_public_key {
        return Err("the signing key does not match the configured update public key".into());
    }
    let archive_name = arguments
        .archive
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "archive name is not UTF-8".to_owned())?;
    let metadata = arguments
        .archive
        .metadata()
        .map_err(|error| format!("could not inspect update archive: {error}"))?;
    if !metadata.is_file() {
        return Err("update archive is not a regular file".into());
    }
    let product = match arguments.product.as_str() {
        "ash-desktop" => ash_product_update::UpdateProduct::ElectronDesktop,
        "ash-app" => ash_product_update::UpdateProduct::RustDesktop,
        "ash-code" => ash_product_update::UpdateProduct::AshCode,
        _ => return Err("update product must be ash-desktop, ash-app, or ash-code".into()),
    };
    let policy = match arguments.channel.as_str() {
        "latest" => ash_product_update::UpdatePolicy::Latest,
        "stable" => ash_product_update::UpdatePolicy::Stable,
        _ => return Err("update channel must be latest or stable".into()),
    };
    let format = match arguments.format.as_str() {
        "tar-gz" => ash_product_update::PackageFormat::TarGz,
        "zip" => ash_product_update::PackageFormat::Zip,
        "macos-package" => ash_product_update::PackageFormat::MacOsPackage,
        "linux-app-image" => ash_product_update::PackageFormat::LinuxAppImage,
        "windows-msi" => ash_product_update::PackageFormat::WindowsMsi,
        _ => return Err("update package format is unsupported".into()),
    };
    let url = format!(
        "https://github.com/{}/releases/download/{}/{}",
        arguments.repository, arguments.release_tag, archive_name
    );
    let contents = ash_product_update::sign_release(
        ash_product_update::ReleaseInput {
            product,
            policy,
            version,
            release_identity: arguments.release_tag,
            target: arguments.target,
            package: ash_product_update::ReleasePackageInput {
                url,
                file_name: archive_name.into(),
                format,
                size: metadata.len(),
                sha256: file_sha256(&arguments.archive)?,
            },
        },
        &signing_key,
    )
    .map_err(|error| error.to_string())?;
    write_new(&arguments.output, &contents)
}

#[derive(Debug, Eq, PartialEq)]
struct Arguments {
    repository: String,
    product: String,
    channel: String,
    version: String,
    release_tag: String,
    target: String,
    format: String,
    archive: PathBuf,
    output: PathBuf,
    public_key: String,
}

impl Arguments {
    fn parse(arguments: Vec<String>) -> Result<Self, String> {
        let mut repository = None;
        let mut product = None;
        let mut channel = None;
        let mut version = None;
        let mut release_tag = None;
        let mut target = None;
        let mut format = None;
        let mut archive = None;
        let mut output = None;
        let mut public_key = None;
        let mut index = 0;
        while index < arguments.len() {
            let option = arguments[index].as_str();
            index += 1;
            let value = arguments
                .get(index)
                .ok_or_else(|| format!("{option} requires a value"))?;
            match option {
                "--repository" => repository = Some(value.clone()),
                "--product" => product = Some(value.clone()),
                "--channel" => channel = Some(value.clone()),
                "--version" => version = Some(value.clone()),
                "--release-tag" => release_tag = Some(value.clone()),
                "--target" => target = Some(value.clone()),
                "--format" => format = Some(value.clone()),
                "--archive" => archive = Some(PathBuf::from(value)),
                "--output" => output = Some(PathBuf::from(value)),
                "--public-key" => public_key = Some(value.clone()),
                _ => return Err(format!("unknown option: {option}")),
            }
            index += 1;
        }
        Ok(Self {
            repository: required(repository, "--repository")?,
            product: required(product, "--product")?,
            channel: required(channel, "--channel")?,
            version: required(version, "--version")?,
            release_tag: required(release_tag, "--release-tag")?,
            target: required(target, "--target")?,
            format: required(format, "--format")?,
            archive: required(archive, "--archive")?,
            output: required(output, "--output")?,
            public_key: required(public_key, "--public-key")?,
        })
    }
}

fn required<T>(value: Option<T>, option: &str) -> Result<T, String> {
    value.ok_or_else(|| format!("{option} is required"))
}

fn decode_signing_key(value: &str) -> Result<SigningKey, String> {
    let bytes = if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        decode_hex_32(value)?.to_vec()
    } else {
        base64::engine::general_purpose::STANDARD
            .decode(value)
            .map_err(|_| "the update signing key is neither 32-byte hex nor base64".to_owned())?
    };
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "the update signing key must contain exactly 32 bytes".to_owned())?;
    Ok(SigningKey::from_bytes(&bytes))
}

fn decode_hex_32(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64 {
        return Err("the update public key must contain 64 hexadecimal characters".into());
    }
    let mut decoded = [0u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let text = std::str::from_utf8(pair).expect("ASCII hex pairs remain UTF-8");
        decoded[index] = u8::from_str_radix(text, 16)
            .map_err(|_| "the update public key contains a non-hexadecimal character".to_owned())?;
    }
    Ok(decoded)
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("could not open {}: {error}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("could not read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn write_new(path: &Path, contents: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("could not create update output directory: {error}"))?;
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("could not create {}: {error}", path.display()))?;
    std::io::Write::write_all(&mut file, contents)
        .map_err(|error| format!("could not write {}: {error}", path.display()))
}

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;
