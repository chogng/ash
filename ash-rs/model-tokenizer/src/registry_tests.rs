use super::*;
use ash_protocol::ContentDigest;
use ash_protocol::ContentPart;
use ash_protocol::ImageDetail;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ModelRequest;
use ash_protocol::ProviderId;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolName;
use std::fs;
use tempfile::TempDir;
use tokenizers::Tokenizer;
use tokenizers::models::wordlevel::WordLevel;
use tokenizers::pre_tokenizers::whitespace::WhitespaceSplit;

#[test]
fn registered_assets_render_the_template_and_count_the_result() {
    let fixture = Fixture::new();
    let mut registry = LocalTokenizerRegistry::new();
    registry
        .register(fixture.binding("deepseek", "deepseek-chat"))
        .unwrap();

    let model = model_ref("deepseek", "deepseek-chat");
    assert!(registry.supports(&model));
    let LocalTokenizationOutcome::Count(count) = registry
        .count(&model, &ModelRequest::text("hello"))
        .unwrap()
    else {
        panic!("text requests should be supported");
    };

    assert_eq!(count.tokens(), 3);
    assert!(
        count
            .source_revision()
            .contains("tokenizer=fixture-revision@sha256:")
    );
    assert!(
        count
            .source_revision()
            .contains("template=fixture-revision@sha256:")
    );
}

#[test]
fn registry_binds_assets_to_the_complete_model_reference() {
    let fixture = Fixture::new();
    let mut registry = LocalTokenizerRegistry::new();
    registry
        .register(fixture.binding("huggingface", "org/model"))
        .unwrap();

    assert!(registry.supports(&model_ref("huggingface", "org/model")));
    assert!(!registry.supports(&model_ref("deepseek", "org/model")));
    assert!(!registry.supports(&model_ref("huggingface", "org/other")));
}

#[test]
fn registry_rejects_asset_bytes_that_do_not_match_the_pin() {
    let fixture = Fixture::new();
    let mut binding = fixture.binding("deepseek", "deepseek-chat");
    binding = LocalTokenizerBinding::new(
        binding.model().clone(),
        PinnedTokenizerAsset::new(
            fixture.tokenizer_path.clone(),
            "fixture-revision",
            ContentDigest::sha256(b"different tokenizer"),
        )
        .unwrap(),
        binding.template_source().clone(),
    );

    let error = LocalTokenizerRegistry::new().register(binding).unwrap_err();
    assert!(matches!(error, LocalTokenizerError::DigestMismatch { .. }));
}

#[test]
fn image_requests_are_explicitly_unsupported_without_a_multimodal_processor() {
    let fixture = Fixture::new();
    let mut registry = LocalTokenizerRegistry::new();
    let model = model_ref("huggingface", "org/model");
    registry
        .register(fixture.binding("huggingface", "org/model"))
        .unwrap();
    let mut request = ModelRequest::text("hello");
    let ash_protocol::InputItem::Message(message) = &mut request.input[0] else {
        unreachable!();
    };
    message.content.push(ContentPart::ImageUrl {
        url: "https://example.test/image.png".into(),
        detail: ImageDetail::Auto,
    });

    assert_eq!(
        registry.count(&model, &request).unwrap(),
        LocalTokenizationOutcome::UnsupportedRequest
    );
}

#[test]
fn a_template_runtime_rejection_falls_back_instead_of_breaking_invocation() {
    let fixture = Fixture::new();
    fs::write(
        &fixture.template_path,
        serde_json::to_vec(&serde_json::json!({
            "chat_template": "{{ raise_exception('unsupported message shape') }}"
        }))
        .unwrap(),
    )
    .unwrap();
    let mut registry = LocalTokenizerRegistry::new();
    let model = model_ref("huggingface", "org/model");
    registry
        .register(fixture.binding("huggingface", "org/model"))
        .unwrap();

    assert_eq!(
        registry
            .count(&model, &ModelRequest::text("hello"))
            .unwrap(),
        LocalTokenizationOutcome::UnsupportedRequest
    );
}

#[test]
fn tool_requests_select_the_named_tool_use_template() {
    let fixture = Fixture::new();
    fs::write(
        &fixture.template_path,
        serde_json::to_vec(&serde_json::json!({
            "chat_template": [
                {
                    "name": "default",
                    "template": "{% for message in messages %}{{ message.role }} {{ message.content }} {% endfor %}{% if add_generation_prompt %}assistant{% endif %}"
                },
                {"name": "tool_use", "template": "tool tool"}
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    let model = model_ref("huggingface", "org/model");
    let mut registry = LocalTokenizerRegistry::new();
    registry
        .register(fixture.binding("huggingface", "org/model"))
        .unwrap();

    let mut request = ModelRequest::text("hello");
    request.tools.push(ToolDefinition {
        name: ToolName::new("weather").unwrap(),
        description: "Get weather".into(),
        parameters: serde_json::json!({"type": "object"}),
        strict: true,
    });
    let LocalTokenizationOutcome::Count(count) = registry.count(&model, &request).unwrap() else {
        panic!("tool requests should use the tool_use template");
    };

    assert_eq!(count.tokens(), 2);
}

struct Fixture {
    _directory: TempDir,
    tokenizer_path: std::path::PathBuf,
    template_path: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let tokenizer_path = directory.path().join("tokenizer.json");
        let template_path = directory.path().join("tokenizer_config.json");
        let vocab = [
            ("<unk>".to_string(), 0),
            ("user".to_string(), 1),
            ("hello".to_string(), 2),
            ("assistant".to_string(), 3),
            ("tool".to_string(), 4),
        ]
        .into_iter()
        .collect();
        let model = WordLevel::builder()
            .vocab(vocab)
            .unk_token("<unk>".into())
            .build()
            .unwrap();
        let mut tokenizer = Tokenizer::new(model);
        tokenizer.with_pre_tokenizer(Some(WhitespaceSplit));
        tokenizer.save(&tokenizer_path, false).unwrap();
        fs::write(
            &template_path,
            serde_json::to_vec(&serde_json::json!({
                "chat_template": "{% for message in messages %}{{ message.role }} {{ message.content }} {% endfor %}{% if add_generation_prompt %}assistant{% endif %}"
            }))
            .unwrap(),
        )
        .unwrap();
        Self {
            _directory: directory,
            tokenizer_path,
            template_path,
        }
    }

    fn binding(&self, provider: &str, model: &str) -> LocalTokenizerBinding {
        LocalTokenizerBinding::new(
            model_ref(provider, model),
            pinned(&self.tokenizer_path),
            pinned(&self.template_path),
        )
    }
}

fn pinned(path: &std::path::Path) -> PinnedTokenizerAsset {
    let bytes = fs::read(path).unwrap();
    PinnedTokenizerAsset::new(path, "fixture-revision", ContentDigest::sha256(&bytes)).unwrap()
}

fn model_ref(provider: &str, model: &str) -> ModelRef {
    ModelRef::new(
        ProviderId::new(provider).unwrap(),
        ModelId::new(model).unwrap(),
    )
}
