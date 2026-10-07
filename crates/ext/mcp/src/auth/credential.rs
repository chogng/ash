use ash_secrets::SecretValue;

use super::McpOAuthError;
use super::credential_error;

const OAUTH_CREDENTIAL_MAGIC: &[u8] = b"ash-mcp-oauth-credential-v1\0";
const MAX_CREDENTIAL_PART_BYTES: usize = 1024 * 1024;

pub(crate) fn project_runtime_credential(
    stored: SecretValue,
) -> Result<SecretValue, McpOAuthError> {
    if !stored.expose().starts_with(OAUTH_CREDENTIAL_MAGIC) {
        return Ok(stored);
    }
    oauth_credential_part(stored, OAuthCredentialPart::Runtime)
}

pub(super) fn oauth_lifecycle_credential(
    stored: SecretValue,
) -> Result<SecretValue, McpOAuthError> {
    oauth_credential_part(stored, OAuthCredentialPart::Lifecycle)
}

pub(super) fn encode_oauth_credential(
    runtime_secret: SecretValue,
    lifecycle_secret: SecretValue,
) -> Result<SecretValue, McpOAuthError> {
    if runtime_secret.expose().is_empty()
        || lifecycle_secret.expose().is_empty()
        || runtime_secret.expose().len() > MAX_CREDENTIAL_PART_BYTES
        || lifecycle_secret.expose().len() > MAX_CREDENTIAL_PART_BYTES
    {
        return Err(credential_error());
    }
    let runtime_len =
        u32::try_from(runtime_secret.expose().len()).map_err(|_| credential_error())?;
    let mut encoded = Vec::with_capacity(
        OAUTH_CREDENTIAL_MAGIC.len()
            + std::mem::size_of::<u32>()
            + runtime_secret.expose().len()
            + lifecycle_secret.expose().len(),
    );
    encoded.extend_from_slice(OAUTH_CREDENTIAL_MAGIC);
    encoded.extend_from_slice(&runtime_len.to_be_bytes());
    encoded.extend_from_slice(runtime_secret.expose());
    encoded.extend_from_slice(lifecycle_secret.expose());
    Ok(SecretValue::new(encoded))
}

enum OAuthCredentialPart {
    Runtime,
    Lifecycle,
}

fn oauth_credential_part(
    stored: SecretValue,
    part: OAuthCredentialPart,
) -> Result<SecretValue, McpOAuthError> {
    let bytes = stored.expose();
    let payload = bytes
        .strip_prefix(OAUTH_CREDENTIAL_MAGIC)
        .ok_or_else(credential_error)?;
    let length_bytes: [u8; 4] = payload
        .get(..4)
        .ok_or_else(credential_error)?
        .try_into()
        .map_err(|_| credential_error())?;
    let runtime_len = u32::from_be_bytes(length_bytes) as usize;
    let runtime_end = 4_usize
        .checked_add(runtime_len)
        .ok_or_else(credential_error)?;
    let runtime = payload.get(4..runtime_end).ok_or_else(credential_error)?;
    let lifecycle = payload.get(runtime_end..).ok_or_else(credential_error)?;
    if runtime.is_empty()
        || lifecycle.is_empty()
        || runtime.len() > MAX_CREDENTIAL_PART_BYTES
        || lifecycle.len() > MAX_CREDENTIAL_PART_BYTES
    {
        return Err(credential_error());
    }
    Ok(SecretValue::new(match part {
        OAuthCredentialPart::Runtime => runtime.to_vec(),
        OAuthCredentialPart::Lifecycle => lifecycle.to_vec(),
    }))
}
