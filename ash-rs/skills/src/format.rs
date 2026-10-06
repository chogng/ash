use crate::{SkillDiagnosticCode, SkillName};
use serde::Deserialize;
use std::collections::BTreeMap;

pub(crate) const MAX_FRONTMATTER_BYTES: usize = 16 * 1024;
const MAX_FRONTMATTER_LINES: usize = 256;
const MAX_FRONTMATTER_LINE_BYTES: usize = 2 * 1024;
const MAX_DESCRIPTION_CHARS: usize = 1024;
const MAX_COMPATIBILITY_CHARS: usize = 500;
const MAX_METADATA_ENTRIES: usize = 64;
const MAX_METADATA_KEY_CHARS: usize = 128;
const MAX_METADATA_VALUE_CHARS: usize = 1024;
const MAX_ALLOWED_TOOLS_CHARS: usize = 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct UncheckedFrontmatter {
    name: String,
    description: String,
    license: Option<String>,
    compatibility: Option<String>,
    #[serde(default)]
    metadata: BTreeMap<String, String>,
    allowed_tools: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ParsedFrontmatter {
    pub(crate) description: String,
    pub(crate) license: Option<String>,
    pub(crate) compatibility: Option<String>,
    pub(crate) metadata: BTreeMap<String, String>,
    pub(crate) allowed_tools: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FormatFailure {
    pub(crate) code: SkillDiagnosticCode,
    pub(crate) message: &'static str,
}

pub(crate) fn parse_frontmatter(
    bytes: &[u8],
    expected_name: &SkillName,
) -> Result<ParsedFrontmatter, FormatFailure> {
    let text = std::str::from_utf8(bytes).map_err(|_| invalid_frontmatter())?;
    validate_yaml_resource_shape(text)?;
    let frontmatter: UncheckedFrontmatter =
        serde_yaml::from_str(text).map_err(|_| invalid_frontmatter())?;

    let parsed_name = SkillName::new(frontmatter.name).map_err(|_| FormatFailure {
        code: SkillDiagnosticCode::InvalidSkillName,
        message: "frontmatter name is not a valid Agent Skills name",
    })?;
    if &parsed_name != expected_name {
        return Err(FormatFailure {
            code: SkillDiagnosticCode::InvalidSkillName,
            message: "frontmatter name does not match its parent directory",
        });
    }
    validate_nonempty_bounded(
        &frontmatter.description,
        MAX_DESCRIPTION_CHARS,
        SkillDiagnosticCode::DescriptionInvalid,
        "description must contain 1 to 1024 characters",
    )?;
    if let Some(compatibility) = &frontmatter.compatibility {
        validate_nonempty_bounded(
            compatibility,
            MAX_COMPATIBILITY_CHARS,
            SkillDiagnosticCode::InvalidFrontmatter,
            "compatibility must contain 1 to 500 characters when present",
        )?;
    }
    if frontmatter.metadata.len() > MAX_METADATA_ENTRIES
        || frontmatter.metadata.iter().any(|(key, value)| {
            key.is_empty()
                || key.chars().count() > MAX_METADATA_KEY_CHARS
                || value.chars().count() > MAX_METADATA_VALUE_CHARS
        })
    {
        return Err(FormatFailure {
            code: SkillDiagnosticCode::InvalidFrontmatter,
            message: "metadata exceeds the catalog entry limits",
        });
    }
    if frontmatter
        .allowed_tools
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.chars().count() > MAX_ALLOWED_TOOLS_CHARS)
    {
        return Err(FormatFailure {
            code: SkillDiagnosticCode::InvalidFrontmatter,
            message: "allowed-tools exceeds the catalog entry limits",
        });
    }

    Ok(ParsedFrontmatter {
        description: frontmatter.description,
        license: frontmatter.license,
        compatibility: frontmatter.compatibility,
        metadata: frontmatter.metadata,
        allowed_tools: frontmatter.allowed_tools,
    })
}

fn validate_yaml_resource_shape(text: &str) -> Result<(), FormatFailure> {
    let mut flow_depth = 0_u8;
    let mut block_scalar_parent_indent = None;
    for (line_index, line) in text.lines().enumerate() {
        let indentation = line.bytes().take_while(|byte| *byte == b' ').count();
        if line_index >= MAX_FRONTMATTER_LINES
            || line.len() > MAX_FRONTMATTER_LINE_BYTES
            || line.contains(['\0', '\t'])
            || indentation > 8
        {
            return Err(invalid_frontmatter());
        }
        if let Some(parent_indent) = block_scalar_parent_indent {
            if line.trim().is_empty() || indentation > parent_indent {
                continue;
            }
            block_scalar_parent_indent = None;
        }
        let mut quote = None;
        let mut escaped = false;
        let bytes = line.as_bytes();
        for (index, byte) in bytes.iter().copied().enumerate() {
            if escaped {
                escaped = false;
                continue;
            }
            if quote == Some(b'"') && byte == b'\\' {
                escaped = true;
                continue;
            }
            if matches!(byte, b'\'' | b'"') {
                if quote == Some(byte) {
                    quote = None;
                } else if quote.is_none() {
                    quote = Some(byte);
                }
                continue;
            }
            if quote.is_some() || byte == b'#' {
                if byte == b'#' {
                    break;
                }
                continue;
            }
            match byte {
                b'[' | b'{' => {
                    flow_depth = flow_depth.saturating_add(1);
                    if flow_depth > 8 {
                        return Err(invalid_frontmatter());
                    }
                }
                b']' | b'}' => flow_depth = flow_depth.saturating_sub(1),
                b'&' | b'*' | b'!' if yaml_control_token(bytes, index) => {
                    return Err(invalid_frontmatter());
                }
                b'%' if index == 0 => return Err(invalid_frontmatter()),
                _ => {}
            }
        }
        let value = line
            .split_once(':')
            .map(|(_, value)| value.trim())
            .unwrap_or_default();
        if matches!(value.strip_suffix(['+', '-']).unwrap_or(value), "|" | ">") {
            block_scalar_parent_indent = Some(indentation);
        }
    }
    if flow_depth != 0 {
        return Err(invalid_frontmatter());
    }
    Ok(())
}

fn yaml_control_token(line: &[u8], index: usize) -> bool {
    let previous_allows_token = index == 0
        || line[index - 1].is_ascii_whitespace()
        || matches!(line[index - 1], b'[' | b'{' | b',');
    let next_starts_name = line
        .get(index + 1)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
    previous_allows_token && next_starts_name
}

fn validate_nonempty_bounded(
    value: &str,
    maximum: usize,
    code: SkillDiagnosticCode,
    message: &'static str,
) -> Result<(), FormatFailure> {
    if value.trim().is_empty() || value.chars().count() > maximum {
        return Err(FormatFailure { code, message });
    }
    Ok(())
}

fn invalid_frontmatter() -> FormatFailure {
    FormatFailure {
        code: SkillDiagnosticCode::InvalidFrontmatter,
        message: "SKILL.md frontmatter is malformed or exceeds parser limits",
    }
}

#[cfg(test)]
#[path = "format_tests.rs"]
mod tests;
