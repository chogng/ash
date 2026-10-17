use base64::Engine;

/// Encodes a trusted script independently of the Windows SSH default shell and code page.
/// User values must be passed as quoted data inside the script before calling this function.
pub fn powershell_command(script: &str) -> String {
    let bytes = script
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}")
}

/// Quotes one literal PowerShell string; interpolation and subexpressions remain data.
pub fn quote_powershell_argument(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
