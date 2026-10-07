use std::path::PathBuf;

use ash_lsp::LanguageServerClient;
use ash_lsp::lsp_types::Position;
use ash_lsp::lsp_types::SemanticToken;
use ash_lsp::lsp_types::SemanticTokensOptions;
use ash_lsp::lsp_types::SemanticTokensRegistrationOptions;
use ash_lsp::lsp_types::SemanticTokensResult;
use ash_lsp::lsp_types::SemanticTokensServerCapabilities;

use crate::LanguageDocumentRevision;
use crate::LanguageRequestId;
use crate::LanguageTextRange;
use crate::projection::byte_range_for_lsp_range;

const MAX_SEMANTIC_TOKENS: usize = 200_000;
const MAX_RESULT_ID_BYTES: usize = 1024;

/// One validated semantic token projected into the authoritative UTF-8 snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageSemanticToken {
    pub range: LanguageTextRange,
    pub token_type: String,
    pub modifiers: Vec<String>,
}

/// Fresh full-document semantic tokens tied to one document revision and server result identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageSemanticTokens {
    pub request_id: LanguageRequestId,
    pub path: PathBuf,
    pub revision: LanguageDocumentRevision,
    pub result_id: Option<String>,
    pub tokens: Vec<LanguageSemanticToken>,
}

pub(crate) fn semantic_tokens_options(
    client: &LanguageServerClient,
) -> Option<SemanticTokensOptions> {
    if let Some(capability) = &client
        .initialization()
        .capabilities
        .semantic_tokens_provider
    {
        return Some(match capability {
            SemanticTokensServerCapabilities::SemanticTokensOptions(options) => options.clone(),
            SemanticTokensServerCapabilities::SemanticTokensRegistrationOptions(options) => {
                options.semantic_tokens_options.clone()
            }
        });
    }
    client
        .dynamic_capabilities()
        .registrations
        .into_iter()
        .filter(|registration| registration.method == "textDocument/semanticTokens")
        .find_map(|registration| {
            serde_json::from_value::<SemanticTokensRegistrationOptions>(
                registration.register_options?,
            )
            .ok()
            .map(|options| options.semantic_tokens_options)
        })
}

pub(crate) fn project_semantic_tokens(
    request_id: LanguageRequestId,
    path: PathBuf,
    revision: LanguageDocumentRevision,
    text: &str,
    encoding: &ash_lsp::lsp_types::PositionEncodingKind,
    options: &SemanticTokensOptions,
    response: Option<SemanticTokensResult>,
) -> Result<LanguageSemanticTokens, String> {
    let (result_id, data) = match response {
        None => (None, Vec::new()),
        Some(SemanticTokensResult::Tokens(tokens)) => (tokens.result_id, tokens.data),
        Some(SemanticTokensResult::Partial(tokens)) => (None, tokens.data),
    };
    if data.len() > MAX_SEMANTIC_TOKENS {
        return Err(format!(
            "semantic token response exceeds {MAX_SEMANTIC_TOKENS} tokens"
        ));
    }
    if result_id.as_ref().is_some_and(|result_id| {
        result_id.is_empty() || result_id.len() > MAX_RESULT_ID_BYTES || result_id.contains('\0')
    }) {
        return Err("semantic token result ID is invalid".into());
    }
    let mut line = 0u32;
    let mut start = 0u32;
    let mut previous_end = 0usize;
    let mut projected = Vec::with_capacity(data.len());
    for token in data {
        let (token_line, token_start) = relative_position(line, start, token)?;
        let end = token_start
            .checked_add(token.length)
            .ok_or_else(|| "semantic token range overflowed".to_owned())?;
        let range = byte_range_for_lsp_range(
            text,
            Position::new(token_line, token_start),
            Position::new(token_line, end),
            encoding,
        )
        .ok_or_else(|| "semantic token range is outside the document snapshot".to_owned())?;
        if range.start < previous_end || range.is_empty() {
            return Err("semantic tokens must be sorted, non-overlapping, and non-empty".into());
        }
        let token_type = options
            .legend
            .token_types
            .get(token.token_type as usize)
            .ok_or_else(|| "semantic token type is outside the negotiated legend".to_owned())?
            .as_str()
            .to_owned();
        let modifiers = semantic_modifiers(token.token_modifiers_bitset, options)?;
        previous_end = range.end;
        projected.push(LanguageSemanticToken {
            range: LanguageTextRange::new(range),
            token_type,
            modifiers,
        });
        line = token_line;
        start = token_start;
    }
    Ok(LanguageSemanticTokens {
        request_id,
        path,
        revision,
        result_id,
        tokens: projected,
    })
}

fn relative_position(
    previous_line: u32,
    previous_start: u32,
    token: SemanticToken,
) -> Result<(u32, u32), String> {
    let line = previous_line
        .checked_add(token.delta_line)
        .ok_or_else(|| "semantic token line overflowed".to_owned())?;
    let start = if token.delta_line == 0 {
        previous_start
            .checked_add(token.delta_start)
            .ok_or_else(|| "semantic token column overflowed".to_owned())?
    } else {
        token.delta_start
    };
    Ok((line, start))
}

fn semantic_modifiers(bitset: u32, options: &SemanticTokensOptions) -> Result<Vec<String>, String> {
    if options.legend.token_modifiers.len() < u32::BITS as usize
        && bitset >> options.legend.token_modifiers.len() != 0
    {
        return Err("semantic token modifiers are outside the negotiated legend".into());
    }
    Ok(options
        .legend
        .token_modifiers
        .iter()
        .take(u32::BITS as usize)
        .enumerate()
        .filter(|(index, _)| bitset & (1u32 << index) != 0)
        .map(|(_, modifier)| modifier.as_str().to_owned())
        .collect())
}

#[cfg(test)]
#[path = "semantic_tokens_tests.rs"]
mod tests;
