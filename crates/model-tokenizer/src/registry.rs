use crate::LocalTokenizerBinding;
use crate::LocalTokenizerError;
use crate::request::render_input;
use ash_protocol::ContentDigest;
use ash_protocol::ModelRef;
use ash_protocol::ModelRequest;
use hf_chat_template::ChatTemplate;
use hf_chat_template::LocalClock;
use hf_chat_template::TokenizerConfig;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::sync::Arc;
use tokenizers::Tokenizer;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalTokenCount {
    tokens: u32,
    source_revision: String,
}

impl LocalTokenCount {
    pub fn new(
        tokens: u32,
        source_revision: impl Into<String>,
    ) -> Result<Self, LocalTokenizerError> {
        let source_revision = source_revision.into();
        if source_revision.trim().is_empty() {
            return Err(LocalTokenizerError::MissingRevision);
        }
        Ok(Self {
            tokens,
            source_revision,
        })
    }

    pub const fn tokens(&self) -> u32 {
        self.tokens
    }

    pub fn source_revision(&self) -> &str {
        &self.source_revision
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalTokenizationOutcome {
    UnsupportedRequest,
    Preparing,
    Unavailable,
    Count(LocalTokenCount),
}

/// Read-only port used by provider adapters to count one canonical request locally.
///
/// Implementations must bind by the complete provider/model identity and return a source revision
/// that changes whenever the tokenizer bytes, template bytes, or their upstream revisions change.
pub trait LocalTokenizerService: Send + Sync {
    fn supports(&self, model: &ModelRef) -> bool;

    /// Counts one fully assembled canonical request without exposing rendering or encoding steps.
    fn count_input_tokens(
        &self,
        model: &ModelRef,
        request: &ModelRequest,
    ) -> Result<LocalTokenizationOutcome, LocalTokenizerError>;

    /// Compatibility alias for callers that have not yet adopted the explicit request-level name.
    fn count(
        &self,
        model: &ModelRef,
        request: &ModelRequest,
    ) -> Result<LocalTokenizationOutcome, LocalTokenizerError> {
        self.count_input_tokens(model, request)
    }
}

#[derive(Default)]
pub struct LocalTokenizerRegistry {
    tokenizers: HashMap<ModelRef, Arc<LoadedTokenizer>>,
}

impl LocalTokenizerRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, binding: LocalTokenizerBinding) -> Result<(), LocalTokenizerError> {
        if self.tokenizers.contains_key(binding.model()) {
            return Err(LocalTokenizerError::DuplicateBinding(model_label(
                binding.model(),
            )));
        }
        let loaded = Arc::new(LoadedTokenizer::load(&binding)?);
        self.tokenizers.insert(binding.model().clone(), loaded);
        Ok(())
    }
}

impl LocalTokenizerService for LocalTokenizerRegistry {
    fn supports(&self, model: &ModelRef) -> bool {
        self.tokenizers.contains_key(model)
    }

    fn count_input_tokens(
        &self,
        model: &ModelRef,
        request: &ModelRequest,
    ) -> Result<LocalTokenizationOutcome, LocalTokenizerError> {
        let Some(tokenizer) = self.tokenizers.get(model) else {
            return Ok(LocalTokenizationOutcome::UnsupportedRequest);
        };
        tokenizer.count(request)
    }
}

pub(crate) struct LoadedTokenizer {
    tokenizer: Tokenizer,
    default_template: Option<ChatTemplate>,
    tool_template: Option<ChatTemplate>,
    globals: serde_json::Map<String, Value>,
    source_revision: String,
}

impl LoadedTokenizer {
    pub(crate) fn load(binding: &LocalTokenizerBinding) -> Result<Self, LocalTokenizerError> {
        let tokenizer_bytes = verified_asset(binding.tokenizer())?;
        let template_source_bytes = verified_asset(binding.template_source())?;
        let tokenizer = Tokenizer::from_bytes(&tokenizer_bytes).map_err(|error| {
            LocalTokenizerError::InvalidTokenizer {
                path: binding.tokenizer().path().to_path_buf(),
                message: error.to_string(),
            }
        })?;
        let template_source = String::from_utf8(template_source_bytes).map_err(|error| {
            LocalTokenizerError::InvalidTemplate {
                path: binding.template_source().path().to_path_buf(),
                message: error.to_string(),
            }
        })?;
        let template_config: TokenizerConfig =
            serde_json::from_str(&template_source).map_err(|error| {
                LocalTokenizerError::InvalidTemplate {
                    path: binding.template_source().path().to_path_buf(),
                    message: error.to_string(),
                }
            })?;
        let default_template = compile_template(&template_config, None);
        let tool_template = compile_template(&template_config, Some("tool_use"));
        let (default_template, tool_template) = match (default_template, tool_template) {
            (Err(default_error), Err(tool_error)) => {
                return Err(LocalTokenizerError::InvalidTemplate {
                    path: binding.template_source().path().to_path_buf(),
                    message: format!(
                        "default template: {default_error}; tool_use template: {tool_error}"
                    ),
                });
            }
            (default_template, tool_template) => (default_template.ok(), tool_template.ok()),
        };
        Ok(Self {
            tokenizer,
            default_template,
            tool_template,
            globals: binding.template_globals().clone(),
            source_revision: source_revision(binding),
        })
    }

    pub(crate) fn count(
        &self,
        request: &ModelRequest,
    ) -> Result<LocalTokenizationOutcome, LocalTokenizerError> {
        let Some(input) = render_input(request, &self.globals) else {
            return Ok(LocalTokenizationOutcome::UnsupportedRequest);
        };
        let template = if request.tools.is_empty() {
            self.default_template.as_ref()
        } else {
            self.tool_template
                .as_ref()
                .or(self.default_template.as_ref())
        };
        let Some(template) = template else {
            return Ok(LocalTokenizationOutcome::UnsupportedRequest);
        };
        let Ok(rendered) = template.render(&input) else {
            return Ok(LocalTokenizationOutcome::UnsupportedRequest);
        };
        let encoding = self
            .tokenizer
            .encode(rendered, false)
            .map_err(|error| LocalTokenizerError::Encode(error.to_string()))?;
        let tokens = u32::try_from(encoding.len())
            .map_err(|_| LocalTokenizerError::Encode("token count exceeds u32".into()))?;
        Ok(LocalTokenizationOutcome::Count(LocalTokenCount::new(
            tokens,
            self.source_revision.clone(),
        )?))
    }
}

fn compile_template(
    config: &TokenizerConfig,
    name: Option<&str>,
) -> Result<ChatTemplate, hf_chat_template::Error> {
    let mut builder = ChatTemplate::builder_from_config(config)?.clock(LocalClock);
    if let Some(name) = name {
        builder = builder.template_name(name);
    }
    builder.build()
}

fn verified_asset(asset: &crate::PinnedTokenizerAsset) -> Result<Vec<u8>, LocalTokenizerError> {
    let bytes = fs::read(asset.path()).map_err(|source| LocalTokenizerError::ReadAsset {
        path: asset.path().to_path_buf(),
        source,
    })?;
    let actual = ContentDigest::sha256(&bytes);
    if &actual != asset.digest() {
        return Err(LocalTokenizerError::DigestMismatch {
            path: asset.path().to_path_buf(),
            expected: asset.digest().clone(),
            actual,
        });
    }
    Ok(bytes)
}

fn source_revision(binding: &LocalTokenizerBinding) -> String {
    let globals = serde_json::to_vec(binding.template_globals())
        .expect("JSON template globals always serialize");
    let globals_digest = ContentDigest::sha256(&globals);
    format!(
        "tokenizer={}@{};template={}@{};globals={}",
        binding.tokenizer().revision(),
        binding.tokenizer().digest(),
        binding.template_source().revision(),
        binding.template_source().digest(),
        globals_digest,
    )
}

fn model_label(model: &ModelRef) -> String {
    format!("{}/{}", model.provider, model.model)
}
